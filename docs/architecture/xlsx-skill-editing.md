# XLSX editing

The shipped `xlsx-edit` [skill](../../resources/skills/xlsx-edit/SKILL.md) edits existing XLSX cells through the ordinary sandbox shell. The [table preview](table-document-preview.md) also offers an explicitly enabled existing-cell value editor through private renderer IPC. Both use the same hash-pinned bundled editor and [file transaction](../../src/skills/xlsx-file-transaction.ts); the panel adds no agent-callable workbook tool. The read and open tools retain their [existing contracts](agent-document-tools.md).

## Execution and delivery

Directory skill instructions ship under `resources/skills`; user skills and installed packages retain their existing precedence. Loading a skill passes normal approval and resource-containment checks and grants no workbook-writing authority. The executable script is delivered separately, so a user-shadowed skill cannot issue trusted runtime roots.

[`src/skills/xlsx-edit.ts`](../../src/skills/xlsx-edit.ts) and its CLI are bundled into the standalone CommonJS file `dist/skill-scripts/edit-xlsx.cjs`; packaged builds copy it to `<host resources>/skill-scripts`. The adjacent `manifest.json` records version 1 and each script's SHA-256. Build and test preparation generate these assets from installed dependencies, with no runtime package lookup or installation. The bundle uses `jszip` under its MIT option and `fast-xml-parser` under MIT, plus runtime builtins. The existing `xlsx` preview dependency remains Apache-2.0 CE and is not the editor's serializer.

The host advertises `javascriptRuntime` and `bundledScriptsDirectory` in **Application paths (JSON)**. The runtime is `process.execPath` with `ELECTRON_RUN_AS_NODE=1`; the [skill](../../resources/skills/xlsx-edit/SKILL.md) gives the exact POSIX and Windows PowerShell commands. Neither PATH lookup nor another interpreter supplies this contract. Missing paths, an unverified bundle or unavailable confinement blocks this skill's edit; it never retries outside the sandbox.

The host generation pins the canonical script directory's identity and the manifest hash. Replacing the directory or changing both a script and its manifest does not create new authority; activating rebuilt resources requires a new host generation. Runtime/script execution roles require the exact runtime mode and reject code-loading environment overrides. PowerShell uses the documented single mode-assignment prefix and one literal native command.

