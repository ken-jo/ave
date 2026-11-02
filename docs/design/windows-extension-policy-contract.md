# Extension backend policy contract

The [extension design](windows-extensions-mxc.md#4-host-selection-and-readiness)
owns backend selection. The [permission tree](../architecture/permission-decision-tree.md)
keeps its decision order. Backend selection is evidence at the sandbox node;
it grants no permission and never replaces the actual effect's admission.

`SandboxWindowsSubstrateInfo.extensionPlan` is the shared disclosure contract.
New boot producers always emit it; absence in an older snapshot conveys no
MXC readiness. The shell `mxc` probe and extension request readiness are
independent. `getWindowsExtensionBackendPlan()` returns the sealed boot selection. This
snapshot is a boot admission policy, not an active-holder registry. The pure
holder selector and readiness resolver describe a candidate exact request;
they do not publish or mutate the boot snapshot. The holder adapters and native
release gate must bind that candidate to their captured runtime, request and
incarnation before admitting it. No caller may use a successful candidate to
change the backend of an admitted holder or ancestor.

The exact types and closed reason set live in
[the shared capability schema](../../src/shared/sandbox-capability-info.ts),
and the [readiness resolver](../../src/permissions/mxc-extension-readiness.ts)
owns state transitions. The following table defines the legacy start guard:

| Readiness | Selected backend | Legacy start guard |
| --- | --- | --- |
| `off` | `none` | Existing opt-out behavior and privacy checks. |
| `checking` | `none` | Per-holder candidate only; never published as the boot snapshot (see below). Refuse until the bounded readiness queue settles. |
| `ready` | `mxc` | Refuse legacy transport; only the explicit native entry may proceed. |
| `fallback` | `srt-win` | Retain existing pinned account-backed admission and release. |
| `unavailable` | `none` | Preserve settled initial degraded-host behavior and privacy/approval checks; no confinement relaxation. |
| `rejected` | `none` | Refuse; a deadline rejection cannot become an unconfined start. |

The native entry always requires `ready` plus `mxc`. A checking record
is not permission to run and the synchronous guard itself does not queue.
The caller awaits the readiness resolver before retrying admission. Boot has no
extension readiness settler, so `setWindowsSandboxSubstrate()` refuses a
checking plan outright and boot inputs exclude it by type: a published checking
plan would refuse every start for the whole session with nothing to resolve it.
`checking` exists only as the per-holder resolver's transient candidate.

Republishing the substrate for an unrelated change, such as the shell probe
settling, keeps the identical extension plan object. Admission receipts and live
MXC parents bind to that object, so only a change in plan content invalidates
them; an MXC parent keeps admitting children after the shell probe settles.

| Field | Meaning |
| --- | --- |
| `requestedBackend` | `mxc` when extension confinement was requested, otherwise `none`. |
| `selectedBackend` | `mxc`, pinned `srt-win`, or `none`; one backend per holder and its descendants. |
| `readiness` | `off`, `checking`, `ready`, `fallback`, `unavailable`, or `rejected`. A ready plan is not a running-process marker. |
| `reason` | Stable reason for checking, native verification failure, deadline, incompatibility, fallback, or rejection. Fallback retains the actual readiness failure. |
| `fallbackVersion` | `0.0.80` only when that already-ready fallback was selected, otherwise null. |
| `uiPolicy` | `ui-enabled`; untrusted windows remain possible. Clipboard and input injection stay disabled in the request. |
| `egressIdentity` | `kernel-channel` for the selected MXC endpoint-scoped route; `shared` otherwise. |
| `proxyOwnerVerified` | False: endpoint scoping does not authenticate the proxy process owner. |
| `hostLoopback` / `inboundProtection` / `dnsProtection` | Bidirectional loopback request, host firewall for inbound, host resolver for DNS. |
| `ancestorAccess` / `ancestorNameExposure` | Query/enumerate-only; ancestor names and metadata may be exposed, including profile siblings. Descendant enumeration remains a native measurement. |

The UI, loopback and ancestor fields describe the requested MXC policy. They
apply to a selected MXC request, not to the account fallback or an unconfined
process. The owner accepts their residual exposures in design decisions D2/D3;
missing endpoint isolation or unsupported query policy remains a readiness
failure, not an accepted exposure.

`planWindowsExtensionHolder()` selects for the exact runtime/request. A caller
must not reuse another holder's readiness or widen the request to make a probe
pass. Checking queues admission without a temporary fallback or unconfined
process. `settleWindowsExtensionReadiness()` bounds this wait using
`TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs` and passes cancellation to the
probe. The millisecond budget starts when the resolver is called and includes
its wait. Cancellation observed before settlement rejects even if the probe
also succeeds. The probe owns cleanup of any native resources it created;
this resolver installs no process markers and owns no persisted queue. Its
caller owns admission serialization, captured session identity and cancellation
of queued starts. Fallback readiness must come from the same boot/session, and
ancestor admission is rechecked at settlement before returning the candidate.

The readiness classifier requires every recorded observation: verified installed
payload, BaseContainer support, exact-request acceptance, UI-enabled runtime
startup, query ancestors, standard-stream round trip, clean termination,
endpoint isolation with correct forged-label attribution and no worker port, and
refusal of reparse substitution of grant paths (`reparseSubstitutionRefused`).
A launcher-only shell result supplies none of that extension evidence.

On deadline or settled host unavailability, fallback requires version `0.0.80`,
ready in the current boot/session, and no admitted holder or ancestor. The
resolver takes the admitted ancestor's backend, not a boolean: an available MXC
request becomes `ready` only at the root or beneath an MXC ancestor, and any
other admitted ancestor rejects it with `ancestor-already-admitted`. The
resolver never initializes or waits for a fallback after the deadline. Failure
of an admitted holder does not call selection again. Internal contract errors
propagate; externally reported capability unavailability can select the
already-ready fallback. Cancellation rejects without fallback.

Current delivery status: boot reports `native-validation-required` for
extension requests.
It retains an already-ready pinned fallback or reports no extension substrate.
The native release gate must provide the actual request evidence before MXC
extension activation. The capability snapshot never turns proxy-only startup
into process-wide confinement. Per-process markers still require a completed
native spawn and transport setup, and are removed when authority is revoked.
`assertExtensionStartAllowed()` rejects checking/rejected starts before legacy
adapters can create an unconfined or account-backed process. A selected MXC
plan rejects a legacy adapter by its declared holder role, never a plugin ID:
the worker adapter declares `{ holder: "worker" }` and is refused with
`worker-transport-unsupported` (D1); every other legacy holder (plugin child,
MCP stdio, hooks) is refused with the holder-neutral `native-entry-required`
(`MxcNativeEntryRequiredError`). The native entry opts in with
`{ backend: "mxc" }` and rechecks readiness.

The plugin-child adapter (row 3) spawns only through `spawnMxcConfinedChild`. It
supplies the host-derived command, arguments, cwd, environment and envelope
grants itself, and takes only the staging HOME/temp, the captured ownership, the
probe and revocation from the planner. On the request that admission measures,
it checks that `request.command` equals `windowsCommandLine(command, args)` and
that `request.workingDirectory` equals the derived cwd. Both comparisons are
exact, with no case folding or normalization. The request builder therefore
forms `command` with that helper (`quoteWindowsArgument` joined by spaces) and
passes the cwd through verbatim; it never uses a probe's quoting.

The confinement a holder reports is `windows-mxc` (`SpawnConfinement`, and so
`PluginConfinementReport`). The holder adapter reports it only after the native
spawn and its own transport setup both succeed, and stops reporting it when
authority is revoked; a ready boot plan never produces it.

`admitMxcExtensionFilesystem()` shares canonical grant pinning, protected read
floors, private/plugin roots and mandatory write controls. It accepts only the
holder's explicit roots, never the session's live account-grant union. It
performs no ACL mutation. Unrepresentable pattern denies, missing grant targets
and volume-root content grants fail admission. The returned identity callback
must run immediately before the native handoff; a changed root aborts that
handoff. Container policy and independent native observations must establish
access restrictions; constructing this plan alone is not native proof.

The host registers each native holder's cleanup closure before listener or native
creation. The lifetime registry retains that closure, its process handle and its
listener lease through failed startup or disposal. A failed release removes
nothing: the holder remains quarantined and an explicit release or shutdown
drain retries the cleanup closure. Native or listener implementations that cache
a cleanup failure remain quarantined through session shutdown; retries promise
neither native re-verification nor successful endpoint release. Neither a later generic kill nor application exit establishes
native death or permits endpoint/token release. Both complete and interrupted-boot shutdown seal holder
admission before draining these owners, ahead of generic process killing and its
resource finalizers. Drain failures identify every unverified holder and fail
shutdown; a hard shutdown deadline remains unverified termination, never proof
that the native process or descendants died.

A parent's owned descendant set includes pending startups before their first
asynchronous probe. Parent release aborts those starts and waits for startup
settlement and native termination before reporting tree cleanup. A holder
incarnation cannot be admitted twice while its earlier lifetime remains owned.

Native admission additionally requires a single-use receipt from
`createMxcExtensionAdmission()`. Its actual-request probe observes a separate
request snapshot. Mutation of that snapshot, the production request or the
captured boot plan during readiness rejects admission. A private receipt map
binds the full canonical request, including the held proxy endpoint, to the
captured holder object, the `executableIdentity` and the exact boot-plan object.
`executableIdentity` is a digest of the admitted executable's (`spec.command`)
canonical path, volume and file ID, size and timestamps. It is measured
synchronously at admission and re-measured synchronously in `beforeSpawn`; a
change refuses creation. It is not a content hash: hashing a large runtime per
spawn cannot be synchronous at the spawn boundary, and an earlier draft hashed
the host's own Electron instead of the admitted executable. A same-size rewrite
can restore settable timestamps, so admission also refuses any executable inside
any live holder's writable root, the new holder's own planned writable roots
included. Among extension holders, only the signed-in user, outside this
contract's threat model, can then change the executable between admission and
spawn. Agent shell containers are not in that registry: a live MXC shell whose
writable workspace contains an extension executable could still rewrite it, so
holder adapters must not admit executables from a workspace (see the adapter
requirements below).
`consumeMxcExtensionAdmission()` runs at the native spawn boundary; a mismatch
or second use refuses the start and cannot retry the receipt. A globally ready
selection, a copied receipt or another holder's evidence cannot substitute.
The callback is trusted host probe implementation, never plugin-supplied proof;
its native observations still belong to the release gate.

Filesystem ownership is an independent host-captured
`MxcExtensionFilesystemOwnership` with read roots, write roots and host-only
storage roots. Every requested write grant and every final ranked readwrite grant
must lie inside a captured write root, inside or outside plugin namespaces, and
the holder's HOME and temp must lie inside them too. HOME and temp must not lie
below the shared private HOME, temp or handoff roots: an ancestor enumerate
grant there would list every other holder's leaf. Holder adapters (rows 3 and 5)
place them in a dedicated staging tree such as `<AVE_HOME>\mxc-staging\<opaque-id>`,
so the staging root's enumerate grant reveals only opaque IDs. The staging tree
still lives under the user profile, so its ancestor queries expose profile and
`AVE_HOME` sibling names; the plugins root also gets enumerate access above a
plugin's own data and generation roots, revealing other plugin IDs. Both are
disclosed residuals (`ancestorNameExposure`), not privacy guarantees; a location
outside the profile would need a separate owner decision. Requested grants cannot declare their own ownership. Admission
rejects grants at or above plugin, cache and private HOME/temp namespace roots,
another holder's roots,
write access to a read-only generation, and read or write grants intersecting
host storage. Both lexical and pinned canonical namespaces/ownership roots are
checked; the handoff callback rechecks their identities. Explicit literal read
denies equal to or above grants join the hard protected floor. Only exact shared
private/namespace masks may reopen this holder's admitted leaf roots; a deny
below such a mask remains hard. No host DACL is augmented.

Capability publication validates the serialized plan's complete field set,
closed states/reasons and fixed D2/D3 posture. Readiness, requested/selected
backend, selected-only fallback version and both outer egress identities must
agree. Withdrawing a backend clears its fallback version; deadline rejection
remains rejection when the runtime is absent.

Threat model for path substitution: the attacker is a confined co-holder, not
the signed-in user. The SDK opens string paths after the host's final identity
check, so a holder that can write above another holder's path can swap in a
junction or symlink in that interval. For example, a plugin child writing
`plugin\data` could redirect a worker's `data\models` grant toward Documents if
PSEC follows the reparse point when applying the grant. The host therefore
refuses a new holder when any of its read, write or deny grants, cwd, HOME, temp
or executable lies strictly inside another live holder's writable root, the
parent included, and symmetrically when its writable root would contain a live
holder's paths, so the outcome does not depend on admission order. Every path is
compared in its lexical and canonical spelling; a path that does not exist yet is
canonicalized through its longest existing ancestor. Equal roots are permitted
only when no deny or demoted path lands strictly inside the other holder's root,
because write roots are pinned and cannot be replaced by their holder. HOME and
temp never share: HOME or temp equal to or inside another live holder's writable
root is refused. Live footprints stay registered from admission until verified
termination, including quarantined holders, and the check runs at admission and
again synchronously in `beforeSpawn`.

The registry covers extension holders admitted through `spawnMxcConfinedChild`
only. Agent shell containers (`prepareMxcShellLaunch`, outside this slice) are
not registered: a live shell with write access to the workspace can still race
substitutions of any extension path inside that workspace. The nesting guarantee
therefore does not extend to workspace paths while an agent shell runs.

Every production native extension spawn goes through `spawnMxcConfinedChild`.
`spawnMxcExtensionProcess` requires its admission callback (`beforeSpawn`) and
refuses a call without it; a structural test pins its callers to
`confined-child.ts`. The packaged owned-process verification entry uses the
separately named, diagnostic-only `spawnMxcExtensionProcessForDiagnostics`, which
is bundled only into an explicit, never-published native verification build.

Hard requirements for holder adapters (rows 3–5):
- Sibling roots are mandatory. A descendant, delegated worker or bundled helper
  never receives a root inside its parent's or caller's writable roots. Production
  ranking places floor denies (such as a `.git` control) below writable roots, so
  even an exactly equal root is refused in practice; HOME and temp are never
  shared.
- A caller's exact plan cannot be passed through. A bundled helper or descendant
  that receives the caller's admitted plan unchanged lands its `.git` floor deny,
  HOME and temp inside the caller's live root and is refused. The adapter must
  admit the helper with its own sibling roots, or run it within the caller's own
  holder instead of as a second holder.
- Workspace-holder concurrency is limited. Two holders whose write grants cover
  the same workspace (for example two delegated workers on one workspace) cannot
  both be live: the second is refused while the first is owned. Serialize such
  holders, or give each a disjoint root.
- HOME/temp go in `<AVE_HOME>\mxc-staging\<opaque-id>`, inside the holder's
  captured write roots.
- Executables come from installation or generation roots, never from a workspace
  or any holder-writable root.

Confined child DLL search from cwd/PATH is not host-hardened; PSEC behavior is
native-unverified. The request forwards `PATH` (`FORWARD_ENV_KEYS`), and a Node
holder's entry script and its modules sit outside the executable rule above. A
DLL planted in the cwd, a `PATH` directory or a holder-writable root may be
loaded by the confined child. That stays within the child's own confinement but
is not prevented by the host; the native release gate must observe it.

This narrows the raw-path interval but does not remove it: it is not a
handle-relative launch, and it does not protect against the signed-in user
replacing installation or admitted paths. Refusal of reparse substitution of
grant paths is a required readiness observation and native release-gate test.
Native traversal, root replacement, host/supervisor crash and descendant-death
acceptance remain required too; no source-only test establishes them.
