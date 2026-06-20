---
title: Cross-platform per-user service install behind a ServiceManager seam
date: 2026-06-20
category: architecture-patterns
module: src/daemon
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Adding a second OS target to install/reload/uninstall logic that was written for one platform"
  - "The new platform's supervisor (systemd, launchd, Windows service) cannot run in unit tests"
  - "A CLI branches on process.platform and the branch is starting to spread"
tags: [service-manager, systemd, launchd, cross-platform, dependency-injection, seam]
---

# Cross-platform per-user service install behind a ServiceManager seam

## Context
HIP's daemon install/reload/uninstall/doctor logic was written only for macOS launchd
(`buildPlist`/`plistPath` plus inline `launchctl` helpers in `src/cli/lifecycle.ts`). The
dogfood topology moved the daemon onto a headless Linux box, which needs a `systemctl
--user` unit. Forking the CLI per platform, or letting `process.platform` checks spread
through `lifecycle.ts`, would have duplicated the fragile rollback/verify logic. Real
systemd also can't run in CI, so the Linux path needed a test strategy.

## Guidance
Put one `ServiceManager` interface between the CLI and the OS supervisor; select the
implementation once, by `process.platform`. The interface is the decision; method names
are illustrative:

```ts
export interface ServiceManager {
  readonly name: string;          // "launchd" | "systemd-user" — for operator messaging
  unitPath(): string;
  buildUnit(opts: UnitOptions): string;
  writeUnit(text: string): string[];     // write + activate; returns report lines
  remove(): string;
  isLoaded(): boolean;
  reload(): boolean;                     // false when no service is loaded
  readUnitHost(): string | null;         // doctor introspection
  readUnitNodePath(): string | null;
  extraChecks(): DoctorIssue[];          // manager-specific doctor checks (e.g. systemd linger)
}

export function selectServiceManager(platform = process.platform): ServiceManager {
  if (platform === "linux") return new SystemdManager();
  return new LaunchdManager();
}
```

Three moves made it work:

1. **Refactor first, no behavior change.** Move the existing launchd logic *verbatim*
   behind the interface (U1) before writing the second impl (U2). Pin the move with a
   **characterization test** that asserts byte-identical unit output and the same spawn
   sequence — so the refactor cannot silently change the working platform.

2. **Inject the spawner for the un-testable platform.** `SystemdManager` takes a
   `Spawner` (`(cmd, args) => { status, stdout }`) defaulting to a timeout-guarded
   `spawnSync`. Tests pass a recorder that captures the exact `systemctl`/`loginctl`
   argv and returns canned `is-active`/`Linger=` output, so command sequences and unit
   text are asserted without real systemd:

   ```ts
   const rec = recorder();                       // logs every (cmd, ...args)
   const mgr = new SystemdManager(rec.run);
   mgr.writeUnit(mgr.buildUnit(OPTS));
   expect(rec.calls.map((c) => c.join(" "))).toEqual([
     "loginctl enable-linger ash",
     "systemctl --user daemon-reload",
     "systemctl --user enable --now hip.service",
   ]);
   ```

3. **Carry platform-specific doctor checks on the interface**, not as a `process.platform`
   branch in the CLI. `extraChecks()` returns `[]` for launchd and a linger warning for
   systemd; the CLI just calls `mgr.extraChecks()` and merges the issues.

## Why This Matters
- The CLI keeps **one** `process.platform` branch (`selectServiceManager`) instead of N
  scattered checks; rollback/verify logic in `rebind` is written once and works on both.
- The characterization test means the macOS path — the author's own daily-use surface —
  cannot regress while the Linux path is added.
- The injected spawner makes an otherwise-untestable integration (real systemd) assertable
  in CI: the *contract* (which commands, in what order, parsing what output) is tested even
  though the side effect isn't. Live validation is deferred to the real box, not skipped
  silently.

## When to Apply
- A second OS target lands on install/service-management code that branches on platform.
- The new platform's supervisor or external tool can't run in unit tests — inject a
  command runner and assert the argv + parsed output instead of mocking the whole world.
- Platform-specific health/doctor checks would otherwise add `if (platform === …)` to
  shared code — give the seam a `extraChecks()`-style hook.

## Examples
Before — the only platform branch lived inline and launchctl helpers were free functions
in `lifecycle.ts`; a Linux path would have meant a second branch at every call site
(install, rebind, uninstall, doctor).

After — `src/daemon/service-manager.ts` (interface + selector), `src/daemon/launchd.ts`
(`LaunchdManager`), `src/daemon/systemd.ts` (`SystemdManager` with injected `Spawner` +
linger). `src/cli/lifecycle.ts` routes everything through `selectServiceManager()` and
never re-checks the platform. Tests: `test/service-manager.test.ts` (characterization),
`test/systemd.test.ts` (recorder-driven argv assertions).

## Related
- `docs/binding.md` § Topology — co-location vs remote binding (the topology this unblocked)
- `src/daemon/service-manager.ts`, `src/daemon/systemd.ts`, `src/daemon/launchd.ts`
