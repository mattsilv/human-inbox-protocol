---
title: DNS-rebinding allowlist must track the bind host (changing HIP_HOST is not config-only)
date: 2026-06-13
category: docs/solutions/integration-issues
module: daemon (HTTP server / MCP transport)
problem_type: integration_issue
component: authentication
symptoms:
  - "Remote MCP client gets HTTP 403 on every call after binding the daemon to a non-loopback host"
  - "Plan assumed 'set HIP_HOST and reload' with no code change; remote calls silently fail"
  - "An IPv6 HIP_HOST produces a malformed url authority (http://fd7a:...:4319/mcp)"
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [dns-rebinding, mcp, streamable-http, bind-host, tailscale, ipv6, allowlist, hip-host]
---

# DNS-rebinding allowlist must track the bind host (changing HIP_HOST is not config-only)

## Problem
The HIP daemon's StreamableHTTP transport has DNS-rebinding protection: it validates the
request `Host`/`Origin` against an allowlist. That allowlist was hardcoded to loopback
only. Binding the daemon beyond loopback (`HIP_HOST=<tailscale-ip>`, to let an off-box
agent connect) made every remote call fail `403` — the bind succeeded, but the remote
`Host` header was never in the allowlist. The planning doc had asserted "Tailscale
binding needs no code," which was wrong.

## Symptoms
- Remote MCP client receives `403` on every request after `HIP_HOST` is set to a non-loopback address.
- Local loopback clients keep working, so the daemon looks healthy — the failure is remote-only.
- A bare IPv6 `HIP_HOST` also yields a malformed url authority (`http://fd7a:…:4319/mcp` instead of `http://[fd7a:…]:4319/mcp`).

## What Didn't Work
- **Treating the bind host as pure config.** Setting `HIP_HOST` and reloading the LaunchAgent binds the socket correctly but does nothing for the DNS-rebinding allowlist, which is a separate, independently-hardcoded list. The two have to be kept in sync.

## Solution
Derive the allowlist from the configured bind host instead of hardcoding loopback, and
bracket bare IPv6 literals so they match the `[v6]:port` `Host` header and form a valid
URL authority.

```ts
// src/daemon/server.ts
private get allowedHosts(): string[] {
  const p = this.listenPort;
  return [...new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, hostPort(this.host, p)])];
}
private get allowedOrigins(): string[] {
  const p = this.listenPort;
  return [...new Set([
    `http://127.0.0.1:${p}`, `http://localhost:${p}`, `http://[::1]:${p}`,
    `http://${hostPort(this.host, p)}`,
  ])];
}
get url(): string {
  return `http://${hostPort(this.host, this.listenPort)}/mcp`;
}

// `host:port`, bracketing a bare IPv6 literal so it matches the `[v6]:port` Host header.
function hostPort(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}
```

Loopback entries stay (local clients still connect by `127.0.0.1`); the configured host
is added and deduped. Connect by the exact value `HIP_HOST` was set to — a MagicDNS name
only works if `HIP_HOST` is that name, because the `Host` header must match an allowlisted
entry.

## Why This Works
DNS-rebinding protection compares the inbound `Host`/`Origin` header against a fixed
allowlist; it does not consult the socket's bind address. So the allowlist is a second
source of truth that must be derived from the same `host` the socket binds to, or the two
drift and every remote request is rejected. The IPv6 bracketing matters because clients
send (and URLs require) the `[addr]:port` form for IPv6 authorities, while the raw config
value is unbracketed.

## Prevention
- **When a daemon has DNS-rebinding protection (or any Host/Origin allowlist), treat the bind host and the allowlist as one unit.** Changing where it listens is never config-only — the allowlist has to track the bind host in the same change.
- **Security note:** binding beyond `127.0.0.1` removes loopback as the network gate, so the bearer token becomes the only thing between the network and the store. Pair with network ACLs (e.g. Tailscale ACLs on the port), keep the token `0600`, never bind `0.0.0.0`.
- **Test the IPv6 authority directly** (no server start needed): assert `new HipDaemon({host:"fd7a:1:2::3", port:4319}).url === "http://[fd7a:1:2::3]:4319/mcp"` and that an IPv4 host passes through unchanged.
- **Distrust "no code needed" claims in a plan for anything crossing a network/security boundary** — verify the allowlist/guard actually admits the new path before documenting it as working.

## Related Issues
- PR #3 (`feat/hip-gap-tags`) — Tailscale binding docs + this fix.
- `docs/binding.md` — "Remote agents (Tailscale binding)" section documents `HIP_HOST` + the bearer-token security implication.
</content>
