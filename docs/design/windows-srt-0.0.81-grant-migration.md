# Windows grant migration to 0.0.81

Status: proposed; owner approval required before implementation. Scope: preserve
Ave's permission order while replacing its inherited 0.0.80 holder-based grant
model. This document authorizes no runtime change. Recommendations below are
choices awaiting approval, not existing guarantees.

Evidence is pinned to upstream v0.0.81 (`c40cf14a65d025e3cd27f071f13a73c12b3b1f92`)
and Ave `ae8203a21a504ae24d7247a5d0ca5dcb4033083a`. Source references include
file and line ranges. Proposed requirements and estimates are identified as such.

## 1. Current model and failure

“Ordinary grant” means the nonpersistent `grantWindowsAcl` API, not a claim that
this branch's children still use an ordinary token. That API invokes `acl grant`
without `--persistent`; 0.0.81's wrapper already requests a restricted token.
[U1] [U2]

| Holder or caller | Current scope | Current lifetime and release |
| --- | --- | --- |
| Delegated worker | Throwaway home plus admitted read/write envelopes; host-owned holder PID | Worker lifetime; holder failure terminates the child; cleanup releases its grant. [A1] [A2] |
| Confined plugin child | Outermost roots of its own envelope, including writable data/control roots and throwaway home; grant outside its own roots is rejected | Child incarnation; lifecycle owns the shared holder helper. [A3] [A4] |
| MCP stdio | Sandbox home and configured writable roots; generation/payload/runtime read paths | Server lifetime through the bundled-process helper. [A5] [A6] |
| Hook | Plugin generation read and data write, or admitted user script read and working-directory write | Hook process lifetime through the bundled-process helper. [A7] [A6] |
| `wrap-bundled-command` | Shared mechanism for the preceding MCP/hook callers, not another permission principal | Owns home and grant cleanup for its spawned process. [A6] |

All reach `grantWindowsWorkerFilesystemAccess`. Before granting an overlapping
write envelope, Ave revisits absent deny obligations, rejects overlapping globs,
stamps concrete targets and parent delete-child denies, and verifies their native
DACLs. A verification failure seals the session; it cannot fall back to host
execution. The ordinary grant runs only after that handoff. [A8]

Release decrements Ave's live-grant counts and calls `revokeWindowsAcl` for the
holder. Reset invalidates admission before awaiting upstream reset and clears
Ave's session allowance state. This does not promise instant on-disk cleanup after
a crash or failed revoke: the existing holder release is best effort, and the host
owns child termination. These limits must remain visible in the migration. [A4] [A9] [A17]

The normal boot config supplies no write roots. Explicit initialization roots
come from admitted `allowWrite`, not an automatic project or `AVE_HOME` grant.
The timing test does supply a write root, resets, then deletes it; upstream reset
keeps its persistent grant. Ordinary grants are thereafter refused even for
unrelated targets. Thus the CI trigger is test pollution, but the production
incompatibility also exists whenever this user's persistent roots are present.
[A10] [A11] [A19] [U3] [U4] [U23]

## 2. Target mechanisms and limits

Upstream initialization calls `grantWindowsAclPersistent` with resolved write
roots. The Rust implementation assigns capability SIDs and retains write-root
ACEs; read grants and denies outside persistent roots remain holder-scoped.
Nested denies are retained and accumulate. Reset/revoke drops session holds,
not persistent roots. **Every sandboxed session on the machine can read a retained
root, even without its write capability.** Disabling the broad profile grant does
not remove this separate exposure. [U3] [U5] [U6]

The restricted token includes selected root capabilities plus the sandbox user,
Everyone and RESTRICTED SIDs. This removes ordinary Users-group write reach, but
does not eliminate Everyone-writable locations or all other Windows residuals.
The README also documents restricted-token TLS limitations. Do not advertise
complete filesystem isolation. [U2] [U6]

