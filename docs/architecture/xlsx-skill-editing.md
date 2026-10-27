# XLSX skill editing

The shipped `xlsx-edit` [skill](../../resources/skills/xlsx-edit/SKILL.md) edits
existing XLSX cells through the ordinary sandbox shell. It adds no callable host
tool, IPC channel, privileged workbook writer or panel cell editor. The read and
open tools retain their [existing contracts](agent-document-tools.md).

## Execution and delivery

Directory skill instructions ship under `resources/skills`; user skills and installed packages retain their existing precedence. Loading a skill passes normal approval and resource-containment checks and grants no workbook-writing authority. The executable script is delivered separately, so a user-shadowed skill cannot issue trusted runtime roots.

[`src/skills/xlsx-edit.ts`](../../src/skills/xlsx-edit.ts) and its CLI are bundled into the standalone CommonJS file `dist/skill-scripts/edit-xlsx.cjs`; packaged builds copy it to `<host resources>/skill-scripts`. The adjacent `manifest.json` records version 1 and each script's SHA-256. Build and test preparation generate these assets from installed dependencies, with no runtime package lookup or installation. The bundle uses `jszip` under its MIT option and `fast-xml-parser` under MIT, plus runtime builtins. The existing `xlsx` preview dependency remains Apache-2.0 CE and is not the editor's serializer.

The host advertises `javascriptRuntime` and `bundledScriptsDirectory` in **Application paths (JSON)**. The runtime is `process.execPath` with `ELECTRON_RUN_AS_NODE=1`; the [skill](../../resources/skills/xlsx-edit/SKILL.md) gives the exact POSIX and Windows PowerShell commands. Neither PATH lookup nor another interpreter supplies this contract. Missing paths, an unverified bundle or unavailable confinement blocks this skill's edit; it never retries outside the sandbox.

The host generation pins the canonical script directory's identity and the manifest hash. Replacing the directory or changing both a script and its manifest does not create new authority; activating rebuilt resources requires a new host generation. Runtime/script execution roles require the exact runtime mode and reject code-loading environment overrides. PowerShell uses the documented single mode-assignment prefix and one literal native command.

The [shell policy](permission-policy-design.md#os-shell-sandbox-policy) grants read roles only to the exact host runtime and verified first script operand. Workbook/request operands and redirections retain ordinary path and permission checks. Runtime reads are bound to that invocation, cannot pierce protected read floors, and add no write roots. The host script directory remains write-denied even inside an admitted workspace. The writer opens its request, workbook, sibling backup and sibling temporary files within the shell's admitted write roots.

## Preservation and refusals

The command admits ordinary XLSX packages up to 20 MiB, bounds ZIP entry count and
expanded bytes, validates XML without DTD/entity declarations, and applies at most
500 replacements to distinct existing cells in one selected sheet. It keeps
style indices, replaces cell values with inline strings or typed scalars, and
writes formulas without cached results. It patches byte ranges in the selected
sheet and workbook XML instead of serializing those complete XML trees. Unrelated
uncompressed member bytes remain identical, including styles, shared strings,
other sheets, drawings, images, charts and pivot definitions. These parts are
preserved, not evaluated or refreshed. ZIP framing/compression and extra metadata
are not a byte-preservation contract. Rich text in an explicitly replaced target
cell becomes the requested plain text; old shared-string entries may be unused.

The writer refuses signed, encrypted and macro packages; protected/table-managed
target sheets; shared/array/data-table formulas in that sheet; merged target cells;
unknown target-cell attributes or children; ambiguous paths/members; invalid edits;
and malformed or over-budget input. It supports the transitional spreadsheet
namespace. New cells, row/column/sheet operations, style edits and other workbook
formats are outside its contract. A refused workbook is never rewritten using a
more lossy serializer.

## Recovery and commit

The command builds and validates the complete output before touching the source. For source bytes strictly above 8 MiB, it creates an exclusive temporary file in the workbook's directory, writes the recovery bytes, calls `fsync`, and verifies their length and SHA-256. Only then does an exclusive hard link publish `<path>.ave-bak`. An existing final path, including a partial backup or link, refuses that larger-file edit without overwriting the recovery copy or workbook. A failed temporary backup is removed; retry can succeed when no final backup was published. Smaller files have no automatic backup. A filesystem that cannot publish the hard link refuses the edit rather than weakening this rule.

Output is flushed and synced to an exclusive temporary file in the workbook's
directory, then atomically replaced after source identity and byte comparisons.
Failure removes the temporary file, and a completed backup remains. Linked source
files are refused. A concurrent writer can still race the final comparison and
replacement; this is not an interprocess locking protocol or a power-loss
transaction. A locked workbook on Windows can refuse replacement. Shell edits are
outside native file-tool checkpoints and rewind.

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

The workbook requests automatic full recalculation on next open by a compatible
spreadsheet application. Until it recalculates and saves, the viewer can display
old dependent caches and empty new-formula results. Already-open previews must be
closed and reopened after shell edits; live file watching is outside this change.
The ko/en keys live in the actual `chatPreviewRail` message fragment, with no raw
parser diagnostics exposed in the renderer.

## Native validation

The editing integration runs ordinary shell path policy and the native wrapper on macOS, Linux and Windows without blanket platform skips. Windows uses the confined PowerShell route. The existing host prerequisite probe permits a reason-bearing per-test skip only when it recognizes the unsupported `appcontainer-dacl` tier; the actual tier is logged. Unknown tiers, launcher-integrity errors, broken probes and native startup or editing failures remain failures. The product still requires `base-container`. Simulated policy/launcher fixtures and capability skips cannot establish native execution. Windows host probe and native execution evidence must be recorded before claiming that platform verified; a passing build or fixture suite does not supply it.
