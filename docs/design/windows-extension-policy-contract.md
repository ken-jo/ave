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
| `checking` | `none` | Refuse until the bounded readiness queue settles. |
| `ready` | `mxc` | Refuse legacy transport; only the explicit native entry may proceed. |
| `fallback` | `srt-win` | Retain existing pinned account-backed admission and release. |
| `unavailable` | `none` | Preserve settled initial degraded-host behavior and privacy/approval checks; no confinement relaxation. |
| `rejected` | `none` | Refuse; a deadline rejection cannot become an unconfined start. |

The native entry always requires `ready` plus `mxc`. A checking record
is not permission to run and the synchronous guard itself does not queue.
The caller awaits the readiness resolver before retrying admission.

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
startup, query ancestors, standard-stream round trip, clean termination, and
endpoint isolation with correct forged-label attribution and no worker port.
A launcher-only shell result supplies none of that extension evidence.

On deadline or settled host unavailability, fallback requires version `0.0.80`,
ready in the current boot/session, and no admitted holder or ancestor. The
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
plan rejects legacy adapters with `worker-transport-unsupported`; the native
entry opts in with `{ backend: "mxc" }` and rechecks readiness. This generic
transport guard preserves unmigrated worker refusal without plugin-ID routing.

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
captured holder object, host-measured runtime SHA-256 and exact boot-plan object.
`consumeMxcExtensionAdmission()` runs at the native spawn boundary; a mismatch
or second use refuses the start and cannot retry the receipt. A globally ready
selection, a copied receipt or another holder's evidence cannot substitute.
The callback is trusted host probe implementation, never plugin-supplied proof;
its native observations still belong to the release gate.

Filesystem ownership is an independent host-captured
`MxcExtensionFilesystemOwnership` with read roots, write roots and host-only
storage roots. These independently captured roots must include the holder's own
HOME and temp leaves. Requested grants cannot declare their own ownership. Admission
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

Identity revalidation narrows substitution opportunities but does not remove
the raw-path interval between the final check and native path consumption. It
is not a handle-relative filesystem launch or protection against the signed-in
user racing replacement of installation or admitted paths. Native traversal,
root replacement, host/supervisor crash and descendant-death acceptance remain
required; no source-only test establishes those properties.