Capability selection is technically **per child**, not inherently per session:
the lower-level wrapper accepts `writeRoots` and emits one `--write-root` per root;
the helper resolves capabilities against recorded roots and their current file
identities. However, `SandboxManager` currently supplies its initialized root set
to every child, and `updateConfig` does not apply changed Windows grant sets.
Its public entry point exports ordinary grant/revoke, but not
`grantWindowsAclPersistent`. Ave therefore needs an explicit, reviewed wrapper/API
extension; replacing one grant function is insufficient. [U2] [U7] [U8] [U9] [U17] [U18] [U19]

`acl forget` removes persistent grants; ordinary revoke does not. The CLI offers
`--unless-held-by-others` for checked cleanup, but its check considers other live
kept-root holders, not only Ave's reference counts. Defer rather than destroy
another session's grants. Setup version 2 must be upgraded to 3 by reinstall;
downgrade requires this release's cleanup first. [U10] [U11] [U12] [U20]

## 3. Proposed mapping and lifecycle

### One immutable grant plan per spawned child

Proposed host contract: an admitted plan binds the existing recipient, invocation,
holder PID, canonical root identities, read roots, write roots, deny obligations,
and release generation. The child receives exactly its plan's write capabilities,
never the union of all live holders. Keep boot rootless. Preserve the existing
outermost-envelope and private-helper exclusions. These requirements retain
Ave's current admission boundaries while addressing the manager's session-wide
selection. [A3] [A8] [A10] [U7]

| Existing holder | Proposed registration and child selection |
| --- | --- |
| Worker | Register its home and admitted writable envelopes persistently against its own holder; select only those roots for that worker. Other envelope paths are read grants. |
| Plugin child | Same mechanism, limited to its own outermost envelope; no capability for the whole plugins directory or `AVE_HOME`. |
| MCP stdio | Register only writable home and explicitly approved server roots. Payload/generation/runtime paths remain read-only. Read-only mode is an explicit owner/product choice, not an automatic fallback. |
| Hook | Plugin data or the already-admitted user-hook working directory supplies write roots; generation/script remains read-only. Root registration adds no new tool authority. |
| Bundled-process helper | Consumes the caller's sealed plan and owns lifetime; does not independently widen or choose roots. |

These are proposed replacements of the scopes in §1, supported by the persistent
registration and per-child token primitives; they are not supported by the
unmodified manager wrapper. [A1] [A3] [A5] [A6] [A7] [U3] [U7]

Proposed wrapper extension: carry a trusted child grant plan through the existing
attributed manager wrap, selecting its `writeRoots` and matching holder for
`--held-by`. Do not bypass the invocation listener, network/credential processing,
runtime integrity checks or per-exec deny generation by constructing a separate
execution path. Reject missing/changed identities, ended holders and unregistered
roots. The helper verifies recorded root identity and watches a named session;
those checks complement, not replace, Ave's admission. [U7] [U8] [U18] [A8]

**Object binding is not solved by a sealed plan.** Ave's current native grant is
by name: a swap between pinning and the DACL write remains possible, and a swap
restored before post-check is undetected. The migration must not call repeated
checks handle-bound enforcement. Proposed minimum: retain host-controlled root
anchors, reject a root whose ancestors another confined holder can replace,
and retain those constraints until its last child exits. Eligibility requires a
host-created root, a canonical non-reparse parent chain with verified native
ownership/DACL facts, and no live or newly admitted confined write envelope that
can replace an anchor; reserve those exclusions for the child's lifetime.
Unprovable eligibility refuses admission. This does not prevent a trusted local
user or administrator from racing the path. Root file-ID checks at
capability lookup do not by themselves bind the earlier ACL mutation. D7 decides
whether the remaining by-name race is acceptable or a handle-bound backend is
required; native replacement tests are an approval gate, not evidence yet.
[A20] [U18]

### Register, hand off denies, spawn

Proposed sequence after existing permission approval:

1. Check the plan's authority, identity, current session and disclosure/consent.
2. Preserve Ave's serialized deny-absent preparation: reject uncertain/glob
   overlap; create/stamp only required placeholders; verify target and parent
   protection before exposing a writable envelope. [A8]
3. Use persistent registration for both writable and read-only holders. For a
   read-only holder pass `write: []`; do not invoke ordinary grants alongside
   persistent roots. Pass the complete relevant denies when registering a write
   root so protection beneath it is retained for the sandbox group. [U3] [U5]
