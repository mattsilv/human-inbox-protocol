import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Store } from "../store/index.js";
import { Domain } from "../domain/index.js";
import { buildMcpServer, type ToolDeps } from "../tools/index.js";
import { checkBearer } from "./auth.js";
import { hostPort } from "./host.js";

export interface DaemonOptions {
  store: Store;
  token: string;
  host?: string;
  port?: number;
  /** Extra tool registrars (e.g. reconcile from U6, nudge admin from U8). */
  extraTools?: ((server: McpServer, deps: ToolDeps) => void)[];
}

export const DEFAULT_PORT = 4319;
export const DEFAULT_HOST = "127.0.0.1";

export class HipDaemon {
  private server?: Server;
  private boundPort?: number;
  readonly store: Store;
  readonly domain: Domain;
  readonly host: string;
  readonly port: number;
  private readonly token: string;
  private readonly extraTools: ((server: McpServer, deps: ToolDeps) => void)[];

  constructor(opts: DaemonOptions) {
    this.store = opts.store;
    this.domain = new Domain(opts.store);
    this.token = opts.token;
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.extraTools = opts.extraTools ?? [];
  }

  /** Actual listening port (resolves an ephemeral port-0 after start). */
  get listenPort(): number {
    return this.boundPort ?? this.port;
  }

  get url(): string {
    return `http://${hostPort(this.host, this.listenPort)}/mcp`;
  }

  // The configured `host` is added to both allowlists so a non-loopback bind (e.g. a
  // Tailscale IP, HIP_HOST) accepts its own Host/Origin — without it DNS-rebinding
  // protection 403s every remote call. Loopback stays allowed for local clients.
  // `hostPort` brackets bare IPv6 literals so they match the `[v6]:port` Host header.
  private get allowedHosts(): string[] {
    const p = this.listenPort;
    return [...new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, hostPort(this.host, p)])];
  }

  private get allowedOrigins(): string[] {
    const p = this.listenPort;
    return [
      ...new Set([
        `http://127.0.0.1:${p}`,
        `http://localhost:${p}`,
        `http://[::1]:${p}`,
        `http://${hostPort(this.host, p)}`,
      ]),
    ];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", reject);
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.boundPort = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (!url.startsWith("/mcp")) return send(res, 404, { error: "not found" });

    // No server-initiated channel: only POST is a HIP semantic path. GET/DELETE
    // (SSE streams, session teardown) are structurally refused — the RC-seam guard.
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    if (!checkBearer(req, this.token)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return send(res, 401, { error: "unauthorized" });
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "invalid JSON body" });
    }

    // Fresh server + stateless transport per request (no session state).
    const mcp = buildMcpServer({ store: this.store, domain: this.domain }, this.extraTools);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
      allowedOrigins: this.allowedOrigins,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy(); // stop buffering — don't let an oversized body grow unbounded
        reject(new Error("body too large"));
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
