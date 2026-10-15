# Tool Result `kind` Sentinels

Status: Active. One live sentinel (`ave.render_html`); `ave.write_file` is
parsed for older sessions only. Source files and tests named below are
authoritative when they disagree with this page.

Some builtin tools return a JSON `output` with a `kind` field that tells the
renderer which custom view to use. This is a contract between producers in
`src/tools/` and consumers in `src/ui/renderer/`; adding, renaming, or removing
a sentinel changes both sides in the same change.

## Why a sentinel

Most tool results render through the default payload view. A few need a
dedicated UI (an HTML preview window, a diff card). A namespaced `kind` lets the
renderer select that UI without guessing from tool names or field shapes. The
`ave.` prefix keeps it from colliding with plugin or MCP payloads that use their
own `kind` fields.

## `ave.render_html`

| Role | Location |
| --- | --- |
| Producer | `src/tools/render-html.ts` (`render_html`, category `read`) |
| Payload type | `RenderHtmlResult` (producer), `RenderHtmlPayload` in `src/ui/renderer/types.ts` |
| Parser | `parseRenderHtmlResult` in `src/ui/renderer/utils/html-preview.ts` |
| Consumer | `src/ui/renderer/components/HtmlPreview.tsx`, wired from `src/ui/renderer/components/ToolGroupCard.tsx` |

```json
{
  "kind": "ave.render_html",
  "title": "optional title",
  "height": 360,
  "html": "<!doctype html>...",
  "warnings": ["removed <iframe>"]
}
```

- `html` is already sanitized and wrapped with a restrictive CSP by the
  producer; `height` is clamped to the tool's bounds.
- The consumer opens a separate preview window through
  `window.aveApi.window.openHtmlPreview` in the `ave-render-html` partition.
  The main process blocks every network scheme in that partition except
  `data:`, `blob:`, and `about:blank` (`src/main/html-preview-partition.ts`).
- JavaScript stays off unless the content requires scripts and the user
  enables the toggle in the preview shell (`src/shared/render-html-preview.ts`).

Tests: `src/tools/__tests__/render-html.test.ts`,
`src/shared/__tests__/render-html-preview.test.ts`,
`src/main/__tests__/html-preview-partition.test.ts`.

## `write_file` diffs (sentinel retired)

`WriteFileTool` (`src/tools/file-tools.ts`) no longer emits `kind` or inline
file contents. Its result is:

```json
{ "path": "/abs/path/to/file.ts", "bytes": 8421, "truncated": true, "hasSidecar": true }
```

- `bytes` is the byte length of the new content.
- `truncated` and `hasSidecar` appear only when either the previous or the new
  content exceeds `WRITE_DIFF_PREVIEW_LIMIT` (4096 bytes,
  `src/tools/write-diff-cache.ts`).
- In that case the before/after pair is stored at
  `<ave home>/diff-cache/<sessionId>/<toolUseId>.json` (directory mode `0700`,
  file mode `0600`). `hasSidecar` is `false` when the write was skipped, for
  example for a binary or oversized prior file or an unsafe id.
- The renderer shows `WriteFileSidecarDiff`
  (`src/ui/renderer/components/FileEditDiff.tsx`) when `truncated` and
  `hasSidecar` are both true, loading the pair on demand through
  `ave:chat:get-write-diff` (`src/ipc/domains/chat.ts`, `readDiffSidecar`).
  Otherwise it shows the path and byte count.

`extractWriteFile` in `src/ui/renderer/utils/file-diff.ts` still accepts a
result with `kind: "ave.write_file"` and inline `before`/`after` so sessions
recorded before the change keep rendering. No current producer emits it; do
not reuse the name for a new shape.

`edit_file` and `apply_patch` diffs are built from the tool input, not from a
sentinel.

Tests: `src/tools/__tests__/write-diff-cache.test.ts`,
`src/ipc/domains/__tests__/chat-write-diff.test.ts`,
`src/ui/renderer/__tests__/FileEditDiff.test.tsx`,
`src/ui/renderer/__tests__/ToolGroupCard.test.tsx`.

## Adding a sentinel

1. Define the payload type in `src/ui/renderer/types.ts`.
2. Emit `kind: "ave.<name>"` from the producing tool.
3. Add a parser under `src/ui/renderer/utils/` that returns the typed payload
   or `null`, and never throws on non-JSON or unknown input.
4. Wire the consumer into `ToolGroupCard` for both the single-tool path
   (`SingleToolInline`) and the grouped path.
5. Add parser and consumer tests.
6. Update this page.

## Rules

- Discriminate on `kind`, not on tool name plus field shape.
- Always use the `ave.` namespace; bare names such as `"diff"` or `"html"`
  collide with plugin and MCP payloads.
- Bound any content placed in a result. Large content goes to a sidecar or is
  truncated with an explicit flag, because tool results enter model history.

## Related

- [Tool Governance](../architecture/tool-governance.md)
- [Plugin Tool Schema Design](./plugin-tool-schema-design.md)
- [Architecture](../architecture/architecture.md)
