# Windows extension containers

Status: proposed design, 2026-11-01; no runtime change. Product scope follows [the vision](../vision/README.md). The owner selected MXC for Windows extensions on capable hosts and the pinned `@anthropic-ai/sandbox-runtime` 0.0.80 backend elsewhere. This does not adopt 0.0.81. Recommendations and release requirements below describe future work, not measured Windows guarantees.

## Evidence and boundaries

Ave references [A1]–[A22] identify the inspected `origin/main` commit `874882e51a1d76185ca81e9675ae05286b4078c3`. Line ranges refer to that revision; dependency/runtime measurements below are local observations, with the reproducible command recorded. `T:<path>:<lines>` identifies a file **inside** the published [1.0.1 npm tarball][T], not a file installed in Ave. Its SHA-512 base64 is `2cP925G5+lQyKzjBVha8uNtVd7XESgDBtgi1yCYYSo9M3xiFyZWtCO4SWPGTk509rdI6nqjyGcZxvEP3t6l8Hg==`. Upstream source URLs use the release commit `fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2`. This design branch starts at origin/main independently of the launcher bump; implementation depends on landing that bump first. [A10] [T]

The earlier migration analysis is available through `git show origin/deps/sandbox-runtime-0.0.81:docs/design/windows-srt-0.0.81-grant-migration.md`. Its cited upstream ordinary-grant refusal checks persistent user roots, including unrelated roots. That migration is superseded by the owner's backend choice, not implemented here. Keep fallback grants and their current cleanup semantics on 0.0.80. [U1] [A5]

## 1. Current holder inventory

Every Windows extension grant reaches `grantWindowsWorkerFilesystemAccess`: it admits and pins reads/writes, adds writes to reads, enforces machine/private-helper boundaries, incorporates live grants, and hands off overlapping deny obligations before the ordinary ACL grant. Read/write denies come from trusted base settings plus earlier wraps and the pending policy. Missing writable deny targets are materialized and stamped; overlapping deny globs refuse a grant. Native verification failure seals the session. Callers do not supply independent deny lists to the holder helper. [A5] [A6]

| Holder and actual call sites | Read / write grant shape today | Deny shape, transport, lifetime |
| --- | --- | --- |
| Delegated worker: `src/permissions/worker-spawn.ts:184–303`; `src/boot/steps/plugin-runtime/host-api-factory.ts:1015–1030`; `src/plugins/isolation/host-api-dispatcher.ts:693–752` | R = throwaway home + `spec.allowReadPaths`; W = home + `spec.allowWritePaths`. Dispatcher bounds requests to the calling child's captured envelope and promotes Windows descendants to enclosing envelope roots. | Shared sensitive R/W floor is restated by the deny-only confined spawn. Windows retains TCP control (`socketPath: null`); stdin is host liveness, stdout/stderr are events/diagnostics. Host-owned helper PID holds ACLs for the **worker process lifetime**, not one tool turn. Lost holder terminates worker. [A1] [A2] [A6] |
| Confined plugin child: `src/plugins/isolation/out-of-process-plugin.ts:285–330,527–599` | Base R = generation root, data, socket directory, worker-run root. Base W = data + socket directory. Reviewed host-directory grants add R only; approved user-chosen directories may add R/W. Final holder receives outermost R/W roots + home. Host-only sibling `storage/` and other plugin roots cannot be covered by a write grant. | Same deny-only floor and shared account; authenticated loopback JSON-RPC replaces stdin/stdout under confinement. The socket/run-directory registrations are needed for the Unix-domain-socket paths on other platforms; they do not establish Windows socket reach. Snapshot lasts one plugin incarnation; release on exit/close, terminate on holder loss. [A3] [A4] [A6] |
| MCP stdio: `src/mcp/mcp-client.ts:1852–1883` → `spawnWindowsBundledProcess` | W = optional `sandboxRoot` + optional plugin data + helper-added fresh home. R = W + bundled payload + home + runtime reads. Configured `cwd` is **not** automatically granted. | Sensitive R/W floor via deny-only spawn. Relay streams carry protocol; lifetime is the server connection/process, release after definitive exit/close. A restart is a new incarnation. [A7] [A8] |
| Plugin script hook: `src/hooks/script-hook-runner.ts:252–278` | Caller R = generation root; W = plugin data. Bundled helper adds home, W-as-R, runtime reads. Cwd = generation root. | Sensitive R/W floor; JSON input through relay stdin, output/status through relay. One hook process/invocation; cancellation and completion own teardown. [A8] [A9] |
| User script hook: same hook branch | Caller R = canonical admitted script anchor(s); W = admitted cwd. Helper adds home, W-as-R, runtime reads. No whole user-home grant. | Same floor/relay and process lifetime. Authorization precedes launch; no grant based only on script-provided paths. [A8] [A9] |
| `wrap-bundled-command` Windows child: `src/sandbox/wrap-bundled-command.ts:118–205` | R = unique(home, caller W, caller R, `hostRuntimeReads(command)`); W = unique(home, caller W). Runtime reads cover the host runtime/entry needed by the relay. | Shared implementation for MCP/hooks, **not another authority principal**. Own holder/home, loss callback, fail cleanup. Relay receives intended environment and cwd; caller owns ASRT cleanup after process death. [A8] |

