# Table document preview

The table viewer accepts CSV, TSV, XLSX, XLS and ODS files and displays a bounded grid of strings. [The shared preview contract](../../src/shared/preview-document.ts) owns supported formats, result types, error codes and every resource ceiling.

XLSX workbooks requesting recalculation show a localized badge because cached formula results may be stale. The [XLSX editing contract](xlsx-skill-editing.md) owns the calculation signal, preservation limits, sandbox execution and shared publication rules for skill and panel edits.

## Read authority

`ave:preview:read-document` is a private, host-renderer IPC channel. [The preview handler](../../src/ipc/domains/preview.ts) validates the sending frame and uses `assertReadableFilePath` from [the file-read core](../../src/tools/file-read-core.ts). Preview reads always check allowed roots. Native agent file reads instead use the invocation's existing file access policy, which can allow reads outside those roots when directory fencing is disabled. The channel grants no additional filesystem authority and is unavailable through public transports.

The main process checks the requested sheet index and extension, then acquires a request lease before [opening the admitted path once](../../src/tools/preview-document-input.ts). Regular-file status and size come from that descriptor. Reading stops at its checked size plus one byte; growth, shrinkage or a changed modification time refuses the read, and the descriptor closes on every outcome. A superseded read checks cancellation before allocating and after each filesystem operation; it waits for an operation already in progress to return. Child deadlines do not cover filesystem reads. Replacing the pathname after opening cannot redirect that read. Each request supplies a zero-based, non-negative sheet index; any other value returns `invalid-index` at the IPC boundary and again in the parse lease. CSV and TSV accept only index zero; workbook indexes must address the retained `sheetNames` list, so sheets beyond the tab limit cannot be selected. Successful reads use the existing audit logger with a redacted path. The renderer receives a parsed table result, never source document bytes or a parser handle.

## Editing authority

A successful XLSX preview opened by the user can additionally receive a host-issued opaque `editToken` bound to the latest read of that authenticated frame, canonical file, selected sheet and revision. The host retains the exact parsed source bytes and descriptor identity; the parser child never creates or receives the token. The token directly admits scalar cell actions for that bound workbook through the private panel API, with no general filesystem authority. Other formats remain read-only.