4. Verify root identity and effective protection again, then spawn with precisely
   the plan's capabilities and deny floor. Any partial result fails closed;
   keep protective denies until grant cleanup is verified. [A8] [U7]

The current SID-only DACL verifier is insufficient as evidence for a migrated
persistent root: the new root and nested denies use the sandbox group and
capability layout. Implementation must verify that layout and effective access
under the actual child token. Upstream records nested denies monotonically;
requesting fewer denies later must never be interpreted as removing them.
Hard links, junction swaps, placeholder deletion and root replacement remain
mandatory adversarial cases. [A8] [U5] [U13]

### Release, reset and crash

Proposed release has two separately reported outcomes:

- **Authority ended:** seal admission, stop and await the managed child/process
  tree, revoke holder-scoped reads/holds, then retire the holder. A token's selected
  capabilities do not disappear merely because Ave decremented a count; do not
  report revocation while that child can still execute. [A2] [A4] [U2] [U8]
- **Retained ACLs removed or cleanup pending:** after the last Ave reference,
  attempt checked, exact-root forget only for an Ave-owned registration whose
  provenance and overlaps are known. Never run global forget automatically.
  Another holder, unknown provenance, nested foreign root, unavailable volume or
  unverifiable removal leaves an explicit pending-cleanup record. Do not claim
  that reads were revoked. [U10] [U11] [U20] [U21]

Proposed reset seals all new wraps first, terminates all Ave-owned children, then
performs the same release protocol. A new generation inherits no capability plan.
Keep the existing upstream crash-recovery path for dead holder ACEs; add an
Ave-owned registration ledger and boot reconciliation for retained roots, without
claiming crash recovery automatically removes them. Persist that ledger through
the existing feature-namespace boundary, and never let a user-writable ledger
alone authorize deletion of a root or ACL. [A9] [A17] [U4] [U10] [A18]

Read-only registrations remain session-scoped even through the persistent API
with no write roots. They can coexist with retained write roots, but cannot make
an already retained root private again. [U3] [U6]

## 4. Guarantee deltas

Statuses below describe the proposed target, conditional on owner decisions and
the native acceptance tests. They are not claims of completed implementation.

| Guarantee today | Target | Mitigation or required proof |
| --- | --- | --- |
| Scope admitted before native grant | **Kept** | Same permission admission and identity checks; sealed plan. [A8] |
| Scope differs between concurrent holders | **Strengthened for writes** | Select capabilities per child, not all initialized roots; test disjoint and overlapping envelopes. Shared-account live reads already lack per-plugin isolation. [A3] [U6] [U7] |
| Lifetime-scoped write ACE removed after final ordinary holder releases | **Lost as a physical-ACL guarantee** | End child authority first; checked exact-root forget afterwards. Report retained/pending ACLs and require retention consent. [A9] [U4] [U10] |
| Grant does not intentionally expose its tree after release/reset | **Weakened for reads** | Explicit retained-root disclosure/consent; prompt cleanup; refuse unconsented write registration. No claim of confidentiality from other sandbox sessions while retained. [U6] |
| Read-only holder does not gain write | **Kept** | Register `read` with empty `write`; no root capability; test actual denied writes. Existing external/Everyone permissions remain residuals. [U2] [U3] |
| Absent denies protected before overlapping write grant | **Kept, new proof needed** | Preserve handoff ordering and verify group/capability layout; never remove retained nested denies as a release shortcut. [A8] [U5] [U13] |
| Concurrent release does not remove another live holder's rights | **Kept** | Ave root counts plus upstream checked holder handling; unknown/external holder means defer forget. [A9] [U11] |
| Reset clears Ave allowance state | **Kept** | End children; invalidate plans/generation before awaits. New tokens receive no retired capabilities. [A9] [U7] |
| Clean reset intentionally retains no ordinary grant ACEs | **Lost** | Separate authority revocation from persistent-ACL cleanup; pending records survive reset and restart. [U4] [U10] |
| Crash recovery eventually reaps dead holder state | **Kept for session state; weakened for persistent read cleanup** | Reconcile owned retained roots at next boot; surface failures/offline roots; no promise of immediate cleanup after crash. [U4] [U12] |
| Ordinary Users-group ambient write reach | **Strengthened** | Always restricted token; no retry under ordinary token. Preserve the documented Everyone-writable residual. [U2] [U6] |
| Coexistence with another consumer under the same user | **Weakened for read cleanup and ordinary-grant compatibility** | Remove ordinary grant calls; never erase its roots. Shared retained-read exposure remains an accepted limitation or this backend must be unavailable for that use. [U1] [U6] [U10] |
| No intentional post-release write access from another Windows user's ordinary sandbox token | **Weakened by retained group ACEs** | Do not offer this backend as a multi-user confidentiality/write-isolation boundary. Another Windows user's ordinary helper execution can write retained roots because the block marker is per user; require a different backend if that threat is in scope. [U24] |
| Private helper and host-secret boundaries | **Kept, must revalidate** | No broad `AVE_HOME` root; preserve private-copy integrity and deny floor; test against retained ancestor grants. [A3] [A8] [A12] |
| Already-ported broad profile-grant refusal | **Kept** | Preserve snapshot and post-registration live checks before activation, with typed contract/verification errors and teardown. Root retention consent never authorizes a broad profile grant. [A21] |
| By-name ACL mutation has an acknowledged swap window | **Kept residual unless D7 requires strengthening** | Immutable root anchors, overlap rejection and post-checks; no assertion that these close a swap restored before verification. Require native proof before claiming stronger binding. [A20] [U18] |
| Uninstall/downgrade can finish after process cleanup | **Weakened operationally** | Stop sessions, use current helper for cleanup, preserve nonzero failure and pending records; do not swap an older binary over unresolved grants. [U12] [A13] |

