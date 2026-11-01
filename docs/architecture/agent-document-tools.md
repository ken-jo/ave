# Agent document tools

`read_document` places bounded document content in model context. `open_document` requests a document in the user's existing side panel or returns a file link, according to a user setting. Reading never implicitly opens a panel. Neither tool edits documents, evaluates formulas, runs macros, performs OCR or launches a converter.

The tools are host-owned builtins registered through the ordinary tool registry. They do not extend plugin manifests or add plugin-specific host branches. The supported formats are CSV, TSV, XLSX, XLS, ODS, PDF and PPTX. There is no `read_sheet` alias.

[The input schemas and context limits](../../src/tools/document-tool-input.ts) own argument validation and defaults; [the output formatter](../../src/tools/document-tool-output.ts) owns the exact result fields and budget accounting. The preview contracts linked below own document decoding and display-string semantics.

## Read selection

`read_document` accepts a `path` and an optional `selection` object. Paths follow the existing file-tool resolution rules, including the invoking session's working directory and tilde expansion. URLs and glob patterns are refused. Omitting `selection` reads the first sheet or page for the detected format.

| Selection | Arguments | Meaning |
| --- | --- | --- |
| `kind: "sheet"` | `sheet?`, `rowOffset?`, `columnOffset?`, `rowCount?`, `columnCount?` | Read a rectangular window of display strings from a table document. |
| `kind: "page"` | `page?`, `textOffset?`, `includeImage?` | Read one PDF page or presentation slide's retained text, optionally with an available PDF image. |
| `kind: "info"` | `sheetOffset?` | Read format, accessible sheet/page counts, truncation flags and a page of sheet labels. |

Selectors incompatible with the format fail with `invalid-arguments`. All numeric positions must be safe integers; negative positions are invalid. A sheet index and `sheetOffset` are zero-based and default to zero. Page numbers are one-based and default to one; `textOffset` is zero-based and defaults to zero. Sheet selection uses the index rather than the display name, which can be duplicated or shortened. CSV and TSV have only sheet zero. An info result includes at most ten sheet labels and a numeric continuation offset when more accessible labels remain. A `sheetOffset` at or beyond the accessible label count succeeds with an empty list and no continuation.

For example, `{path:"book.xlsx",selection:{kind:"sheet",sheet:0,rowOffset:10000,columnOffset:0,rowCount:20,columnCount:10}}` reads that source window; `{path:"report.pdf",selection:{kind:"page",page:2,textOffset:0,includeImage:true}}` reads page two with its available image. Unknown or mixed selector fields are invalid.

### Sheet windows and continuations

Row and column offsets are zero-based absolute source coordinates. An omitted offset starts at the sheet's used-range origin, so a sparse sheet beginning at A10001 does not produce thousands of leading empty rows. Counts default to 20 rows and 10 columns. A request permits at most 100 rows, 50 columns and 500 cells; zero, negative, fractional, unsafe or over-limit counts are invalid.

The result identifies the format, selected sheet, used range, resolved `requestedWindow`, actual `returnedWindow`, rectangular `cells`, truncation flags and `remainingWindows`. Used-range dimensions retain their source origin. Returned cells are display strings, including empty strings for empty cells; no header inference or raw-value typing occurs. A disjoint window or empty sheet succeeds with an empty returned window and no continuation.

The complete compact JSON output must fit every context limit:

| Budget | Maximum |
| --- | --- |
| UTF-16 code units | 6,000 |
| UTF-8 bytes | 16 KiB |
| Estimated text tokens | 1,800 |
| Physical output lines | 100 |
| Returned cells | 500 |

The token budget uses [the host estimator](../../src/shared/token-estimate.ts) rather than promising an exact model token count. Accounting applies to the complete `JSON.stringify` result, including metadata, escaped characters and clipping markers. A nonempty result remains rectangular; the formatter reduces columns to one before reducing rows to one, then shortens that final cell if needed without splitting surrogate pairs. `truncation.clippedCells` identifies shortened cells by absolute `{row,column}` coordinates. Existing parser cell limits also apply. If required metadata alone cannot fit, the tool returns `parse-limit` rather than dropping fields or emitting malformed JSON.

