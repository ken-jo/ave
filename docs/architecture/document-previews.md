# Document previews

Status: Active. Read-only previews of table and page documents, served over the
private `ave:preview:read-document` IPC channel. Both kinds share sender
validation, current file-read authority, the disposable parsing child and its
budgets, and the [agent observation contract](architecture.md#agent-activity-observation).
The optional [document conversion engine](document-observation-engine.md)
supplies recalculated or rendered results under its own verification and
confinement contract.

- [Table documents](#table-documents): CSV, TSV, XLSX, XLS and ODS grids.
- [Page documents](#page-documents): PPTX, PDF, DOCX, ODT, HWP v5 and HWPX
  outlines and rendered pages.

---


## Table documents

The table viewer accepts CSV, TSV, XLSX, XLS and ODS files and displays a bounded grid of strings. [The shared preview contract](../../src/shared/preview-document.ts) owns supported formats, result types, error codes and every resource ceiling.

XLSX workbooks requesting recalculation show a localized badge because cached formula results may be stale. The optional [document conversion engine](document-observation-engine.md) recalculates private copies when installed; an absent engine retains the cached-value viewer and badge. The [XLSX editing contract](xlsx-skill-editing.md) owns the source calculation signal, preservation limits and approved sandbox-shell editing. The panel remains read-only while showing live agent changes under the [observation contract](architecture.md#agent-activity-observation).

### Read authority

`ave:preview:read-document` is a private, host-renderer IPC channel. [The preview handler](../../src/ipc/domains/preview.ts) uses the same registered app-window main-frame guard as `readFile`, `documentOpenAck` and observation acknowledgements. The sender must be a live `WebContents` of type `window`, belong to a live app window registered through `IpcDeps.getAppWindows()` with `getMainWindow()` as the compatibility fallback, use the default session, and supply the actual `sender.mainFrame` as `senderFrame`. Reads recheck that live identity and registration after asynchronous work; observation delivery rechecks it before sending events. Source-URL validation is supplemental: a matching URL cannot make an embedded webview, subframe, unregistered window or plugin partition an app-window principal. Navigating a webview to a `.js` URL grants no preview-read or observation authority.

The handler uses `assertReadableFilePath` from [the file-read core](../../src/tools/file-read-core.ts). Preview reads always check allowed roots. Native agent file reads instead use the invocation's existing file access policy, which can allow reads outside those roots when directory fencing is disabled. This renderer guard does not change agent policy. The channel grants no additional filesystem authority and is unavailable through public transports.

The main process checks the requested sheet index and extension, then acquires a request lease before [opening the admitted path once](../../src/tools/preview-document-input.ts). Regular-file status and size come from that descriptor. Reading stops at its checked size plus one byte; growth, shrinkage or a changed modification time refuses the read, and the descriptor closes on every outcome. A superseded read checks cancellation before allocating and after each filesystem operation; it waits for an operation already in progress to return. Child deadlines do not cover filesystem reads. Replacing the pathname after opening cannot redirect that read. Each request supplies a zero-based, non-negative sheet index; any other value returns `invalid-index` at the IPC boundary and again in the parse lease. CSV and TSV accept only index zero; workbook indexes must address the retained `sheetNames` list, so sheets beyond the tab limit cannot be selected. Successful reads use the existing audit logger with a redacted path. The renderer receives a parsed table result, never source document bytes or a parser handle.

### Agent live view

The grid has no direct cell editor or save operation. Editing remains in the agent's ordinary governed tools, skills and shell; the host has no document write API. Viewing a file never grants editing authority or asks the user to approve a modification.

Table, file/code and page previews share a single-line header with a format icon,
bold file name, muted monospaced parent path and accessible icon-only open, copy
and applicable reload actions. The parent path is relative to the workspace when
known and truncates with ellipsis; the full path remains in its title. The old
separate path box, kind badge, source subtitle and action rows are absent.
The default-application action reuses the attachment opener with a host-owned
receipt for the successfully read canonical target. It rechecks the registered
frame and current file-read scope; a renderer cannot authorize another path.

The live strip beneath the header is hidden until authenticated agent observation
activity arrives. It shows editing or edited, the latest cell change and recency;
observation errors, engine absence and resynchronization use that same slot.
Changed cells use the shared light/dark agent color. The current target is outlined
with a small Ave tag, while earlier changes keep a faint tint. The compact footer
shows format, selected sheet and dimensions, plus the recalculation badge and all
applicable truncation notices. Other than its sheet tabs, the table remains a
read-only grid.

A successful preview read can register a bounded rendered baseline for its host-verified session. A user-only preview creates no filesystem watch. Successful session-bound agent panel opens and exact agent mutation evidence admit observed targets. If the agent edits a file the user already has open, that exact file can become an agent target. The observer never enumerates a workspace or records user-only document activity.

The document adapter combines exact-file save notifications with the skill's append-only edit journal. Journal cell events highlight provisional values before publication; the saved-file snapshot replaces that overlay and refreshes the recalculation badge. It diffs against the last acknowledged rendered snapshot, with debounce and settling for atomic replacement. Neither a watch event nor temporal overlap with an agent call proves who wrote the file: attribution also requires host-bound invocation evidence and matching before/after digests. Unverified changes are not streamed as agent content.

Private observation push and acknowledgement channels reuse registered app-window main-frame checks and session ownership. Acknowledgements carry only a read-only target identity and sequence; there is no path, script or document-write payload. The renderer acknowledges snapshots after rendering and releases the binding on document, sheet or session change and unmount. The [observation contract](architecture.md#agent-activity-observation) owns event schemas, journal containment and caps, lifecycle, back-pressure and agent-only local privacy.

The replaceable observation engine validates table results through the same bounded reader child as manual previews. When installed, the [conversion engine](document-observation-engine.md) supplies a recalculated temporary workbook to that child; it never publishes those bytes to the source. With no installation, the existing reader displays source caches and their recalculation signal. The same document adapter handles verified native text, paragraph/run and slide-shape diffs. Selected text windows, snippets, images and user-only activity remain outside observation scope. Integrity, confinement, parser and protocol failures stay errors. Browser and terminal adapters are outside this implementation.

### Parsing process and budgets

[The process owner](../../src/tools/preview-document-process.ts) grants a lease covering input reading, child startup, parsing, response validation and cleanup. A lease belongs to the admitted app-window main-frame identity. A newer request from that frame supersedes its predecessor and kills its child, then waits for the old read to unwind and the child to close before admitting another read. Intermediate replaced requests never read source bytes. Sender destruction or a renderer crash, committed navigation of the owning frame, and observed frame detachment abort pending and admitted requests. Owner listeners and the detached-state watcher are removed on cancellation and in `finally`; the handler releases an admitted lease after cleanup on every outcome. Another admitted app-window main frame receives `busy` before any source allocation. The renderer ignores `superseded` replies and retries `busy` on the bounded shared schedule while the component remains mounted with the same path and sheet. It shows the localized busy message only after exhausting that schedule; unmounting or changing the target cancels pending retry timers.

Each admitted parse runs in a disposable managed child with a filtered environment. [The child entry](../../src/tools/preview-document-child-main.ts) loads its modules, validates request arguments and writes a fixed ready marker before reading source bytes. The parent enforces a separate startup deadline through that marker; premature exit, malformed framing or startup expiry returns `read-failed`. Once ready, the parent starts the parse deadline and sends the source bytes through stdin. [The table reader](../../src/tools/table-document-reader.ts) runs only in the child. There is no in-process parsing fallback.

The child is bounded and killable, with a managed old-space ceiling through `--max-old-space-size`, startup and parse deadlines, and a bounded stdout response. The parent validates the child protocol and returned table in place, without cloning its grid. Both sides enforce the total returned-cell ceiling as well as row, column and serialized-byte ceilings. A successful response contains only the bounded display grid, sheet metadata and truncation flags.

The [shared preview limits](../../src/shared/preview-document.ts) are the sole policy source for heap, deadline, concurrency, response bytes, input bytes, archive expansion and displayed data. Exceeding a process budget terminates the child and returns an explicit failure. A child is managed for lifecycle cleanup; process separation and the heap flag do not establish filesystem confinement or a strict bound on all resident memory. Source buffers, parser intermediates and allocations outside the managed heap can require additional memory.

### Container admission

The filename extension selects the requested format; it does not prove the bytes have that format. [Workbook container preparation](../../src/tools/workbook-container.ts) validates the actual container before invoking the workbook parser:

- XLS requires the compound-file signature.
- XLSX requires its ZIP package and required workbook parts.
- ODS requires its ZIP package, document parts and spreadsheet media type.

[The ZIP guard](../../src/tools/zip-inflate-guard.ts) checks supported archive framing and local/central metadata consistency, then enforces entry count, actual inflated bytes and compression-ratio limits. The workbook parser receives only a canonical checked ZIP assembled from validated compressed member payloads with rewritten matching headers. Supported data descriptors are checked and removed along with extra fields and comments. The original unchecked archive never reaches the workbook parser.

Unsupported archive variants, including ZIP64, contradictory headers and nested ZIP members, are refused. The preview does not recursively unwrap archives to discover a workbook. Encryption remains an explicit refusal. A signature, claimed uncompressed size or filename alone cannot bypass container validation.

ODS repeated-row and repeated-column declarations are checked against the shared expanded-row and expanded-cell ceilings before a workbook-library call. Exceeding either ceiling refuses the document rather than attempting expansion and trimming the resulting grid afterward. Those expansion ceilings are separate from the row and column limits on displayed output.

### Display windows and delimited input

Workbook row and column windows start at the used range's first cell. The used range comes from the parser's `!fullref` when present, otherwise `!ref`. `firstRow` and `firstColumn` preserve that cell's zero-based source coordinates for labels; `totalRows` and `totalColumns` describe the used-range dimensions. A sheet whose reported range begins at `A10001` starts its preview there. Absolute row position must not turn an offset used range into an empty preview. A sheet without a reported range returns an empty grid with zero dimensions and origins.

The reader returns at most the shared row, column, total-cell and sheet limits, pads retained rows to a consistent width and clips long cells. A wider grid has a smaller row window to fit the total-cell ceiling. Truncation flags tell the viewer which limits removed data. Cells are display strings. The reader decodes caches without evaluating formulas or executing macros; optional recalculation happens in the separately verified and confined conversion engine.

CSV and TSV decode bytes lazily into bounded input chunks. Delimiter and line-ending detection use a bounded initial sample and one bounded look-ahead chunk. When more input follows, the sample must establish a complete initial record; an overlong initial record or ambiguous terminal carriage return is refused with `parse-limit`. Inspection stops after the retained row window plus the next record needed to establish truncation, with bounded chunk read-ahead; the source stream is destroyed on completion or failure. It does not decode the complete suffix or continue record scanning to compute whole-file totals after truncation. When inspection stops early, `totalRows` and `totalColumns` describe the observed prefix and are lower bounds for the complete file. The viewer selects lower-bound labels for both totals when the format is CSV or TSV and `sheet.rowsTruncated` is true; `columnsTruncated` independently reports width clipping. A fatal quoting error encountered in the inspected window returns `corrupt-document`; malformed quoting that requires parser repair is fatal. A successful prefix preview makes no validity claim about the uninspected suffix.

### Explicit failures

The shared error union and the renderer's localized mapping remain the response contract. Refusals preserve their cause:

| Error | Meaning |
| --- | --- |
| `unauthorized`, `path-not-allowed`, `sensitive-path`, `not-a-file` | Existing sender or file-read admission failed. |
| `unsupported-format`, `sheet-not-found` | The extension or requested sheet is not admitted. |
| `invalid-index` | The sheet or page index is not a non-negative integer. |
| `too-large` | The source file exceeds its byte ceiling. |
| `encrypted`, `unsupported-encoding` | The content needs unsupported decryption or text decoding. |
| `engine-unavailable` | The format requires an optional engine that is not installed; supported cached-value and outline readers remain usable. |
| `engine-integrity-failed` | The installed engine fails payload or signature verification. |
| `engine-confinement-unavailable` | The host cannot provide the required offline conversion sandbox. |
| `engine-runtime-unavailable` | An additional importer runtime or its private-profile registration is unavailable. |
| `engine-failed` | Conversion or its derived output fails the engine contract. |
| `corrupt-document` | Inspected content is malformed or inconsistent with its requested container, including fatal delimited quoting errors. |
| `archive-too-large` | Archive or declared document expansion cannot fit the supported expansion limits. |
| `busy` | Another sender or frame holds the request lease; retry shortly. |
| `superseded` | A newer request from the same sender and frame replaced this one; the renderer ignores the reply. |
| `parse-limit` | The detection, parse deadline or response budget is exceeded, or a ready parser exhausts resources or dies abnormally. |
| `read-failed` | File reading, process startup, the startup deadline or the child response protocol fails. |

Process failures do not become empty successful tables. The parent returns concise error codes and bounded English diagnostics; the renderer maps the code to localized copy and does not display raw child diagnostics.

---

## Page documents

PPTX, PDF, DOCX, ODT, HWP v5 and HWPX files use the private `ave:preview:read-document` channel and the [table preview lifecycle](#read-authority). Sender validation, current file-read authority, descriptor-based bounded input, owner cancellation, admission, startup and parse deadlines, response bytes and child cleanup remain shared. The renderer receives an outline or a rendered page, never source document bytes. The optional [document conversion engine](document-observation-engine.md) supplies temporary rendered results under its separate verification and confinement contract.

[The page contract](../../src/shared/preview-page-document.ts) owns page, text, XML and image limits. [The child reader](../../src/tools/page-document-reader.ts) returns one requested page; opening the package or PDF can parse document-wide structures and resources. The host validates its result with [the page response validator](../../src/tools/preview-page-protocol.ts), checks the requested format and index, and maps failures to localized messages. A resource or parsing failure cannot become an empty successful document. An active view whose request is replaced shows a cancellation message and an explicit retry. Changing files remounts the view at its first page.

Without the optional engine, PPTX is a text outline, ordered by `p:sldIdLst` in the presentation XML, with each entry resolved through its slide relationship. That outline does not reproduce layout, charts, images, notes or animations. The existing ZIP verifier checks local and central framing, actual inflation and checksums, then supplies canonical bytes. Nested ZIPs are refused outside `ppt/embeddings/`; embedded document packages remain opaque after their outer member passes the same byte and inflation limits. The outline reader never opens them. Office password-protected presentations are compound files, not ZIP packages; their signature returns `encrypted` before ZIP verification. Package types and internal slide relationships must agree; missing, duplicate, external and traversing slide references fail. XML must be well formed, bounded UTF-8 without entity declarations. Only the five XML entities and numeric character references are decoded, once; names the parser reserves, such as `__proto__`, return `corrupt-document`. Text is rendered as inert strings; links and embedded actions are not followed.

DOCX and ODT have bounded paragraph outlines when the engine is absent. These outlines provide text and structured source addresses, not a pagination or layout claim. An installed engine converts private DOCX/ODT/PPTX copies to PDF for the same page renderer. HWP v5/HWPX additionally require the isolated import extension and a compatible verified Java runtime; absence reports `engine-unavailable`. Conversion failures remain errors rather than silently selecting an outline.

Page documents can participate in the existing [agent observation contract](architecture.md#agent-activity-observation). DOCX paragraph/run and PPTX slide-shape changes use the ordinary element/snapshot event envelope after verified-save attribution, including reconciliation from the existing tool-bound journal's `begin`/`commit` digest pair. Provisional journal cells remain table-only. A user-only preview is only a rendered baseline and creates no activity stream. A page image is acknowledged after it loads; an outline is acknowledged after layout commits. Page, file, session and frame changes release the binding and its pending work.

PDF pages are rasterized inside the disposable child, launched with `--disallow-code-generation-from-strings`. The reader's document-loading options disable system-font use and worker network fetching, and resolve font, character-map, decoder and worker paths from shipped packages. These library settings are not OS confinement. The display receives one size-limited PNG and bounded extractable text, with previous/next navigation. PNG framing, checksums, chunk counts and fixed raster dimensions are checked before delivery; animation and compressed metadata chunks are refused. A display decoder failure also becomes an explicit retryable error. Password-protected documents return `encrypted`, an image above the pixel limit returns `parse-limit`, and other parsing failures return `corrupt-document`. The reader observes the rendering and text streams, because the library can finish a page from operators delivered before a later stream failure; such a page is refused, not shown partially. The observation uses the library's internal transport, pinned by the exact dependency version, and fails closed: a missing hook point, or a page whose operator or text stream did not pass through it, returns `renderer-unavailable`. The same code reports a renderer or native canvas module that cannot be loaded, so a damaged installation is not shown as an unreadable file. The image and text are a preview, with no form, annotation, link or script interaction. Both formats display notices when text or the available-page range is shortened. PDF raster dimensions are scaled to fit the image limits; an image or response that cannot fit fails explicitly.

The child retains the shared managed-heap ceiling and wall-clock kill. These limits do not provide a kernel-enforced resident-memory ceiling or filesystem confinement. Native image allocations are a remaining resource risk; this preview must not be described as a hard resident-memory sandbox. Optional conversion has its own required OS confinement before derived output reaches this reader; that confinement does not change the page reader's native-allocation limit.

Packaging checks ([page runtime files](../../scripts/lib/page-runtime-files.cjs)) require the target platform's canvas binary in the unpacked modules, the minified pdf.js worker and notices in the archive, the fonts, character maps, ICC profile and wasm decoders the reader loads by path unpacked beside it, and the canvas, Skia and third-party notices in `licenses/canvas`. The pdf.js script sandbox, its evaluation engine and the JavaScript fallbacks for the wasm decoders are excluded from the package.