Root capability selection separates writes; it does not establish independent
per-plugin accounts or prevent another consumer from adding a readable retained
root while Ave is running. A status snapshot cannot close that machine-wide
read-exposure race. If strict inter-consumer read isolation is required, this
shared-account backend does not meet it. [U6] [U7]

## 5. Owner decisions

Choose one option per row before implementation. Recommendations accept the
documented backend limits; selecting stricter confidentiality changes feasibility.

| ID | Choice (2–4 options) | Recommendation |
| --- | --- | --- |
| D1 | Retained roots: consent for every root; bounded managed-root consent plus per-host-directory consent; disclosure only; forbid retained host-directory roots | **Bounded managed-root consent plus per-host-directory consent**, with duration/read-exposure disclosure. The managed scope names root templates and data classes, not a grant on their whole parent. A normal tool approval must not silently mean durable shared read access. [U6] |
| D2 | Other consumers' roots: coexist with accepted shared-read limits; refuse known foreign roots; require a different isolation backend | **Coexist only with explicit acceptance of shared-read limits**; never forget foreign roots. Refusing known roots alone cannot promise protection from roots added later. Strict confidentiality requires the third option. [U6] [U10] |
| D3 | MCP/hooks/other holders: preserve approved writes; force read-only; disable holders needing durable writes | **Preserve approved writes only after D1 consent**; otherwise refuse that launch with an actionable reason. Read-only operation is opt-in and must not silently break a writer. Apply the same rule to all mappings in §3. [A1] [A3] [A5] [A7] |
| D4 | Release cleanup: checked exact-root forget after final release; retain until explicit user cleanup; coordinated maintenance-only cleanup | **Checked exact-root forget**, with pending status and no automatic global cleanup. Retention is still disclosed because cleanup can fail or be deferred. [U10] [U11] [U20] [U21] |
| D5 | Existing setup: accept verified v3 in place and offer v2 upgrade; force reinstall every machine; refuse all pre-existing installations | **Accept verified v3 in place; explicitly offer v2→v3 reinstall**. Audit profile and root state without deleting another consumer's configuration. [U12] [A14] |
| D6 | Failed/uncertain registration or cleanup: block affected recipient; block all worker confinement; require manual repair before any Windows sandbox use | **Block affected recipient**, escalating to the whole backend when a shared invariant is unverified. Preserve causes and pending evidence; no ordinary-token or unconfined fallback presented as equivalent isolation. [A8] [A14] [U1] |
| D7 | Root binding: accept the existing by-name residual with anchored roots; require handle-bound mutation; refuse mutable host-directory roots | **Refuse mutable host-directory roots until handle-bound or equivalent binding is demonstrated**; anchored managed roots proceed only with explicit residual disclosure. This may reject envelopes previously accepted and expands the estimate if native primitives must change. [A20] [U18] |

