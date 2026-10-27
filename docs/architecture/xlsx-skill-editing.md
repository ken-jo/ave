# XLSX skill editing

The shipped `xlsx-edit` [skill](../../resources/skills/xlsx-edit/SKILL.md) edits
existing XLSX cells through the ordinary sandbox shell. It adds no callable host
tool, IPC channel, privileged workbook writer or panel cell editor. The read and
open tools retain their [existing contracts](agent-document-tools.md).

## Execution and delivery

Directory skills ship under `resources/skills` and are read in place from the
configured host resource root. User skills and installed packages take precedence.
Flat templates keep their existing seeding behavior. Directory skill bodies and
resource manifests pass the normal `skill_load` hash-bound approval and
`skill_read` containment checks; script execution still requires the shell's own
permission and OS sandbox admission. No workbook-writing authority comes from
loading a skill. No extension-specific branch is involved.

The script uses Python's standard `zipfile` and `xml.parsers.expat` libraries
(PSF-2.0; no new third-party dependency or copied external skill text). It runs on
macOS, Windows and Linux with Python 3.10+. The skill describes using a ready
interpreter or the bundled `uv` runtime with writable project/temp caches when an
interpreter must be provisioned. Provisioning can require sandbox-approved network
access; offline systems need a ready interpreter. It does not install packages or
retry outside the sandbox. The writer opens only its request, workbook, sibling
backup and sibling temporary file; the OS sandbox remains the authority boundary.
It cannot edit files outside admitted write roots.

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
more lossy serializer. The existing `xlsx` preview dependency is Apache-2.0 CE;
the separately licensed Pro styling/image/chart/pivot authoring capabilities are
not included or required by this editor.

## Recovery and commit

The command builds and validates the complete output before touching the source.
For source bytes strictly above 8 MiB, it exclusively creates `<path>.ave-bak`,
flushes and syncs it, and verifies its exact bytes before replacement. An existing
backup, including a link, refuses the edit and preserves that recovery copy. A
backup failure leaves the workbook unchanged; a partial backup can remain for
inspection and prevents automatic retry. Smaller files have no automatic backup.

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

The existing bounded container reader reads explicit calculation attributes from
the admitted workbook part and sends the required boolean `needsRecalculation`
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