For agent skill calls, the [shell policy](permission-policy-design.md#os-shell-sandbox-policy) grants read roles only to the exact host runtime and verified first script operand. Workbook/request operands and redirections retain ordinary path and permission checks. Runtime reads are bound to that invocation, cannot pierce protected read floors, and add no write roots. The host script directory remains write-denied even inside an admitted workspace. The writer opens its request, workbook, sibling backup and sibling temporary files within the shell's admitted write roots. Loading the skill or opening a preview does not supply those write grants.

## Panel authority and execution

The host issues an opaque edit token only for the latest successful XLSX preview of one authenticated frame, bound to its captured source bytes, descriptor identity, canonical file and selected sheet. This token identifies a read; it grants no write authority. A replacement read, committed navigation, frame detachment or sender destruction invalidates the old token. Release is token-specific and cannot revoke a newer preview. Tokens are not exposed in parser-child results or public transports.

The user must choose **Enable editing** before the panel requests approval. The host validates the owning frame and presents a native confirmation parented to its window, naming the canonical full path. Consent covers only that token's file and sheet. A renderer can request this confirmation but cannot grant itself another target. The host rechecks current file-read scope and the protected read floor through `protectedReadDenyCovering`. The same path matcher checks both the original workbook and its derived backup against `getDefaultSensitiveWriteDenyPaths`; a general sensitive-path classification alone is insufficient. Native consent cannot bypass those floors or unavailable confinement. Panel requests have only an action, token, absolute cell coordinates where needed, and a scalar value for save. The [shared edit contract](../../src/shared/xlsx-panel-edit.ts) validates exact request shapes and rejects extra fields, including paths, sheet indexes, scripts, environment or source bytes. User document edits are audited as user actions, separately from agent calls.

Each token permits one active operation, with bounded host-wide work and no overlapping native confirmation for that token. The host inspects or edits a private staging workbook with the same pinned `edit-xlsx.cjs` used by the skill. The [action-directory helper](../../src/permissions/sandbox-action-directory.ts) creates a live host-owned capability below `appOwnedSandboxActionRoot` in the existing sandbox namespace, rather than an ambient temporary directory. Default sandbox read/write denies protect this root on every supported platform, including from another confined principal with a broad parent grant. Host file tools also apply dynamic private-path read/write guards. A path string alone cannot confer access: the runner's `actionDirectory` exception requires both a live host-created action directory and a `user-document` invocation owner. It grants only that action's staging scope; other actions remain protected.

The [bundled script runner](../../src/main/bundled-script-execution.ts) supplies fixed workbook/request locations, the operation, a filtered environment and the verified runtime/script. The child may write only its own staging, private home and temporary scope; it receives no source-directory write grant. Existing native confinement wrappers, shared timeout/cancellation policy and managed descendant cleanup apply, with no unconfined retry. Abort waits for process closure only within the shared cleanup deadline. If closure or descendant termination cannot be proved, the action fails without publication and retains the private directories and their ownership; deferred cleanup releases them only after termination is observed. The host validates the fixed child output and its size only after successful child and descendant cleanup.

An exact-file sandbox grant cannot authorize sibling staging and atomic replacement on Linux. The panel therefore uses a host publication broker: the shared publisher may write only the bound workbook, its derived recovery path and exclusive sibling temporary names. These paths are host-derived publication authority, never renderer or child authority. This broker does not grant the agent a broader shell scope. It uses the same backup and atomic publication implementation as the skill, rather than a second workbook writer.

## Panel interaction

After explicit enablement, double-click or Enter opens a draft for one existing cell. Inspection uses the bundled editor's package and sheet admission, returning the raw `string`, `number`, `boolean` or `null` value plus a formula flag. The clipped display grid is never the draft's source. Text drafts retain raw CR and CRLF spellings outside the edited interval while mapping the textarea's normalized newlines back to that raw text. Missing cells and unsupported structures are refused. The user selects text, number, boolean or empty; text remains literal even when it starts with `=`. The panel does not accept formula source or offer formula authoring. An existing formula may be replaced with a value after showing the overwrite hint; the skill's separate formula input remains available through its own permission path.

Enter saves outside composition, Escape cancels, and blur never silently saves. Saving disables conflicting edits and shows a visible result. Success refreshes the preview and recalculation badge. Only the automatic refresh following that save may inherit consent, rebound by the host to the same frame, file, sheet and revision it just published. Manual reload requires new enablement. A stale source identity or changed bytes refuses the operation and clears editing authority. The user must reload and enable editing again. Target changes and unmounting release the old token and ignore its late asynchronous replies. Errors use localized codes rather than raw child diagnostics.

Atomic replacement is the save commit point. The publisher rechecks the active binding before backup and immediately before replacement; cancellation observed before replacement refuses publication. A completed replacement remains a successful save even if subsequent refresh or consent rebinding fails. The panel keeps the saved result visible, reports refresh failure separately and requires a new read and enablement before another edit. Late cancellation cannot undo an already published workbook.

## Preservation and refusals

The editor admits ordinary XLSX packages within the [shared edit limits](../../src/shared/xlsx-panel-edit.ts), bounds ZIP entry count and expanded bytes, validates XML without DTD/entity declarations, and applies a bounded batch of replacements to distinct existing cells in one selected sheet. The [editor implementation](../../src/skills/xlsx-edit.ts) owns package admission and batch limits; the shared edit contract owns file, backup and panel scalar limits. It keeps style indices, replaces cell values with inline strings or typed scalars, and writes formulas without cached results. It patches byte ranges in the selected sheet and workbook XML instead of serializing those complete XML trees. Unrelated uncompressed member bytes remain identical, including styles, shared strings, other sheets, drawings, images, charts and pivot definitions. These parts are preserved, not evaluated or refreshed. ZIP framing/compression and extra metadata are not a byte-preservation contract. Rich text in an explicitly replaced target cell becomes the requested plain text; old shared-string entries may be unused.

The writer refuses signed, encrypted and macro packages; protected/table-managed
target sheets; shared/array/data-table formulas in that sheet; merged target cells;
unknown target-cell attributes or children; ambiguous paths/members; invalid edits;
and malformed or over-budget input. It supports the transitional spreadsheet
namespace. New cells, row/column/sheet operations, style edits and other workbook
formats are outside its contract. A refused workbook is never rewritten using a
more lossy serializer.

## Recovery and publication

Both execution paths build and validate the complete output before touching the source, then call `publishWorkbookEdit` in the [shared file transaction](../../src/skills/xlsx-file-transaction.ts). The publisher compares the captured source identity and bytes before backup and again before replacement. It pins and rechecks the canonical parent identity and refuses uncertain identities, linked sources or observed link substitutions.

For source bytes strictly above `XLSX_EDIT_LIMITS.backupBytes`, the publisher creates an exclusive temporary file in the workbook's directory, writes the recovery bytes, calls `fsync`, and verifies their length and SHA-256. Only then does an exclusive hard link publish `<path>.ave-bak`. An existing final path, including a partial backup or dangling link, refuses that edit without overwriting the recovery copy or workbook. A failed temporary backup is removed; retry can succeed when no final backup was published. Files at or below the threshold have no automatic backup. A filesystem that cannot publish the hard link refuses the edit rather than weakening this rule.

A later edit above the threshold also refuses while that recovery path exists. The user must preserve or move the recovery copy separately before retrying; the panel never removes or rotates it automatically.

Output is flushed and synced to an exclusive temporary file in the workbook's directory, then atomically replaces the source after those comparisons. Failure removes the temporary file, and a completed backup remains. These path-based checks detect observed conflicts but do not provide a native directory-handle-relative replacement or filesystem compare-and-swap. Another process running as the same user can still race the final checks and filesystem calls, including by replacing a parent; this is not an interprocess locking protocol or a power-loss transaction. A locked workbook on Windows can refuse replacement. Both editing paths are outside native file-tool checkpoints and rewind.

## Recalculation signal

Every successful edit sets workbook `calcPr` attributes `fullCalcOnLoad="1"`,
`forceFullCalc="1"`, `calcCompleted="0"`, and `calcMode="auto"`. Even a literal
change can invalidate a formula on another sheet, so no dependency inference or
formula-presence heuristic is used. Formula cells may be overwritten. An obsolete
calculation chain is removed along with its relationship and content-type entry;
an application rebuilds it on recalculation. Existing calculation settings such
as iteration limits remain intact.

The existing bounded container reader reads explicit calculation attributes only
from a direct SpreadsheetML main-namespace `workbook/calcPr` element in the
admitted workbook part. Default and prefixed namespaces, predefined/numeric
attribute entities and XML attribute whitespace normalization are supported;
foreign-namespace or nested extension elements do not set the signal, and custom
entity declarations remain refused. It sends the required boolean `needsRecalculation`
through the existing preview response. The protocol validates the field and
requires false for other formats. Any true `fullCalcOnLoad`/`forceFullCalc` or
explicit false `calcCompleted` shows the localized **재계산 필요 / Needs
recalculation** badge. This is a conservative request signal, not proof that
every cached value is wrong. A sidecar would lose the signal after rename, copy,
or transfer; the standard in-file attributes travel with the document and can be
cleared by the recalculating application. No formula engine is bundled.

The workbook requests automatic full recalculation on next open by a compatible spreadsheet application. Until it recalculates and saves, the viewer can display old dependent caches and empty new-formula results. The panel refreshes after its own save. Already-open previews must be reloaded after shell edits; live file watching is outside this contract. The ko/en keys live in the actual `chatPreviewRail` message fragment, with no raw parser diagnostics exposed in the renderer.

## Native validation

Skill integration exercises ordinary shell path policy and the native wrapper on macOS, Linux and Windows without blanket platform skips; its Windows command uses the confined PowerShell route. Panel integration exercises the host staging runner and publication broker separately. The existing host prerequisite probe permits a reason-bearing per-test skip only when it recognizes the unsupported `appcontainer-dacl` tier; the actual tier is logged. Unknown tiers, launcher-integrity errors, broken probes and native startup or editing failures remain failures. The product still requires `base-container`. Simulated policy/launcher fixtures and capability skips cannot establish native execution. Host probe and native execution evidence for the relevant route must be recorded before claiming that platform verified; a passing build or fixture suite does not supply it.