## 6. Permission decision tree and user-visible changes

Proposed order is unchanged: admission/hooks/deny → protected-operation forced
question → explicit rules/memory → tool kind → mode/reviewer/human. No node or
edge in `permission-decision-tree.md` changes. Registration consent is a separate
setup/recipient-configuration action. Missing consent makes the launch unavailable
at admission; a stale or missing consent found at the effect boundary rejects the
spawn rather than inserting another reviewer/approval round after an allow. [A15]

**D1 adds a separate root-registration consent**, not another tool-risk decision:
the user sees the exact canonical roots, cross-session/machine sandbox read
exposure, cleanup policy and pending-cleanup state. Existing tool approval and
recipient scope still apply; refusing registration cannot be bypassed by allow
mode. D2 adds acceptance of the shared-read limitation. D5 may ask for reinstall;
D3 may leave a write-dependent holder unavailable; D7 can reject a previously
accepted mutable directory. These are proposed new asks
and availability changes requiring owner approval, not existing UI behavior.
[U6] [U12] [A15]

## 7. Implementation and acceptance plan

Proposed slices, after approval, in dependency order:

1. **Contracts and native primitives:** extend the carried patch with trusted
   per-child capability/holder selection through the attributed manager wrapper;
   expose checked persistent registration without ordinary grant fallback.
   Own `patches/@anthropic-ai%2Fsandbox-runtime@0.0.81.patch`, the Windows adapter
   and typed errors. Verify exported symbols and exact helper integrity. Basis:
   the current wrapper/session-set limitation and missing public persistent API.
   [U7] [U9] [U17] [U18] [U19]
2. **Grant lifecycle and deny migration:** update `asrt-sandbox.ts`,
   `windows-acl-grant-holder.ts`, `windows-deny-acl.ts`, `windows-stamp-targets.ts`;
   add plan/registration ledger, checked release and recovery. Replace every
   ordinary registration, including read-only holders. Preserve synchronous
   admission checks around asynchronous native work. [A8] [A9] [U3] [U13]
3. **Caller mapping and product consent:** integrate `worker-spawn.ts`,
   `out-of-process-plugin.ts`, `wrap-bundled-command.ts`, `mcp-client.ts`,
   `script-hook-runner.ts`; Settings/permission shared types and localized
   messages for D1–D6. Update architecture and plugin protocol together, replacing
   the current holder-only description rather than appending conflicting prose.
   [A1] [A3] [A5] [A6] [A7] [A12]
4. **Packaging and release gate:** update Windows readiness/install/uninstall
   contracts and installer smoke coverage; keep setup/integrity checks strict.
   Do not publish the dependency upgrade until all slices' native gates pass.
   [A13] [A14] [U12]

### Mandatory real-Windows CI

Proposed acceptance gates use the shipped, integrity-pinned helper and real
manager/token/ACL operations; platform simulation and manager mocks supplement
them, never replace them:

- `asrt-deny-absent-native.test.ts`: retain the earlier wrapped command while a
  sibling grant is added; prove absent-file denial, parent delete protection,
  placeholder restoration, hard-link and junction refusal. Existing native setup
  forwards to the real manager. [A16] [A8]
- New native capability/lifecycle cases: two simultaneous disjoint roots; read-only
  child; overlapping same-root holders; release one holder; holder/host crash;
  reset with a running child; later generation with no retired capability;
  root identity replacement; partial native writes; cleanup/forget failure.
  Inspect both ACLs and actual allowed/denied child I/O. [U2] [U7] [U11] [U13]
