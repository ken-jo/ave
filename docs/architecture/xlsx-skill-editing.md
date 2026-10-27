# XLSX editing

The shipped `xlsx-edit` [skill](../../resources/skills/xlsx-edit/SKILL.md) edits
existing XLSX cells through the ordinary approved sandbox shell. The document
panel is a read-only live view of agent edits. The host observes and renders;
it has no document edit IPC, write token, staging editor or publication broker.
The read and open tools retain their [existing contracts](agent-document-tools.md).
The [observation contract](architecture.md#agent-activity-observation) owns
session binding, source adapters, events, resource caps and local-only privacy.

## Execution and delivery

Directory skill instructions ship under `resources/skills`; user skills and
installed packages retain their existing precedence. Loading a skill passes
normal approval and resource-containment checks and grants no workbook-writing
authority. The executable script ships separately, so a user-shadowed skill
cannot issue trusted runtime roots.

[`src/skills/xlsx-edit.ts`](../../src/skills/xlsx-edit.ts) and its CLI are bundled
into `dist/skill-scripts/edit-xlsx.cjs`; packaged builds copy it to
`<host resources>/skill-scripts`. The adjacent `manifest.json` records version 1
and each script's SHA-256. Build and test preparation generate these assets from
installed dependencies, with no runtime package lookup or installation. The
bundle uses `jszip` under its MIT option, `fast-xml-parser` under MIT, and runtime
builtins. The existing `xlsx` preview dependency is Apache-2.0 CE; its commercial
extensions are excluded, and the preview package is not the editor's serializer.

The host advertises `javascriptRuntime` and `bundledScriptsDirectory` in
**Application paths (JSON)**. The runtime is `process.execPath` with
`ELECTRON_RUN_AS_NODE=1`; the skill gives the exact POSIX and Windows PowerShell
commands. Neither PATH lookup nor another interpreter supplies this contract.
Missing paths, an unverified bundle or unavailable confinement blocks the skill
edit; it never retries outside the sandbox.

The host generation pins the canonical script directory's identity and manifest
hash. Replacing the directory or changing both a script and its manifest does not
create new authority; activating rebuilt resources requires a new host generation.
Runtime/script execution roles require the exact runtime mode and reject
code-loading environment overrides. PowerShell uses the documented single
mode-assignment prefix and one literal native command.

The [shell policy](permission-policy-design.md#os-shell-sandbox-policy) grants
read roles only to the exact host runtime and verified first script operand.
Workbook/request operands and redirections retain ordinary path, permission and
approval checks. Runtime reads are bound to that invocation, cannot pierce
protected read floors, and add no write roots. The host script directory remains
write-denied even inside an admitted workspace. The child writer opens its
request, workbook, sibling backup and sibling temporary files within the shell's
admitted write roots. Opening a preview or observing a change supplies no write
grant and never bypasses agent approval.

## Live view and trust path

An admitted model turn and authorized tool invocation supply the session, turn
and tool-call identity. Successful agent `open_document` acknowledgements bind
exact documents to that session's visible app window. An exact native mutation
or bound skill journal can also identify an agent edit to a file the user already
has open. User-opened-only files create no filesystem watch. The observer never
enumerates or watches a whole workspace, and it records no user browser, terminal
or document activity.

Filesystem notifications only wake reconciliation. Native file-tool mutations
supply their expected post-image; the skill's journal supplies a completion
digest. Before emitting an attributed file delta, the observer requires the
pre-image digest to match the last acknowledged rendered snapshot or the head of
an unbroken admitted before/after digest chain rooted in that snapshot, and the
settled file to match the expected post-image. Consecutive agent saves can extend
that chain before the renderer acknowledges a prior snapshot; cell comparisons
still use the last acknowledged rendered table. A coincident tool call is insufficient
writer evidence. Unverified changes do not become agent content events; the
read-only viewer remains available for an explicit reload.

The replaceable document engine parses admitted workbook bytes through the existing
bounded table-reader child. The optional [conversion engine](document-observation-engine.md)
first recalculates a private copy when installed. An absent installation retains
the cached-value reader and recalculation signal; integrity, confinement, parse
and contract failures remain explicit errors. The same document adapter handles
verified native text and structured page-document saves without changing the
workbook journal's cell-only format. Browser and terminal adapters remain outside
this contract.

Preview reads, observation acknowledgements and event delivery require a live
registered app-window main frame in the default session. The host rechecks that
identity and session ownership before delivery. An embedded webview, plugin
partition, subframe or unregistered window gains no authority by navigating to an
app asset URL. Observation acknowledgements carry only a host-issued read-only
target identity and sequence, never a document path, script or write payload.
They are private renderer IPC and excluded from public transports and tools.

The grid highlights advisory cell changes as journal records arrive. A verified
save replaces that overlay with the actual parsed workbook, even when journal
cell text disagrees with the saved file, and refreshes the recalculation badge.
The comparison baseline advances only after the renderer acknowledges its
snapshot. Reloading establishes a fresh baseline. Changing the document, sheet
or session, closing the panel, losing the owning frame or shutting down disposes
its observation state. Errors and live-state labels use localized codes; raw
parser or child diagnostics are not displayed. The panel has no cell editor or
save action, so it asks no modification confirmation.

The [shared viewer presentation](architecture.md#agent-activity-observation) uses
a single-line header, one agent live-strip slot and a compact metadata footer.
The current changed cell has an outline and Ave tag; earlier changes retain a
faint tint. The footer owns sheet dimensions, the recalculation badge and
truncation notices. Observation errors and resynchronization occupy the strip,
and idle user-only previews show no live status. File/code previews share this
presentation for native line changes; page previews show structured element
changes only after the same verified-save attribution.

## Edit journal

For a confined agent shell, `AVE_DOCUMENT_JOURNAL` names the host-selected
`<isolated HOME>/document-observation/journal.jsonl`. This existing private shell
HOME is the invocation's action directory, not new workbook write authority.
The host binds it to the admitted tool call and session. A journal path from
renderer input or journal contents cannot select another directory or file.
An unconfined or broker route without that isolated directory has no live journal.

The skill appends version-1 UTF-8 JSON Lines. `begin` carries an `editId`, canonical
`target` and source `beforeHash`; each `cell` carries the same `editId`, `sheet`,
A1 `cell`, `before` and `after` display strings; `commit` carries `editId` and the
published workbook's `afterHash`. Hashes are lowercase SHA-256 hex. The host
supplies event actor, session, target identity, sequence and timestamp rather than
trusting those claims from the journal. The [shared journal contract](../../src/shared/document-edit-journal.ts)
validates record shapes.

Journal limits are defined in the [observation contract](architecture.md#agent-activity-observation).
The tail reader retains an incomplete last line until a newline arrives and
refuses truncation, replacement, links, malformed or excessive data. A record can
address only a host-known document or an exact already-rendered file in the same
session. Journal text is advisory display data and grants no file-read or write
authority. The file-save diff remains the truth. Failure or cancellation clears
provisional overlays; the observer never presents an unfinished journal as a saved
workbook. Journals and observation buffers are local, ephemeral data and are not
sent to providers, telemetry, transcripts or remote surfaces.

A configured journal failure before publication refuses the edit. If appending
or syncing the completion record fails after atomic publication, the CLI exits
with code 2 and reports `XLSX edit saved with observation error: Workbook was
saved, but the edit journal could not be completed.` The file was saved; retrying
as though publication failed would be incorrect. This outcome makes observation
unavailable and never triggers a second document write. Ordinary refusals exit 1.

## Preservation and refusals

The editor admits ordinary XLSX packages within the [edit limits](../../src/shared/xlsx-edit.ts),
bounds ZIP entry count and expanded bytes, validates XML without DTD/entity
declarations, and applies a bounded batch of replacements to distinct existing
cells in one selected sheet. The [editor](../../src/skills/xlsx-edit.ts) owns
package admission and batch limits. It keeps style indices, replaces cell values
with inline strings or typed scalars, and writes formulas without cached results.
It patches byte ranges in the selected sheet and workbook XML rather than
serializing those complete XML trees. Unrelated uncompressed member bytes remain
identical, including styles, shared strings, other sheets, drawings, images,
charts and pivot definitions. These parts are preserved, not evaluated or
refreshed. ZIP framing/compression and extra metadata are not a byte-preservation
contract. Rich text in an explicitly replaced cell becomes the requested plain
text; old shared-string entries may be unused.

The writer refuses signed, encrypted and macro packages; protected/table-managed
target sheets; shared/array/data-table formulas in that sheet; merged target cells;
unknown target-cell attributes or children; ambiguous paths/members; invalid edits;
and malformed or over-budget input. It supports the transitional spreadsheet
namespace. New cells, row/column/sheet operations, style edits and other workbook
formats are outside its contract. A refused workbook is never rewritten using a
more lossy serializer.

## Recovery and publication

Only the sandboxed skill editor builds, validates and publishes the output. Its
[file transaction](../../src/skills/xlsx-file-transaction.ts) compares the captured
source identity and bytes before backup and again before replacement. It pins and
rechecks the canonical parent identity and refuses uncertain identities, linked
sources or observed link substitutions. The host observer imports no workbook
publisher and never changes the source or backup.

The source and complete edited output must fit the 20 MiB ceiling. For source
bytes strictly above the 8 MiB backup threshold, the writer creates an exclusive
temporary file in the workbook's directory, writes the recovery bytes, calls
`fsync`, and verifies their length and SHA-256. Only then does an exclusive hard
link publish `<path>.ave-bak`. An existing final path, including a partial backup
or dangling link, refuses the edit without overwriting the recovery copy or
workbook. A failed temporary backup is removed; retry can succeed when no final
backup was published. Files at or below the threshold have no automatic backup.
A filesystem that cannot publish the hard link refuses rather than weakening
this rule.

A later edit above the threshold also refuses while that recovery path exists.
The recovery copy must be preserved or moved separately before retrying; neither
the skill nor observer automatically removes or rotates it.

Output is flushed and synced to an exclusive sibling temporary file, then
atomically replaces the source after those comparisons. Failure removes the
temporary file, and a completed backup remains. These path-based checks detect
observed conflicts but do not provide directory-handle-relative replacement or
filesystem compare-and-swap. Another same-user process can still race the final
checks and filesystem calls, including by replacing a parent; this is not an
interprocess locking protocol or power-loss transaction. A locked workbook on
Windows can refuse replacement. Shell edits remain outside native file-tool
checkpoints and rewind.

## Recalculation signal

Every successful edit sets workbook `calcPr` attributes `fullCalcOnLoad="1"`,
`forceFullCalc="1"`, `calcCompleted="0"`, and `calcMode="auto"`. Even a literal
change can invalidate a formula on another sheet, so no dependency inference or
formula-presence heuristic is used. Formula cells may be overwritten. An obsolete
calculation chain is removed along with its relationship and content-type entry;
an application rebuilds it on recalculation. Existing calculation settings such
as iteration limits remain intact.

The bounded container reader reads explicit calculation attributes only from a
direct SpreadsheetML main-namespace `workbook/calcPr` element in the admitted
workbook part. Default and prefixed namespaces, predefined/numeric attribute
entities and XML attribute whitespace normalization are supported;
foreign-namespace or nested extension elements do not set the signal, and custom
entity declarations remain refused. The required `needsRecalculation` boolean
travels through the existing preview response and each live snapshot; it is false
for other formats. Any true `fullCalcOnLoad`/`forceFullCalc` or explicit false
`calcCompleted` shows the localized **재계산 필요 / Needs recalculation** badge.
This is a conservative request signal, not proof that every cached value is
wrong. Standard in-file attributes travel with a renamed, copied or transferred
document and can be cleared by a recalculating application. The optional engine
is downloaded separately from the app package.

The workbook requests automatic full recalculation on next open by a compatible
spreadsheet application. Without the optional engine, the viewer can display old
dependent caches and empty new-formula results. When the engine is installed,
recalculation produces a temporary workbook whose bounded parsed values replace
those caches in the panel. Success clears the panel's recalculation signal only
for that recalculated result; the source workbook and its calculation attributes
remain unchanged. A conversion error is visible and does not silently display
old caches as recalculated. The ko/en keys live in the actual `chatPreviewRail`
message fragment.

## Native validation

Skill integration exercises ordinary shell path policy and the native wrapper on
macOS, Linux and Windows without blanket platform skips; its Windows command uses
the confined PowerShell route. The existing host prerequisite probe permits a
reason-bearing per-test skip only for the recognized unsupported
`appcontainer-dacl` tier and logs the actual tier. Unknown tiers,
launcher-integrity errors, broken probes, and native startup or editing failures
remain failures. The product still requires `base-container`.

Policy/launcher fixtures and capability skips cannot establish native execution.
Host probe and native execution evidence must be recorded before claiming a
platform verified; passing a build or fixture suite does not supply it.
Observation coverage additionally checks agent-only admission, journal bounds and
path containment, saved-file reconciliation, read-only rendering, registered-frame
delivery and the explicit engine-absent fallback.