**Per-turn envelope versus process grant:** the inspected Windows worker API accepts one filesystem spec at spawn; it has no live grant-update method. HostApi checks its effect against the current recipient and captured plugin envelope, but its ACL remains live across turns, and every confined process sharing the account can reach another holder's currently granted roots. Do not describe the current OS grants as turn-scoped isolation. A consumer wanting a narrower per-turn worker envelope needs a new incarnation; implementation must inventory such consumers against the public contract, not invent an SDK policy-update API. This is a conflict with an interpretation of “per-turn envelopes” as existing native revocation, rather than a reason to widen future grants. [A1] [A2] [A11] [A12]

The persistent conversation PTY and host shells are outside this extension inventory. Their separate shell setting and launch path remain intact. No new plugin-specific branch belongs in the host; the common process boundary carries these holders. [A10] [A13]

## 2. Proposed common spawn contract

Use one host-owned immutable launch plan per holder incarnation, selected after existing permission admission: owner identity, backend, session/generation, canonical R/W/deny objects, executable/arguments, cwd, stripped environment, transport and egress lease. Revalidate admission, root identities and the owner incarnation immediately before spawn. Backend choice is sealed with that plan. Preserve the shared filesystem admission and private-storage exclusions; a conversion error refuses that launch. These requirements carry the existing admission boundaries into the fixed spawn request. [A2] [A3] [A5]

For MXC, use `spawn` from `@microsoft/mxc-sdk/v1` with this **typed** shape, not the raw CLI JSON fields:

```ts
{
  command: quotedExecutableAndArgs,
  containment: { type: "processcontainer" },
  workingDirectory: admittedCwd,
  environment: strippedEnvironment,
  inheritDefaultEnvironment: false,
  filesystem: {
    readwritePaths: ranked.write,
    readonlyPaths: ranked.read,
    deniedPaths: ranked.deny,
    clearPolicyOnExit: true,
  },
  network: {
    egress: { default: "deny" },
    ingress: { default: "allow", hostLoopback: "allow" },
    runtimeConfig: { networkProxy: invocationProxyUrl },
  },
  ui: { disable: true, clipboard: "none", allowInputInjection: false },
}
```

This example shows the current identity-less listener baseline for mapping purposes. It is **not the recommended release posture**: D2 option 1 changes `hostLoopback` to `"deny"` and sets `containment.config.network.allowedProxyPeer` to the verified proxy identity. Naming a peer alone is not proof of invocation-port isolation; that remains an acceptance test. [U2] [U3]

The shape is defined by `T:dist/v1/types.d.ts:191–212,375–386,409–455`; the SDK selects wire contract `1.0.0` (`T:dist/v1/contract-version.js:4`). Do not put `version`, `process.env`, `process.cwd` or top-level `runtimeConfig` on this public request. `LifecycleConfig` defines `destroyOnExit: true` and `preservePolicy: false` defaults (`T:dist/v1/types.d.ts:40–45`), but **ContainerRequest does not expose a lifecycle field**. The adapter explicitly emits `destroyOnExit: true` and `preservePolicy: !clearPolicyOnExit` (`T:dist/v1/container.js:146–164`). Use `clearPolicyOnExit: true` and verify actual teardown; do not bypass the public API to set invented fields. [T]

Environment construction retains safe Windows runtime variables including `SYSTEMROOT` and `LOCALAPPDATA`, fresh HOME and principal temp, and required host-runtime mode. Strip secrets and caller proxy overrides, then apply only host-owned invocation proxy/CA settings. Disable default inheritance; a missing required variable fails preparation. Use Windows command-line quoting, never string interpolation of plugin arguments into a shell. `workingDirectory` must be within admitted R/W roots: worker/plugin defaults use their own admitted home/data, hooks use the existing admitted cwd, and MCP honors its configured cwd only if already reachable. Do not add cwd to the write set for compatibility. [A7] [A8] [A14] [A22]

The proxy keeps the existing owner policy: worker/plugin allowlists, MCP/user-hook model endpoints where no plugin owns them, and explicit offline holders with no inherited network permission. A proxy URL is not an allowed destination list. Bind each listener to its host-issued owner and lifetime and retain DLP-masked deny audit. [A20]

Filesystem conversion reuses `rankMxcFilesystem` after shared admission: allowed writes, allowed reads, sensitive read floor, write-deny downgrades and missing-path denies. A write deny cannot simply become a total deny when the corresponding read is admitted. A missing protected descendant must stay uncreatable, raising to the first missing ancestor only inside that holder's writable root. Add the plugin-root isolation floor and re-allow only this holder's roots. Preserve reviewed floor pierces and host-only storage exclusion. Never use the old session's aggregate live ACL grants as MXC's allow list. Fixed policy means newly appearing paths and changed deny obligations require revalidation and replacement. [A3] [A5] [A14]