- Mixed-mode transition: a live ordinary write holder must not be silently
  revoked to create a persistent root; preserve upstream refusal, stop Ave's old
  holders explicitly, and leave foreign holders alone. [U22]
- New same-user multi-consumer cases: seed a foreign persistent root using the
  real CLI, start Ave, retain it through Ave release, verify selected write scope
  and the disclosed read exposure. Start another consumer during Ave lifetime;
  test cleanup deferral. No `forget --all` in shared-runner setup/teardown.
  Each case owns exact fixture roots and checks residue before deletion. [U6] [U11]
- `asrt-sandbox`, `asrt-windows-grant-paths`, `asrt-stamp-targets`,
  `filesystem-policy-boundary`, `confined-plugin-child`, MCP/hook spawn and
  worker-lifecycle suites: add real-helper cases at each changed effect boundary;
  keep existing mock-based race tests as supplemental coverage. [A1] [A3] [A5] [A7] [A8]
- `smoke-windows-nsis-installer`: retain source-contract tests and add disposable
  Windows VM install/uninstall exercises: v2 upgrade, existing v3, live other
  session, offline root, cleanup nonzero, interrupted cleanup and downgrade.
  Confirm actual exit/outcome semantics; never uninstall a shared developer
  installation as a test. [A13] [U12]

Run affected Vitest paths only during development, plus typecheck, the unchanged
test-typecheck ratchet, knip and frozen install after patch/lock changes. Linux
and macOS targeted confinement tests must show the Windows extension introduces
no alternate wrapping path. These are proposed gates, not results of this design.

### Rollback and estimate

Proposed rollback: stop Ave's managed children, retain the current verified helper,
reconcile and remove Ave-owned roots with checked exact-root cleanup, verify the
remaining root/profile inventory, then perform an explicitly chosen reinstall.
If foreign roots or unverified/offline ACLs remain, do not automate downgrade or
delete their records; leave the affected Windows backend non-ready. A full
downgrade is an owner-coordinated maintenance operation for every affected user,
following upstream's current-release uninstall/forget-before-older-install rule.
Other platform functionality is not authorization to claim Windows confinement.
[U12] [A13] [A14]

Engineering estimate, not a source fact: **5–10 implementation days plus 2–5 days
of native Windows validation/review**, approximately 15–25 files including patch,
tests, UI and documentation. Risk is high at token selection, concurrent cleanup
and retained-read boundaries. D7's handle-bound work is not included in that
estimate and must be sized after a native feasibility experiment; it is a blocker
for mutable host roots, not permission to ship them meanwhile. Re-estimate if D2 requires strict inter-consumer
read isolation: the documented shared-account model cannot provide that promise,
so it would require a different backend or upstream design. [U6] [U24]