Panel editing has no enable step or confirmation prompt. Actions remain subject to current file-read scope, protected read floors, sensitive write denies for both source and backup, and available confinement. The existing private `ave:preview:edit-xlsx` channel accepts only the [shared edit request](../../src/shared/xlsx-panel-edit.ts): `cell`, `save` or `release`, a token, cell coordinates and a scalar where required. It cannot accept a path, script, environment or replacement workbook from the renderer. It is excluded from `PUBLIC_CHANNELS`, unavailable through public transports and not exposed through a tool bridge. The [XLSX editing contract](xlsx-skill-editing.md#panel-authority-and-execution) owns token lifecycle, the trusted renderer interaction boundary, separate agent shell approval, protected action-directory capabilities and exact-file host publication.

The panel edits existing cells with raw typed values returned by the pinned editor; formatted or clipped display strings do not initialize drafts. It offers literal text, number, boolean and empty values, with an explicit hint before overwriting a formula. It has no formula authoring or structural editing. Enter saves directly outside composition with visible saving/saved states, Escape cancels and blur does not save. Successful edits refresh the preview with a fresh token. Observed source identity or byte changes invalidate the token and require reload; manual reload obtains a fresh revision token without approval state. Changing file or sheet, leaving the frame or releasing the preview also retires its token. The [shared edit contract](../../src/shared/xlsx-panel-edit.ts) owns edit errors and limits separately from read/parse failures below.

## Parsing process and budgets

[The process owner](../../src/tools/preview-document-process.ts) grants a lease covering input reading, child startup, parsing, response validation and cleanup. A lease belongs to the authenticated sender and frame identity. A newer request from that frame supersedes its predecessor and kills its child, then waits for the old read to unwind and the child to close before admitting another read. Intermediate replaced requests never read source bytes. Sender destruction or a renderer crash, committed navigation of the owning frame, and observed frame detachment abort pending and admitted requests. Owner listeners and the detached-state watcher are removed on cancellation and in `finally`; the handler releases an admitted lease after cleanup on every outcome. Another frame receives `busy` before any source allocation. The renderer ignores `superseded` replies and retries `busy` on the bounded shared schedule while the component remains mounted with the same path and sheet. It shows the localized busy message only after exhausting that schedule; unmounting or changing the target cancels pending retry timers.

Each admitted parse runs in a disposable managed child with a filtered environment. [The child entry](../../src/tools/preview-document-child-main.ts) loads its modules, validates request arguments and writes a fixed ready marker before reading source bytes. The parent enforces a separate startup deadline through that marker; premature exit, malformed framing or startup expiry returns `read-failed`. Once ready, the parent starts the parse deadline and sends the source bytes through stdin. [The table reader](../../src/tools/table-document-reader.ts) runs only in the child. There is no in-process parsing fallback.

The child is bounded and killable, with a managed old-space ceiling through `--max-old-space-size`, startup and parse deadlines, and a bounded stdout response. The parent validates the child protocol and returned table in place, without cloning its grid. Both sides enforce the total returned-cell ceiling as well as row, column and serialized-byte ceilings. A successful response contains only the bounded display grid, sheet metadata and truncation flags.

The [shared preview limits](../../src/shared/preview-document.ts) are the sole policy source for heap, deadline, concurrency, response bytes, input bytes, archive expansion and displayed data. Exceeding a process budget terminates the child and returns an explicit failure. A child is managed for lifecycle cleanup; process separation and the heap flag do not establish filesystem confinement or a strict bound on all resident memory. Source buffers, parser intermediates and allocations outside the managed heap can require additional memory.

## Container admission

The filename extension selects the requested format; it does not prove the bytes have that format. [Workbook container preparation](../../src/tools/workbook-container.ts) validates the actual container before invoking the workbook parser:

- XLS requires the compound-file signature.
- XLSX requires its ZIP package and required workbook parts.
- ODS requires its ZIP package, document parts and spreadsheet media type.

[The ZIP guard](../../src/tools/zip-inflate-guard.ts) checks supported archive framing and local/central metadata consistency, then enforces entry count, actual inflated bytes and compression-ratio limits. The workbook parser receives only a canonical checked ZIP assembled from validated compressed member payloads with rewritten matching headers. Supported data descriptors are checked and removed along with extra fields and comments. The original unchecked archive never reaches the workbook parser.

Unsupported archive variants, including ZIP64, contradictory headers and nested ZIP members, are refused. The preview does not recursively unwrap archives to discover a workbook. Encryption remains an explicit refusal. A signature, claimed uncompressed size or filename alone cannot bypass container validation.

ODS repeated-row and repeated-column declarations are checked against the shared expanded-row and expanded-cell ceilings before a workbook-library call. Exceeding either ceiling refuses the document rather than attempting expansion and trimming the resulting grid afterward. Those expansion ceilings are separate from the row and column limits on displayed output.

## Display windows and delimited input

Workbook row and column windows start at the used range's first cell. The used range comes from the parser's `!fullref` when present, otherwise `!ref`. `firstRow` and `firstColumn` preserve that cell's zero-based source coordinates for labels; `totalRows` and `totalColumns` describe the used-range dimensions. A sheet whose reported range begins at `A10001` starts its preview there. Absolute row position must not turn an offset used range into an empty preview. A sheet without a reported range returns an empty grid with zero dimensions and origins.

The reader returns at most the shared row, column, total-cell and sheet limits, pads retained rows to a consistent width and clips long cells. A wider grid has a smaller row window to fit the total-cell ceiling. Truncation flags tell the viewer which limits removed data. Cells are display strings; formulas are not evaluated and macros are not executed.

CSV and TSV decode bytes lazily into bounded input chunks. Delimiter and line-ending detection use a bounded initial sample and one bounded look-ahead chunk. When more input follows, the sample must establish a complete initial record; an overlong initial record or ambiguous terminal carriage return is refused with `parse-limit`. Inspection stops after the retained row window plus the next record needed to establish truncation, with bounded chunk read-ahead; the source stream is destroyed on completion or failure. It does not decode the complete suffix or continue record scanning to compute whole-file totals after truncation. When inspection stops early, `totalRows` and `totalColumns` describe the observed prefix and are lower bounds for the complete file. The viewer selects lower-bound labels for both totals when the format is CSV or TSV and `sheet.rowsTruncated` is true; `columnsTruncated` independently reports width clipping. A fatal quoting error encountered in the inspected window returns `corrupt-document`; malformed quoting that requires parser repair is fatal. A successful prefix preview makes no validity claim about the uninspected suffix.

## Explicit failures

The shared error union and the renderer's localized mapping remain the response contract. Refusals preserve their cause:

| Error | Meaning |
| --- | --- |
| `unauthorized`, `path-not-allowed`, `sensitive-path`, `not-a-file` | Existing sender or file-read admission failed. |
| `unsupported-format`, `sheet-not-found` | The extension or requested sheet is not admitted. |
| `invalid-index` | The sheet or page index is not a non-negative integer. |
| `too-large` | The source file exceeds its byte ceiling. |
| `encrypted`, `unsupported-encoding` | The content needs unsupported decryption or text decoding. |
| `corrupt-document` | Inspected content is malformed or inconsistent with its requested container, including fatal delimited quoting errors. |
| `archive-too-large` | Archive or declared document expansion cannot fit the supported expansion limits. |
| `busy` | Another sender or frame holds the request lease; retry shortly. |
| `superseded` | A newer request from the same sender and frame replaced this one; the renderer ignores the reply. |
| `parse-limit` | The detection, parse deadline or response budget is exceeded, or a ready parser exhausts resources or dies abnormally. |
| `read-failed` | File reading, process startup, the startup deadline or the child response protocol fails. |

Process failures do not become empty successful tables. The parent returns concise error codes and bounded English diagnostics; the renderer maps the code to localized copy and does not display raw child diagnostics.
