import { describe, expect, it } from "vitest";
import { hostPort, canonicalHost, isLoopbackHost, isAllInterfaces } from "../src/daemon/host.js";

describe("host authority helper (U2)", () => {
  it("formats IPv4 and hostnames as host:port", () => {
    expect(hostPort("127.0.0.1", 4319)).toBe("127.0.0.1:4319");
    expect(hostPort("daemon.tailnet.ts.net", 4319)).toBe("daemon.tailnet.ts.net:4319");
  });

  it("brackets a bare IPv6 literal and leaves an already-bracketed one single-bracketed", () => {
    expect(hostPort("fd7a:1:2::3", 4319)).toBe("[fd7a:1:2::3]:4319");
    expect(hostPort("[fd7a:1:2::3]", 4319)).toBe("[fd7a:1:2::3]:4319");
    expect(hostPort("::1", 4319)).toBe("[::1]:4319");
  });

  it("lowercases for byte-stable agreement (common hand-edited IPv6 typo)", () => {
    expect(hostPort("FD7A:1:2::3", 4319)).toBe("[fd7a:1:2::3]:4319");
    expect(canonicalHost("LocalHost")).toBe("localhost");
    expect(canonicalHost("[FD7A::3]")).toBe("fd7a::3");
  });

  it("classifies loopback and all-interfaces hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("100.64.0.1")).toBe(false);
    expect(isAllInterfaces("0.0.0.0")).toBe(true);
    expect(isAllInterfaces("::")).toBe(true);
    expect(isAllInterfaces("127.0.0.1")).toBe(false);
  });
});