`remainingWindows` contains at most two nonoverlapping rectangles: the omitted right strip of returned rows, then omitted lower rows. They cover context-budget omissions only within the original requested rectangle's overlap with the used range. Reusing each rectangle as the next sheet selection recovers those omitted cells. It cannot recover characters already discarded by parser or cell-text clipping. Exploring beyond the original rectangle requires a new explicit request.

Context clipping, parser clipping and uninspected source are separate signals. The parser supplies absolute clipped-cell coordinates through the validated child response; display length never determines whether a cell was clipped. CSV/TSV totals are lower bounds when bounded scanning leaves a suffix uninspected; `totalsExact` remains false. A successful inspected prefix makes no validity claim about that suffix. Late source coordinates are allowed within the same parser resource bounds; exhausted scanning or parsing returns `parse-limit` rather than imposing a fabricated coordinate ceiling.

### Page text and images

A page result includes the selected public page number, total page count, page-range truncation, text availability, retained text, `textOffset`, `nextTextOffset` and `nextPage`. Info selection additionally reports the accessible page count. Text continuations address parser paragraphs joined with a single newline and do not split surrogate pairs. An offset beyond retained text or inside a surrogate pair fails with `invalid-index`. `nextPage` remains null while retained text on the current page is still unread. Exhausted continuation fields are null. Parser-discarded text stays explicitly incomplete through `textTruncated` and cannot be recovered by text continuation. Separate calls do not promise a snapshot when the source file changes.

`includeImage` defaults to false. When true and the existing page parser provides a PNG, that image travels through `ToolExecutionResult.image`, the same typed image-content path used by `view_image`. It is never embedded as base64 in textual JSON. One page read can add one image, charged separately against the active model transport's image count and byte budgets. Its decoded PNG must fit the existing 2 MiB ceiling or the call fails with `parse-limit`. Image input consumes additional model context and can incur additional model cost; repeated text-continuation calls with `includeImage: true` attach the image again. The tool description must disclose that cost. A page without a PNG reports `image.available: false` without an image attachment. Transport image-delivery failures remain visible rather than silently discarding the image.

PDF text reads retain the existing rasterization dependency even when `includeImage` is false. A textless page reports `textAvailable: false`; it does not imply OCR. Presentation slides remain text outlines and have no rendered PNG, notes, layout, chart or animation extraction. Asking for an image does not introduce a rasterizer or conversion fallback.

## Authority, transport and parsing

Both tools declare read-only file access with `pathFields: ["path"]`. Execution applies `ensureFileAccess(path, context, "read")` exactly as `read_file` does, after canonical resolution. Sensitive-path refusals, optional read-directory fencing, strict-mode asks, deny rules, active-recipient authority, audit and DLP remain in the ordinary executor path. Read-only classification does not bypass an existing approval requirement. Document results remain untrusted content and cannot dispatch privileged slash commands. Reading a document does not satisfy text-edit read-before-write state.

The renderer preview's path guard is a separate, narrower boundary. `open_document` preflights that existing viewer scope before requesting a panel change; this feature does not widen it. A file readable by the agent can therefore still return `path-not-allowed` when opening its panel.

Local reads reuse the bounded descriptor-based input reader, preserving regular-file, size and descriptor-identity checks. Broker-selected reads use the existing bound `file.read_binary` operation and feed those admitted bytes to the same child parser. Capability, generation, working-directory and input binding remain mandatory. A missing, stale or denied broker route never falls back to a similarly spelled host path. Opening a broker guest path in the host panel returns `unsupported-route`.

