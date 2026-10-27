---
name: xlsx-edit
description: Edit existing XLSX cell values or formulas while preserving workbook formatting and unrelated package parts.
compatibility: Host-provided JavaScript runtime and bundled script through the sandbox shell; no runtime installation required.
---

# XLSX editing

Use this skill for requested changes to existing `.xlsx` cells. Read the workbook
with `read_document` first and identify its zero-based sheet index and A1 cell
addresses. CSV/TSV use ordinary text editing. Other workbook formats, new cells,
formatting changes, row/column operations and direct panel editing are outside
this skill.

Run the host's `edit-xlsx.cjs` through the sandbox shell. Read
`javascriptRuntime` and `bundledScriptsDirectory` from the environment's
**Application paths (JSON)** and substitute their absolute values in the commands
below. The script lives in that host-owned directory, independently of this
skill's base directory. Quote each path separately. Do not recreate the writer or
use a whole-workbook serializer.

Write a UTF-8 JSON request inside the project or temporary directory:

```json
{"sheet":0,"edits":[{"cell":"B4","value":150},{"cell":"C4","formula":"B4*2"}]}
```

Each edit has `cell` and exactly one of `value` (string, finite number, boolean or
null to clear) or `formula` (without leading `=`). At most 500 edits may target
distinct existing stored cell records; a blank-looking address with no stored
cell is a new cell and cannot be targeted. A string beginning with `=` stays text;
use `formula` only when the user intends a formula. Review the proposed values against the
request before running:

```sh
ELECTRON_RUN_AS_NODE=1 '<javascriptRuntime>' '<bundledScriptsDirectory>/edit-xlsx.cjs' '<project>/book.xlsx' '<project>/edits.json'
```

On Windows use PowerShell:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; & '<javascriptRuntime>' '<bundledScriptsDirectory>\edit-xlsx.cjs' '<project>\book.xlsx' '<project>\edits.json'
```

Use the exact advertised paths and direct script operand. Escape a literal
apostrophe in a path for the selected shell. The runtime and script are read-only;
the workbook and request still need ordinary path admission. The host verifies
the bundle and selects the confined route before execution. If the advertised
paths are missing or the shell reports failed verification or unavailable native
confinement, report that prerequisite and leave the workbook untouched. Never
install another runtime, download packages or request an unsandboxed retry.

The script admits files up to 20 MiB. Above 8 MiB it writes an exclusive
same-directory temporary backup, calls `fsync`, verifies its length and SHA-256,
then publishes `<workbook>.ave-bak` with an exclusive hard link. An existing final
backup, including a partial file or link, blocks that larger-file edit without
changing it or the workbook. Preserve that copy and ask the user to move it to
another recovery name before retrying. Failed temporary backups are removed; retry is possible
when no final backup was published. Smaller files do not get automatic recovery
copies. Shell edits are outside the host's checkpoint/rewind history.

Success writes JSON to stdout with `editedCells`, `needsRecalculation: true` and
`backup` (an absolute path or null). A nonzero exit reports a refusal on stderr.

The writer patches only target cells and calculation properties. It preserves
cell styles and every unrelated uncompressed package part, including drawings,
charts, images and pivot definitions. It removes an obsolete calculation chain
and its declarations. ZIP compression/container metadata may change; the workbook
is not byte-identical. Shared-string entries may become unused. Target-cell rich
text is intentionally replaced by the requested plain value.

It refuses signed/encrypted/macro workbooks, protected or table-managed target
sheets, shared/array/data-table formulas in the target sheet, merged target cells,
unknown target-cell metadata, malformed packages and resource-limit violations.
Do not bypass a refusal using another writer. Keep unrelated parts and report
the unsupported operation.

All successful edits request a full automatic recalculation on next open. Formula
overwrites are allowed. This script does not calculate formulas: dependent caches
can remain stale and new formulas have no cached result. The viewer shows
**재계산 필요 / Needs recalculation** from the workbook's calculation flags until
a spreadsheet application recalculates and saves it. Close and reopen an already
open preview after an edit; it does not watch shell writes. Re-read with
`read_document`, check the requested literal values, and report the edit count,
backup path when present, and pending recalculation. Never present cached formula
results as newly calculated.