[U1]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/sandbox/windows-sandbox-utils.ts#L3181-L3204 "windows-sandbox-utils.ts:3181–3204: ordinary grant"
[U2]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/token.rs#L29-L42 "token.rs:29–42: write-restricted token"
[U3]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/cli.rs#L2115-L2180 "cli.rs:2115–2180: ordinary versus persistent registration"
[U4]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/sandbox/sandbox-manager.ts#L3188-L3207 "sandbox-manager.ts:3188–3207: reset retains roots"
[U5]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/persist.rs#L887-L979 "persist.rs:887–979: retained denies and root registration"
[U6]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#L793-L821 "README.md:793–821: lifecycle, read exposure, token and TLS limits"
[U7]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/sandbox/sandbox-manager.ts#L2948-L2965 "sandbox-manager.ts:2948–2965: initialized roots selected for each wrap"
[U8]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/cli.rs#L2785-L2863 "cli.rs:2785–2863: root capabilities and session watch"
[U9]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/index.ts#L58-L118 "index.ts:58–118: public Windows API exports"
[U10]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/persist.rs#L1383-L1418 "persist.rs:1383–1418: exact-root/all forget"
[U11]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/cli.rs#L2286-L2305 "cli.rs:2286–2305: checked forget"
[U12]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#L750-L764 "README.md:750–764: reinstall, profile grant, downgrade"
[U13]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/acl.rs#L1473-L1533 "acl.rs:1473–1533: persistent group/capability ACE layout"
[U17]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/sandbox/windows-sandbox-utils.ts#L654-L659 "windows-sandbox-utils.ts:654–659: lower-level writeRoots API"
[U18]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/persist.rs#L983-L1008 "persist.rs:983–1008: capability selection verifies root identity"
[U19]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/src/sandbox/sandbox-manager.ts#L3015-L3027 "sandbox-manager.ts:3015–3027: updateConfig retains applied filesystem set"
[U20]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/cli.rs#L3129-L3157 "cli.rs:3129–3157: other live roots block checked forget; incomplete uninstall"
[U21]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#L958-L962 "README.md:958–962: unreachable volumes and pending cleanup"
[U22]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/persist.rs#L624-L637 "persist.rs:624–637: ordinary write ACE blocks persistent root"
[U23]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/vendor/srt-win-src/src/persist.rs#L1502-L1518 "persist.rs:1502–1518: ordinary grants blocked by persistent roots"
[U24]: https://github.com/anthropics/sandbox-runtime/blob/v0.0.81/README.md#L1000-L1006 "README.md:1000–1006: multiple Windows users and per-exec allow limitation"
[A1]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/worker-spawn.ts#L235-L287 "worker-spawn.ts:235–287: worker holder, scope and failure"
[A2]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/windows-acl-grant-holder.ts#L82-L141 "windows-acl-grant-holder.ts:82–141: holder lifecycle"
[A3]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/plugins/isolation/out-of-process-plugin.ts#L527-L550 "out-of-process-plugin.ts:527–550: plugin envelope grant"
[A4]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/docs/design/plugin-hostapi-protocol.md#L5264-L5282 "plugin-hostapi-protocol.md:5264–5282: shared account and incarnation lifetime"
[A5]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/mcp/mcp-client.ts#L1852-L1883 "mcp-client.ts:1852–1883: Windows stdio grants"
[A6]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/sandbox/wrap-bundled-command.ts#L118-L155 "wrap-bundled-command.ts:118–155: bundled process holder"
[A7]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/hooks/script-hook-runner.ts#L250-L278 "script-hook-runner.ts:250–278: hook grants"
[A8]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L2331-L2463 "asrt-sandbox.ts:2331–2463: pin, deny handoff, grant and failure"
[A9]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L2475-L2505 "asrt-sandbox.ts:2475–2505: release and live-grant counts"
[A10]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/boot/steps/sandbox-init.ts#L280-L288 "sandbox-init.ts:280–288: rootless boot"
[A11]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/__tests__/asrt-sandbox.test.ts#L312-L330 "asrt-sandbox.test.ts:312–330: timing fixture retains a root"
[A12]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/docs/architecture/architecture.md#L2711-L2734 "architecture.md:2711–2734: private helper boundary"
[A13]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/build/installer.nsh#L480-L514 "installer.nsh:480–514: genuine uninstall failure contract"
[A14]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/windows-profile-read.ts#L1-L32 "windows-profile-read.ts:1–32: fail-closed profile errors"
[A15]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/docs/architecture/permission-decision-tree.md#L15-L55 "permission-decision-tree.md:15–55: owner decision order"
[A16]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/__tests__/asrt-deny-absent-native.test.ts#L69-L87 "asrt-deny-absent-native.test.ts:69–87: forwards real manager initialize"
[A17]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L2595-L2614 "asrt-sandbox.ts:2595–2614: reset invalidates admission before await"
[A18]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/main/storage/feature-namespace.ts#L191-L202 "feature-namespace.ts:191–202: persisted namespace contract"
[A19]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L1555-L1592 "asrt-sandbox.ts:1555–1592: configured admitted write roots"
[A20]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L2432-L2447 "asrt-sandbox.ts:2432–2447: by-name mutation and swap residual"
[A21]: https://github.com/ken-jo/ave/blob/ae8203a21a504ae24d7247a5d0ca5dcb4033083a/src/permissions/asrt-sandbox.ts#L1874-L1905 "asrt-sandbox.ts:1874–1905: snapshot/live profile guard and teardown"