The [table preview contract](document-previews.md#table-documents) and [page preview contract](document-previews.md#page-documents) own parser admission, container checks and resource limits. Parsing remains in the existing disposable child under a host-issued invocation lease. Numeric windows are passed into that parser rather than sliced from a truncated preview prefix. Preview requests omit the window and retain their existing display behavior. The child protocol validates window origins and used-range origins independently.

The input, archive, startup, parse, heap, response and concurrency limits remain shared with previews. Cancellation releases the lease and terminates the child; another owner receives `busy`. Agent tools do not add automatic busy retries. Outer tool deadlines come from the shared tool-timeout policy. The child is bounded and killable; it does not establish OS filesystem confinement or a strict resident-memory ceiling.

## Opening documents

`open_document` accepts only `{path}` and does not extract content for the model. The user controls `documents.openMode` in Settings:

| Mode | Behavior |
| --- | --- |
| `direct` (default) | Select or reuse the document in the originating session/tile's existing side panel after the ordinary read policy and viewer-scope checks. No extra prompt is required solely for this reversible UI selection. |
| `link` | Return a clickable file link without changing the panel. The user opens it explicitly. |

The `documents` settings subtree is user-only and floor-like: agent settings writes cannot change it, including nested writes. Each live host registers its actual settings file path with the existing write-sensitive matcher, including relocated profiles, and releases that registration when it closes. Constructing a standalone settings store does not alter runtime policy. The file and its immediate directory cannot be agent mutation targets; grandparents and sibling files retain their ordinary policy. Overlapping live hosts retain protection until the final registration is released. Settings schema, defaults, migration, localized labels and lock tests enforce the same key and values.

Direct mode never creates or focuses a different window and never opens an OS application. A matching renderer acknowledgment is required before reporting `opened: true`; delivery alone is not success. For agent table opens, selection and a host-accepted rendered-grid baseline must both be ready, in either order, before the tool completes. A still-live matching rendered baseline can satisfy readiness immediately. This keeps an immediate following edit from outrunning the [observation baseline](architecture.md#agent-activity-observation). Page opens retain the selection receipt and present subsequent loading or parse failures in the existing viewer. Repeated requests select the existing target rather than duplicating it.

File/code, table and page previews share the [compact viewer presentation](architecture.md#agent-activity-observation).
Full text/code files opened through the existing file viewer can become live
agent targets when an approved native mutation supplies exact before/after
evidence. This does not extend `read_document` or `open_document` to a new format.
Selected line windows, inline snippets and images retain ordinary viewing, and
page readers add no synthetic live events. A user open alone supplies neither
agent attribution nor a filesystem watch.

Headless execution returns `ui-unavailable` with `isError: true` in either setting mode. A missing, destroyed or background-only target window also returns that error. Selection and table readiness share the original `TOOL_TIMEOUT_POLICY.documentPanelAckMs` deadline; missing, rejected, expired or wrong-session acknowledgments cannot report an opened panel and ultimately return `ui-unavailable`. Navigation, cancellation or frame loss releases the pending readiness wait. `read_document` works without a window. Both tools preserve their normal file-policy checks and do not create UI as a fallback.

## Failures and verification

Ordinary failures use a bounded `{ok:false,error,message,retryable}` output with `isError: true`. Invalid selectors/windows use `invalid-arguments`; invalid retained-text boundaries use `invalid-index`; unsupported broker display routes use `unsupported-route`; absent UI uses `ui-unavailable`. Existing file and parser errors retain their causes, including `sensitive-path`, `path-not-allowed`, `not-a-file`, `unsupported-format`, `sheet-not-found`, `page-not-found`, `too-large`, `archive-too-large`, `encrypted`, `unsupported-encoding`, `corrupt-document`, `renderer-unavailable`, `busy`, `superseded`, `parse-limit` and `read-failed`. Diagnostics are bounded English text and never expose raw child errors. A process failure cannot become an empty successful document.

Focused regression coverage exercises schema rejection, late and sparse windows, disjoint/empty windows, rectangular continuations, Unicode and escaping-heavy budgets, lower-bound totals, page text continuation, optional typed images and image limits. Permission and broker tests prove denial occurs before parser or panel work and that guest reads cannot reach same-spelled host files. Settings and panel tests cover both modes, immutable agent-facing settings, headless errors and session-bound acknowledgment. An isolated-profile desktop smoke opens a fixture workbook in direct mode and verifies link mode leaves the panel unchanged.