### Mapping by holder

All rows use the network/environment/lifecycle rules above; these are proposed mappings of the source scopes, not proof of native compatibility. [A1] [A3] [A7] [A8] [A9] [T]

| Holder | Filesystem and cwd | Stdio / IPC | Policy lifetime and change |
| --- | --- | --- | --- |
| Delegated worker | Its admitted spec R/W, private home/temp and executable/runtime R. Preserve envelope ceiling; no future-turn union. Cwd defaults to admitted home unless the contract explicitly admits another root. | Native stdin retains liveness. stdout/stderr preserve current events. Existing arbitrary worker TCP HTTP control cannot magically become JSON-RPC over stdin; use the bridge described below. | Worker incarnation, capped by the admitted turn lease when its authority is turn-scoped. On changed read/write/deny set, cancel outstanding work, stop and await death, then respawn; no effect replay. |
| Plugin child | Its captured generation/data/socket/run and declared roots; home/temp. Generation read-only, storage unavailable. Cwd = admitted plugin root. | Existing framed plugin protocol directly over SDK `standardInput`/`standardOutput`; stderr diagnostics. No transport loopback is needed for the plugin-child protocol itself. | Plugin incarnation; configuration/envelope withdrawal stops it before replacement. No in-place broadening. |
| MCP stdio | Existing server sandbox/data W, payload/runtime R, private home/temp. Do not widen for configured cwd. | Native pipes carry MCP framing, attached before waiting. Retain server EOF, backpressure, exit and reconnect behavior. | Server lifetime; policy change disconnects current requests and restarts server after termination. No automatic request replay. |
| Script hooks | Plugin generation or admitted user-script R; data or already-authorized cwd W; runtime R, private home/temp. | JSON input and bounded stdout/stderr directly over native streams, with existing encoding and exit semantics. | One hook invocation. Snapshot policy at spawn; revocation cancels it. Never rerun a partially executed hook automatically. |
| Bundled helper | Exactly its caller's plan plus fresh home/temp and runtime R; never grants an independent superset. | Common MXC handle/stream adapter replaces srt-only ChildProcess assumptions. | Owns handle and resource release; MCP/hook callers retain principal and authorization. |

**Strict policy choice: respawn.** Do not pre-authorize the union of all roots a holder might use in later turns. It retains authority after a folder/turn grant ends and makes cancellation unable to revoke that access. A hash of the admitted canonical plan determines whether reuse is possible; every turn lease ends authority even if its path hash matches the next turn. Stop admission first, cancel, terminate the old container, then publish the replacement. If termination cannot be established, refuse replacement and keep the old lease quarantined; never claim revocation or switch its backend. Long-lived plugin/server roots remain incarnation-scoped; only explicitly turn-bound worker authority ends with the turn. This is a proposed stricter lifetime rule, not the current account-wide ACL behavior. [A1] [A2] [A3] [A11]; `T:dist/v1/container-process.d.ts:31–38,85–95` [T]

### Transport feasibility and holder ownership

The plugin child's framed stream protocol already exists off the current Windows relay path. Adapt the transport interface to SDK Readable/Writable streams; retain framing limits, sender binding, subscriptions, HostApi gates and handshake. Never treat a native PID as proof of recipient authority. MCP/hooks naturally fit these streams. Acquire **all three streams before calling `wait()`**: otherwise SDK wait closes untaken stdin and drains untaken output, and later output access throws. [A4] [A7] [A9]; `T:dist/v1/container-process.d.ts:31–38,68–95` [T]

Delegated workers are different: their public handle returns `socketPath: null` for TCP, and stdin is a liveness pipe rather than a command channel. Recommended design: a generic host-runtime bridge **inside the same container** starts the worker and forwards its local TCP control byte stream over a separately framed host stream, while preserving the worker's stdin liveness and stdout/stderr events. The host presents the existing HTTP client a transport adapter; a plugin must not choose a host port to bypass policy. This bridge needs protocol versioning, bounded frames/backpressure, an authenticated host-selected endpoint and destination ownership checks. It is new implementation work, not an existing SDK feature. Prove same-container loopback and worker compatibility natively before selecting this path; do not replace it with an arbitrary host-loopback exception. See D1. [A1] [A2] [A12] [U2]

The host retains a strong `MxcProcess` reference while its holder is admitted; there is no default SDK execution deadline. Map hooks and tool ceilings to `TOOL_TIMEOUT_POLICY` and abort cancellation, and let admitted long-lived servers/workers run until release. On stop/revocation/reset/shutdown: remove authority markers, end input, call `kill()`, await terminal settlement while draining output, then `dispose()` in final cleanup. Handle both a synchronous `dispose()` error and rejection of the wait promise after disposal; surface cleanup failure. `dispose()` initiates asynchronous cleanup, so returning from it alone is not proof of death; use successful `wait()` for an ordinary stop and a native lifecycle observation for abnormal disposal. Keep home/temp and egress leases until termination is established. Do not manufacture a `ChildProcess` cast: adapt consumers to a common owned-process contract with streams, completion, termination and cleanup. [A1] [A8] [A16]; `T:dist/v1/types.d.ts:442–455`, `T:dist/v1/container-process.js:63–75,150–190` [T]

