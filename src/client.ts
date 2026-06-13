import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HIP_VERSION } from "./index.js";

export interface HipClientOptions {
  url: string; // e.g. http://127.0.0.1:4319/mcp
  token: string;
}

export interface ToolCallResult {
  structuredContent: Record<string, unknown> | undefined;
  isError: boolean;
  text: string;
}

/**
 * The one thin MCP client wrapper, shared by the CLI and the U10 smoke script (KTD:
 * SDK isolation, both sides). Domain types are plain JSON; callers read
 * `structuredContent` — the canonical tool result — and never touch the SDK directly.
 */
export class HipClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(opts: HipClientOptions) {
    this.client = new Client({ name: "hip-client", version: HIP_VERSION });
    this.transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      requestInit: { headers: { authorization: `Bearer ${opts.token}` } },
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  async listTools(): Promise<string[]> {
    const res = await this.client.listTools();
    return res.tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    const res = (await this.client.callTool({ name, arguments: args })) as {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return {
      structuredContent: res.structuredContent,
      isError: res.isError ?? false,
      text,
    };
  }

  /** Convenience: call a tool and return its structuredContent, throwing on tool error. */
  async callOk(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await this.call(name, args);
    if (r.isError) {
      const err = (r.structuredContent?.error as { code?: string; message?: string }) ?? {};
      throw new Error(`tool ${name} failed [${err.code ?? "error"}]: ${err.message ?? r.text}`);
    }
    return r.structuredContent ?? {};
  }
}
