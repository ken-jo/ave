# Network-Restricted Evaluation

Status: Decided; partly shipped. The verdict snapshot, the live confinement CI jobs and the enforced egress allow-list exist. The per-runner egress probes, telemetry counters and overhead measurement that were planned do not.

This record answers how the OS sandboxing described in [Sandbox isolation](./sandbox-isolation.md) is shown to block network egress, and how reviewer verdicts are expected to change with sandbox state. Product intent lives in [the vision](../vision/README.md).

## 1. Questions

1. Does a confined tool process fail to reach a host it was not allowed?
2. Is an unexpected success (a bypass) detectable rather than silent?
3. Does the reviewer's final verdict respond to sandbox state the way the composition rules say?
4. What has to be recorded to audit enforcement afterwards?

## 2. Scenarios

| Scenario | Setup | Expected |
|---|---|---|
| A. Egress blocked | Confined process requests an external host that is not on the allow-list | Request refused; non-zero exit. |
| B. Bypass detection | Same request on a backend with known gaps | Success is flagged, and the capability is reported as partial so no downgrade is allowed. |
| C. Verdict under sandbox state | Same call with `none`, a full sandbox, and `partial` | `final >= rule` always; a sandbox can permit a downgrade only when it is strong for that tool category. |
| D. Weak context | Benign tool, no stated intent, rule MEDIUM, LLM LOW | Final stays MEDIUM. |

Scenario B was written for a profile-based macOS backend that left loopback, DNS and local sockets open. That backend never shipped; the current macOS backend sends egress through the sandbox runtime's loopback proxy and reports full confinement, so B is no longer a planned test.

## 3. Options considered

| Topic | Options | Decision |
|---|---|---|
| Probe tool | Plain HTTP client CLI; language-runtime HTTP call; custom native binary | HTTP client CLI as the primary probe, a runtime call as secondary. Not built as a standalone harness. |
| Endpoints | Public echo service; local loopback fixture; private corporate endpoint | Local fixture for unit level, public endpoint for end-to-end. The corporate option was rejected (needs a VPN in CI). Superseded by in-test listeners and `.invalid` hosts. |
| Cadence | Gate every PR; nightly only; manual before release | Hybrid. Shipped as dedicated CI jobs (section 4.2). |
| Verdict measurement | Snapshot file; differential analysis | Snapshot. Shipped (section 4.1). |
| Audit sink | Per-feature file; one cross-cutting file | Shipped as a daily JSONL channel in `~/.ave/audit/`; see [section 3.6 of Sandbox isolation](./sandbox-isolation.md#36-s2-sandbox-audit-fields). |

## 4. What shipped

### 4.1 Verdict snapshot

`src/permissions/__tests__/__fixtures__/sandbox-eval-verdicts.json` pins rule, LLM and final verdicts for scenarios C and D (`kind=none`, `kind=asrt`, `kind=partial`, `kind=fs-only`, and weak context). It is asserted by `src/permissions/__tests__/sandbox-capability.test.ts` and by the composition-rule block of `src/permissions/__tests__/risk-classifier.test.ts`. Change the fixture only together with a deliberate composition-rule change.

### 4.2 Live confinement in CI

Cases that need a live sandbox call `sandboxCasesRun()` (`src/plugins/isolation/__tests__/sandbox-cases.ts`). Where the sandbox cannot initialize they return early, so a green run on such a machine measures nothing. `AVE_REQUIRE_SANDBOX_CASES=1` turns that early return into a failure.

`.github/workflows/ci.yml` sets the flag in two jobs:

- macOS permission path tests (no backend install needed).
- Linux confinement path tests, which install `bwrap`, `socat` and `ripgrep`, allow unprivileged user namespaces, and prove the backend before running.

Both run `confined-plugin-child.test.ts`, `adversarial-escapes.test.ts` (including the `escape_network` cases, where an out-of-allow-list host is refused and a loopback listener is not reachable) and `src/hooks/__tests__/bundled-hook-asrt.smoke.test.ts`. The general Linux job has no `bwrap`, so these cases pass there without measuring. The Windows job runs sandbox logic tests (`windows-sandbox-logic.test.ts`, `asrt-windows-support.test.ts`) but not live egress cases.

### 4.3 Enforced network policy

Configured at boot in `src/boot/steps/sandbox-init.ts` and built in `src/permissions/asrt-sandbox.ts`:

- One shared config with `strictAllowlist: true`. Any host off the list is refused, with no interactive fallback, for host tools and plugin workers alike.
- The list is the union of every loaded plugin manifest's `networkAccess.allowedDomains` (`computeUnionAllowedDomains`) and the host names of configured model-provider endpoints (`computeDynamicEndpointHosts`). The trusted host baseline is empty by default. The list is refreshed when plugins or provider settings change (`updateAsrtSandboxConfig`).
- `normalizeUnionForAsrt` emits both `d` and `*.d` for each bare domain, so the sandbox allows the same hosts as the host-fetch allow-list's dot-boundary match.
- The upstream proxy is set explicitly. With no trusted proxy configured it is empty, so confined processes never inherit an ambient proxy from the environment.
- Trade-off: this is a union, not per-process isolation. A confined process can reach any domain that any loaded plugin declared.

In-process requests have their own guards:

- `src/main/host-fetch-guard.ts` gates `hostApi.hostFetch`. It validates the URL, requires https (except a declared loopback name), requires an allow-list match, and runs a DNS-aware private-address check. Private networks are reachable only with the manifest opt-in `networkAccess.allowPrivateNetworks`.
- `src/core/network-guard.ts` provides SSRF defense with a private, loopback, link-local and unique-local blocklist, re-checked on every redirect hop. It is used by `web-fetch`, the MCP client and the marketplace fetcher.

### 4.4 Not built

- Per-runner unit probes and the per-OS by spawn-path egress matrix as originally tabulated.
- Telemetry counters for blocked or bypassed egress, prevented downgrades, and spawn latency.
- The overhead gate (no runner over 30%). The audit fields for latency and overhead exist but are written as `0` ("not measured").

## Related

- [Sandbox isolation](./sandbox-isolation.md)
- [Permission policy design](../architecture/permission-policy-design.md)
- [Plugin process isolation](../blueprints/plugin-process-isolation.md)
- [Architecture](../architecture/architecture.md)
