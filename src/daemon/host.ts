/**
 * The single source of truth for turning a bind host into a URL authority. The plist
 * `HIP_HOST`, the `config.json` url, the daemon's DNS-rebinding allowlist, and the Host
 * header a client sends must all agree byte-for-byte; routing every one of them through
 * `hostPort` is what guarantees that.
 */

/**
 * Canonicalize a host for byte-stable storage and comparison: lowercase (covers the
 * common hand-edited-IPv6 typo and hostname case) and strip any surrounding brackets so
 * callers get the bare host. Full IPv6 compress/expand/zone-id normalization is
 * deliberately out of scope — add it only if the doctor host-mismatch check shows real
 * false-positives in practice.
 */
export function canonicalHost(host: string): string {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.toLowerCase();
}

/**
 * `host:port`, canonicalizing then bracketing a bare IPv6 literal (e.g. `fd7a:…` →
 * `[fd7a:…]`) so it matches the `[v6]:port` form a client sends in the Host header and
 * forms a valid URL authority. An already-bracketed IPv6 (`[::1]`) is unwrapped by
 * `canonicalHost` and re-bracketed to the same form; IPv4/hostnames get only lowercasing.
 */
export function hostPort(host: string, port: number): string {
  const c = canonicalHost(host);
  const h = c.includes(":") && !c.startsWith("[") ? `[${c}]` : c;
  return `${h}:${port}`;
}

/** Whether a bind host is loopback (the default network gate). */
export function isLoopbackHost(host: string): boolean {
  const c = canonicalHost(host);
  return c === "127.0.0.1" || c === "localhost" || c === "::1";
}

/**
 * Whether a bind host means "all interfaces" — never safe to bind (the token becomes the
 * sole gate on every NIC). Covers the empty string (Node binds `""` to all interfaces) and
 * the common IPv4/IPv6 wildcard spellings. Full IPv6 normalization is deferred (see
 * canonicalHost), so exotic spellings are a documented residual.
 */
const ALL_INTERFACES = new Set(["", "0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "::ffff:0:0"]);
export function isAllInterfaces(host: string): boolean {
  return ALL_INTERFACES.has(canonicalHost(host));
}