Authority removal immediately blocks new HostApi effects, worker sends and publication of the old marker. Report teardown as pending until native terminal completion and output draining establish death; only then release listener/home and permit replacement. Failed or timed-out kill leaves that holder non-ready, with cleanup still owned by the shutdown manager. A caller timeout alone does not establish death. [A1] [A8]

Host death must kill the container and all descendants, including a worker ignoring EOF. SDK handle ownership is a mechanism to verify, not a host-crash result measured here. Native tests must kill the owning process and independently observe child/grandchild death. [A19]; `T:dist/v1/container-process.d.ts:31–35` [T]

## 3. SDK JS, launcher, packaging and integrity

Measured in this checkout on macOS with the locked Electron **45.2.1**:

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron -e 'console.log(process.versions.node)'
# 24.22.1
```

This meets the Windows native-stdio requirement `>=24.21.0 <25 || >=26.8.0` (`T:README.md:15–18`, `T:dist/bindings/native-stdio.js:10–19`). The measurement removes the Node-version reason for skipping SDK JS; it does not test a Windows native handle transfer. The lock resolves the application runtime, while package.json declares a range. Native Windows packaging must repeat the measurement on the executable actually shipped. [A15] [T]

Choose SDK JS for persistent extension processes: `spawn()` returns live native streams plus `wait`, `kill`, `dispose`, and native lifecycle ownership. Retain `wxc-exec` for the current shell route and boot probe. A long-lived CLI subprocess would require another stdio/liveness supervisor and would not itself provide the SDK's owned process abstraction. Do not migrate shells as incidental work. `T:dist/v1/container.d.ts:20–25`, `T:dist/v1/container-process.d.ts:31–95` [T]; [A10]

Packaging requirements:

- Add exact `@microsoft/mxc-sdk` 1.0.1 to production `dependencies` and update bun.lock. Its runtime dependencies are `koffi`, `node-pty`, and `semver` (`T:package.json:61–65`); inventory resolved transitive binaries and licenses. Do not assume the launcher-only resource rule packages the SDK. [A15] [T]
- SDK loads `bin/<arch>/mxc_ffi.dll` through `koffi`, whose own `.node` addon also needs unpacking. Explicitly package the SDK JS and unpack its selected DLL/native payload plus the resolved FFI addon under `app.asar.unpacked`; preserve their directory relationship. Existing node-pty unpack rules remain. Do not ship unused backend binaries by default: determine dependent DLLs with a real packaged load, not a filename guess. `T:dist/native-library.js:8,18–29,48–80` [T]; [A15]
- The SDK's loader also searches source-build locations and honors `MXC_FFI_DIR`. Production must scrub that override, verify the resolved path remains the installed unpacked package tree, and refuse a hash mismatch **before import/load**. Existing main bundling must externalize the SDK if package-relative resolution is required; validate the emitted bundle and packaged lookup. Never let a developer build DLL become a silent production fallback. `T:dist/native-library.js:48–80` [T]; [A15]
- Keep the tarball SHA-512, MIT license SHA-256, and per-architecture launcher SHA-256 pins shared with fetch/boot/packaging. Expand the same integrity manifest to the SDK JS payload, selected `mxc_ffi.dll`, FFI addon and transitive runtime artifacts. Record locked resolutions and per-arch byte hashes; an npm lock integrity check alone is not an installed-byte check. Verify staged and installed payloads, including app.asar.unpacked; retain the administrator-writable installation assumption and developer-checkout limitation. [A10] [A15]; `T:dist/native-library.js:77–80` [T]
- Include SDK MIT text under license notices plus resolved FFI/pty/transitive notices, update `THIRD-PARTY-NOTICES.md` and `resources/licenses/mxc/` from the resolved dependency inventory, and verify actual installer contents. The measured launcher license SHA-256 is `d9a1b1e30d633d5732ea18e3cba9538d293ebc53e1a9e4e96ab739e0c5c4f1cb`, unchanged from the existing pin; that does not prove all new dependencies are covered. [A10] [A15]; `T:LICENSE.md:1–21`, `T:package.json:61–65` [T]

## 4. Host selection and readiness

Current `windows-sandbox-plan.ts` makes MXC a candidate only for requested shells, assigns extensions `srt-win | none`, and keeps process-wide confinement false for proxy-only startup. The shared substrate type does not yet admit MXC extensions. Extend the planner and shared validators/producers/consumers together; do not merely mark ASRT globally active. [A13] [A17]

Readiness is a conjunction, not a version/build predicate: verified installed SDK/DLL/addon; BaseContainer probe; dry-run of the exact holder request; actual SDK spawn under the intended runtime with UI disabled and admitted cwd/env; stdin/stdout/stderr round-trip and clean termination; and the chosen D2 listener-isolation probe. Probe deadline comes from a centralized `TOOL_TIMEOUT_POLICY` entry. On deadline, reject queued starts or choose the already-ready 0.0.80 route before any holder is admitted. Never leave a queued operation waiting indefinitely or silently execute it unconfined. Initial degraded-host behavior applies only after a settled no-backend plan. D1-dependent workers additionally require the bridge capability proof. [A10] [A13] [A21]

Proposed planner, evaluated independently of `osToolSandbox` when `pluginWorkerConfinement` is requested:

| Host state | Extension selection and report |
| --- | --- |
| Setting off | No extension confinement; unchanged opt-in behavior. |
| MXC checking | Queue extension starts until the dedicated SDK/native-runtime + actual extension request probe settles; readiness says checking. Do not admit a temporary unconfined holder. |
| Actual SDK/container/transport probe succeeds | New holders use MXC even if srt-win is absent. ASRT can start proxy-only for their invocation listeners. Report MXC and its proven dimensions per holder. |
| MXC host capability unavailable, srt-win ready | New holders use pinned 0.0.80 fallback and existing shared-account disclosure. No 0.0.81 initialization. |
| Both unavailable | Preserve existing Windows degraded-start behavior and warning, report extensions unconfined; grant no sandbox-based permission relaxation. |
| Selected MXC holder fails to spawn or loses its handle | Fail that operation/stop holder. Do not retry under srt-win or unconfined. A later independently admitted holder can use a newly evaluated host plan only after explicit session reinitialization. |

These are design requirements replacing the current planner outputs, with the existing Windows degraded-host policy retained. “Never mix within one holder” covers children, hooks and delegated descendants: the holder's container tree cannot contain an independently srt-wrapped child or host-spawned escape. A selected MXC parent whose required transport cannot run fails admission. Global ASRT state must not make the persistent PTY or unrelated tools appear MXC-confined. [A10] [A13] [A17]

Settings/Doctor should distinguish requested, checking, selected and active; backend version and unavailable reason; fallback shared-account filesystem reach; and network identity strength actually established by the probe. Update `SandboxWindowsSubstrateInfo.extensions`, extension egress identity, readiness diagnostics, plugin/MCP capability markers, localized messages, fixtures and serialized validators in one contract change. A marker is published only after native spawn and transport setup succeed and is removed at authority revocation. Each actual tool/effect still enters the permission pipeline. [A4] [A7] [A13] [A17]

## 5. Guarantee deltas and mitigations

This table compares the proposed MXC path with today's 0.0.80 extension path. Fallback retains today's guarantees and limits. “Strengthened” is a release requirement until native proof exists, not a completed validation result. [A5] [A11] [U2]

| Property | Delta | Mitigation / proof required |
| --- | --- | --- |
| Host policy admission, deny precedence, forced asks and recipient identity | Kept | Same admission/effect pipeline and captured recipient; backend provides evidence, never an approval. [A2] [A5] [A16] |
| Cross-holder filesystem grants | Strengthened | Container-local R/W plan replaces shared account's live ACL union. Test concurrent holders cannot read/write one another's roots, including legacy fallback roots. [A5] [A11]; `T:dist/v1/types.d.ts:409–417` [T] |
| Filesystem deny projection | Kept, representation changes | Preserve read-versus-write denies, missing paths, private storage, approved root and reparse identity checks; reject unrepresentable policy. Test opaque native syscalls, not only host API refusals. [A3] [A5] [A14] |
| Per-turn revocation | Strengthened for turn-bound workers; restart interrupts state | No union and no live mutation; stop and respawn. Surface cancellation/restart, no effect replay; prove old descendants are dead. [A1] [A12]; `T:dist/v1/container-process.d.ts:85–95` [T] |
| Process lifetime / orphan descendants | Strengthened target | Native lifecycle handle replaces holder ACL plus EOF alone. Independently observe timeout, host crash and grandchild death. [A1] [A11]; `T:dist/v1/container-process.d.ts:31–35` [T] |
| Native stdin/environment/status | Strengthened mechanism | Native streams replace Windows relay limitations; test large binary output, EOF, signal/exit and slow consumers. Attach streams before wait. [A4] [A8]; `T:dist/v1/container-process.d.ts:31–38,68–95` [T] |
| Network egress attribution | Conditional strengthening, **not yet established** | One invocation listener per holder, kernel/channel binding and cross-listener isolation tests. The identity-less route does not promise a proxy-only host-loopback exception; tokens remain labels, not kernel identity. D2 is a release decision. [A11] [A14] [U2] [U3] |
| Inbound/private network and DNS | Residual exposure; do not claim stronger isolation | Proxy mode requires ingress allow and identity-less host loopback allow; host Firewall/endpoint authentication remain necessary. DNS uses host resolver. Test unrelated host listeners and private-network servers; do not report network confinement from proxy env alone. [A10] [U2] [U3] |
| GUI/clipboard/input | Strengthened target, compatibility risk | Extensions start with UI disabled, clipboard none, injection false. A runtime requiring UI fails closed; any exception needs an explicit policy decision, not inheritance from shell's UI exception. [A14]; `T:dist/v1/types.d.ts:419–427` [T] |
| Availability/start latency | Weakened while checking or after policy changes | Dedicated readiness probe, bounded cancellation and clear restart diagnostics. Preserve 0.0.80 only at host selection; never downgrade an admitted holder after failure. [A13] |
| Installed native code supply chain | Weakened by larger payload | Pin and verify SDK JS/DLL/addon/transitives; audit unpacked paths and notices; packaged native smoke on both architectures. [A10] [A15]; `T:dist/native-library.js:48–80` [T] |

There is a material **documentation/code conflict** to resolve before extension shipping: Ave's shell request/capability prose describes outbound traffic as restricted to its listener, while the pinned 1.0.1 networking specification explicitly says identity-less host loopback opens both directions and does not enforce a proxy-only exception. This design does not silently change the shell gate or claim the mismatch is fixed. Use native bypass tests plus D2; do not copy the stronger shell claim into extension capability reporting. [A10] [A13] [A14] [U2] [U3]

## 6. Permission decision tree

The order in [permission-decision-tree.md](../architecture/permission-decision-tree.md) stays unchanged: admission/hooks/deny → forced-question targets → ask/allow rules and remembered grants → tool kind and sandbox evidence → mode/human/reviewer. Plugin effects still pass independently for the actual effect; headless asks deny. No decision node or approval scope is replaced by MXC. The evidence consumed at the sandbox/capability node changes from shared-account confinement to a specific proven holder; if evidence is absent, no read relaxation or sandbox-auto is granted. [A16] [A17]

No new folder permission or remembered grant is requested merely to create a container or restart with an already-admitted envelope. Expansion still asks under existing rules, and forced questions remain one-time. A restart reports interrupted work and requires a fresh action to repeat effects; it never treats a previous completed approval as permission to replay. A backend unavailable warning/readiness indicator changes, not the card ordering. D2 may require a security disclosure; it cannot authorize past deny rules or silently switch modes. [A2] [A16]

## 7. Owner decision points

**D1 — delegated worker control transport.** Options: (1) generic in-container TCP-to-framed-stream bridge preserving existing worker behavior (**recommended**, pending real-container prototype); (2) version the worker contract to require native stdio control, explicitly excluding current TCP-only workers until migrated; (3) allow direct host-loopback TCP control, adding a network exception and reachability requirement. Recommend 1 to retain compatibility without adding a host listener exception. If its feasibility test fails, return to the owner; do not silently select 3. Plugin-child and MCP stdio transport do not depend on this choice. [A1] [A4] [A12] [U2]

**D2 — identity-less loopback security posture.** Options: (1) provide an identity-scoped proxy peer and gate release on native peer/listener-isolation proof (**recommended**); (2) retain identity-less loopback with an explicit disclosure that arbitrary host-loopback isolation is not guaranteed and with reduced capability claims; (3) block MXC extension availability on hosts where the stronger route cannot be established and select 0.0.80 before holder admission. Recommend 1 as the security target, with 3 for unsupported hosts; this may require a separately packaged proxy identity and adds work. Selecting 2 changes the disclosed security posture and needs the owner's explicit decision. Do not use a successful HTTP proxy request as evidence for exclusive egress. [U2] [U3] [A11]

Respawn over union is already selected by this design's strict policy requirement. It is not another permission-card decision. There are no proposed settings defaults changes. [A13] [A16]

## 8. Delivery slices, native validation and rollback

Implementation slices below are estimates/plans, not completed work. Packaging and backend-independent adapter work may proceed after implementation authorization; production selection and worker activation depend on D2 and D1 respectively. This design-only task authorizes none of those implementation changes:

| PR slice | Files / boundaries | Acceptance and estimated effort |
| --- | --- | --- |
| Launcher refresh prerequisite | `src/permissions/mxc-launcher-pins.json`, `mxc-windows.ts`, architecture section | Hash archive/license/both launchers; schema/CLI diff; targeted tests/typecheck. Separate dependency branch, no SDK runtime adoption. 0.5 day. [A10] |
| Owned native process and packaged SDK | `package.json`, `bun.lock`, pins/fetch, new `src/permissions/mxc-extension-process.ts`, `scripts/build-main-esbuild.mjs`, `scripts/{fetch-mxc.mjs,electron-before-pack.cjs,electron-after-pack.cjs,smoke-packaged-app.mjs}`, `THIRD-PARTY-NOTICES.md`, `resources/licenses/mxc/` | Real Windows SDK stdio import/spawn, exact shipped Node check, both architecture payload manifests, tamper/override refusal, app.asar.unpacked smoke. 2–3 days. [A8] [A15] [T] |
| Backend plan and per-holder policy | `windows-sandbox-plan.ts`, sandbox init/capability/shared types, `confined-child.ts`, filesystem conversion, egress invocation/listener path, Settings messages | Worker-only and shell-only requests, checking/ready/unavailable matrix, no mixed holder, no new approval order, per-holder native policy and proxy proof. D2 identity proxy prototype first. 2–4 days excluding separate identity packaging. [A5] [A13] [A14] [A17] |
| Plugin child and delegated workers | `worker-spawn.ts`, `out-of-process-plugin.ts`, `host-api-{dispatcher,child,wire}.ts`, child runtime/transport adapter, managed process tracking | D1 bridge prototype; per-turn lease stop/respawn, unchanged effect guards, stream framing/backpressure. If HostApi changes, update protocol/schema/generated clients and all released public contract copies together. 3–5 days. [A1] [A2] [A3] [A4] [A12] |
| MCP/hooks/bundled helper and native gates | `mcp-client.ts`, `script-hook-runner.ts`, `wrap-bundled-command.ts`, their tests; `.github/workflows/ci.yml`; architecture/permission capability documentation | Real native holders and packaged crash/cleanup cases below; 0.0.80 fallback regressions; non-Windows targeted suites. 2–3 days plus 2–4 native validation days. [A7] [A8] [A9] [A16] |

Total estimate: **9–15 implementation days plus 2–4 native validation days** after prerequisites, assuming D1 bridge feasibility, both architecture build targets and D2 option 1, with its identity-package effort counted separately below. An identity-bearing proxy package for D2 is an additional **3–6 days plus signing/deployment lead time**; size it after the prototype. These are engineering estimates, not upstream claims. No work estimate authorizes implementation or publishing.

### Real hosted Windows runner requirements

Extend **Windows permission path tests**, whose existing workflow stages the verified x64 launcher, provisions the fallback, and runs MXC/native permission regressions. Host capability determines whether the test can execute; a skip is not success evidence. Require an explicit real-container cohort with BaseContainer support, or keep the migration unverified until such a hosted Windows runner is available. Record OS build, MXC pins, SDK/native DLL hashes, shipped runtime version, backend/probe outcome, actual spawn ID and test outcomes. Current macOS mock results do not satisfy these requirements. [A18]

Required real-container tests, with independent host observations (not just generated request snapshots):

1. **Native SDK and lifetime:** packaged runtime imports the unpacked DLL/addon; spawn an echo process with binary stdin/stdout/stderr and backpressure; EOF, nonzero exit, wait-before-stream misuse, cancellation, timeout, dispose during start, host kill and grandchild kill. Observe marker PIDs independently after cleanup; catch wait rejection without leaked listeners or homes. Repeat x64 and arm64; the current x64 runner is not arm64 evidence. `T:dist/v1/container-process.d.ts:31–95` [T]; [A18]
2. **Filesystem holders:** real worker, plugin child, MCP and both hook kinds each write only their admitted roots and read their runtime/payload. A second simultaneous holder cannot reach the first's roots or host-only storage. Test R versus W denies, absent deny targets and parents, opaque writes to protected controls, home/temp isolation, junction/symlink/hardlink attempts and root replacement during admission/launch. Include an unsandboxed positive control on fixture data to show the probe actually attempted the access. Extend `mxc-link-traversal.integration`, `sandbox-control-writes-mxc.integration`, `mxc-windows-missing-denies`, confined-plugin-child, worker-spawn, MCP/hook and filesystem-boundary suites. [A1] [A3] [A5] [A14] [A18]
3. **Turn changes:** A has root X, then B has Y. B cannot access X, and A/descendants cannot survive the handoff. Tightening a deny stops the old holder. A failed stop prevents replacement; cancellation/restart never replays an effect. Check host-visible files and process state, not only the plan hash. [A1] [A2] [A12]
4. **Transport:** plugin handshake/JSON-RPC HostApi requests and subscriptions over native streams; reject forged identity and oversized frames. Real existing TCP worker through D1 bridge including disconnects and slow clients; no arbitrary destination forwarding. MCP initialize/call/cancel/reconnect, hook JSON/stdout/status, Unicode paths/env and cwd outside policy rejection. [A2] [A4] [A7] [A8] [A9]
5. **Network:** two simultaneous holders and distinct listeners; allowed/denied HTTP and CONNECT, proxy credential forgery, another invocation's listener, unrelated host listeners, private IPs and raw sockets. Record actual accepts/refusals at independently owned servers and audit attribution. Test both PSEC 1.0 and 1.1 host cohorts where available; do not infer either from OS build alone. Include GUI-disabled runtime startup. Acceptance for the recommended D2 path: own-listener allowed requests succeed; denied destinations, raw direct destinations, other-holder listeners and unrelated host listeners receive no connection, and every proxy denial is attributed to the actual holder despite forged labels. Inbound/private exposure and DNS residuals are reported separately. Identity-less operation is diagnostic-only until the owner chooses D2 option 2, whose reduced claims must be asserted in readiness tests. Failure to establish the promised peer restriction blocks the strong claim and invokes D2, not a hidden allow. [A10] [A11] [U2] [U3]
6. **Selection/fallback/package:** worker-only request with shell sandbox off, MXC-only host without srt-win, 0.0.80-only host, both ready, neither ready, pending probe, corrupted launcher/DLL/addon, native-load failure and unavailable IPC. Verify selected-holder failure cannot downgrade; verify fallback still uses 0.0.80 ordinary grants/release and its shared-account disclosure. Install actual packaged artifacts and inspect selected DLL/addon/notices, then repeat native spawn; a source-tree import alone is insufficient. On a hosted arm64 runner, require the same real SDK spawn and policy cases; if none is available, report arm64 unverified and block its extension activation rather than extrapolating x64 results. [A8] [A13] [A15] [A17] [A18]

The existing launcher regression set remains required: `mxc-policy-pipe`, `mxc-windows-transport`, `mxc-shell-launch`, `mxc-link-traversal.integration`, `mxc-pipe-lifetime.integration`, missing-deny and protected-control-write tests. It proves the launcher bump's request transport, real start, traversal protection and process delivery lifetime; it does not prove new SDK extension behavior. Run relevant macOS/Linux holder tests to preserve their existing path. [A18]

### Rollback

Before release, retain a tested 0.0.80 fallback installation and separate integrity manifests for the old/new payloads. To roll back: close admission, stop all MXC holders and independently verify their descendants are gone, release their listener/policy/home resources, then restart Ave with the previous release or a new boot plan selecting 0.0.80. Never change a live holder's substrate, never run both backends for its descendants, and never remove another session's ACL roots or helper state. If cleanup cannot be verified, report the holder non-ready and require session shutdown; do not claim rollback complete. The SDK default policy cleanup is not an installed-ACL cleanup guarantee for the fallback. [A5] [A8] [A13]; `T:dist/v1/types.d.ts:40–45`, `T:dist/v1/container-process.js:164–190` [T]

## Primary source index

[T]: https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-1.0.1.tgz "Published SDK 1.0.1 tarball; T references use package-relative file and line numbers"
[U1]: https://github.com/anthropics/sandbox-runtime/blob/c40cf14a65d025e3cd27f071f13a73c12b3b1f92/vendor/srt-win-src/src/persist.rs#L1502-L1518 "Ordinary grants refused with persistent roots"
[U2]: https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/docs/backends/process-container/networking.md "Directional networking, identity-scoped peers and identity-less loopback limits"
[U3]: https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/docs/schema.md#L101-L118 "Identity-less proxy has no proxy-only host-loopback exception"
[A1]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/permissions/worker-spawn.ts#L161-L303 "Worker Windows grants, lifetime and TCP control"
[A2]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/plugins/isolation/host-api-dispatcher.ts#L693-L752 "Delegated worker spec and envelope ceiling"
[A3]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/plugins/isolation/out-of-process-plugin.ts#L285-L330 "Plugin envelope derivation"
[A4]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/plugins/isolation/out-of-process-plugin.ts#L527-L660 "Plugin held grant, transport, markers and loss lifecycle"
[A5]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/permissions/asrt-sandbox.ts#L2273-L2463 "Admission, pinned grants, deny handoff, sealing and release"
[A6]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/permissions/confined-child.ts#L200-L340 "Windows relay preparation and restated deny floors"
[A7]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/mcp/mcp-client.ts#L1852-L1900 "MCP Windows grant shape, cwd and lifetime cleanup"
[A8]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/sandbox/wrap-bundled-command.ts#L118-L225 "Bundled child grant, home/runtime reads and release"
[A9]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/hooks/script-hook-runner.ts#L144-L278 "Hook authorization, input, cwd and Windows spawn"
[A10]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/docs/architecture/architecture.md#L2477-L2634 "Current launcher-only packaging, detection, shell routing and residuals"
[A11]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/docs/architecture/architecture.md#L2168-L2250 "Shared account, relay, host-only storage and invocation labels"
[A12]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/plugins/public-contract.ts#L1317-L1405 "Worker spec and handle contract"
[A13]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/boot/steps/windows-sandbox-plan.ts#L1-L117 "Boot selection and capability reporting"
[A14]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/permissions/mxc-windows.ts#L271-L411 "Filesystem ranking and current shell request"
[A15]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/package.json#L128-L294 "Runtime dependencies, Electron range and packaging/unpack rules"
[A16]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/docs/architecture/permission-decision-tree.md#L15-L152 "Decision order, per-effect decisions, forced asks and headless behavior"
[A17]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/shared/sandbox-capability-info.ts#L252-L275 "Current substrate contract"
[A19]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/docs/architecture/architecture.md#L1683-L1692 "Worker stdin liveness and host death contract"
[A20]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/permissions/egress-invocations.ts#L38-L118 "Holder roles, offline network policy and owner lifetime"
[A21]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/shared/tool-timeout-policy.ts#L1-L72 "Central timeout policy"
[A22]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/src/tools/safe-env.ts#L1-L148 "Safe child environment and wrapper overlays"
[A18]: https://github.com/ken-jo/ave/blob/874882e51a1d76185ca81e9675ae05286b4078c3/.github/workflows/ci.yml#L514-L670 "Windows permission path job, staging and regression cohort"
