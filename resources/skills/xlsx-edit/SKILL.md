---
name: xlsx-edit
description: Edit existing XLSX cell values or formulas while preserving workbook formatting and unrelated package parts.
compatibility: Python 3.10 or later in the sandbox; no third-party packages required.
---

# XLSX editing

Use this skill for requested changes to existing `.xlsx` cells. Read the workbook
with `read_document` first and identify its zero-based sheet index and A1 cell
addresses. CSV/TSV use ordinary text editing. Other workbook formats, new cells,
formatting changes, row/column operations and direct panel editing are outside
this skill.

Run the bundled `scripts/edit-xlsx.py` through the sandbox shell. Resolve its
absolute path from this skill's base directory returned by `skill_load`. Quote
paths as individual shell arguments, including on Windows. Do not recreate the
writer or use a whole-workbook serializer.

Write a UTF-8 JSON request inside the project or temporary directory:

```json
{"sheet":0,"edits":[{"cell":"B4","value":150},{"cell":"C4","formula":"B4*2"}]}
```

Each edit has `cell` and exactly one of `value` (string, finite number, boolean or
null to clear) or `formula` (without leading `=`). At most 500 edits may target
distinct existing cells. A string beginning with `=` stays text; use `formula`
only when the user intends a formula. Review the proposed values against the
request before running:

```sh
python3 "<skill-base>/scripts/edit-xlsx.py" "<project>/book.xlsx" "<project>/edits.json"
```

On Windows use the available `python` executable instead. A ready interpreter
from the app's runtime can also be invoked by its absolute path. If none is
available, use the bundled `uv` executable with `run --no-project --no-sync
--python 3.12`; place `UV_CACHE_DIR` and `UV_PYTHON_INSTALL_DIR` in a writable
project or temporary directory, and set `UV_PYTHON_INSTALL_BIN=0`. Interpreter
provisioning may need allowed network access; if it fails, report that prerequisite
and leave the workbook untouched. Never request an unsandboxed retry.

The script admits files up to 20 MiB. Above 8 MiB it exclusively creates and
verifies `<workbook>.ave-bak` before replacing the workbook. An existing backup
blocks the edit; preserve it and ask the user to move it to another recovery
name before retrying. Smaller files do not get automatic recovery copies. Shell
edits are outside the host's checkpoint/rewind history.

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
