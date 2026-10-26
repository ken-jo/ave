import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";
import { isRecord } from "../../../shared/is-record.js";
import { openDocumentInPanel } from "../preview/agent-document-bridge.js";

/** A returned file target is opened by the user's click through the ordinary preview surface. */
export function DocumentToolLink({ name, result, sessionId, failed }: { name: string; result: unknown; sessionId?: string; failed: boolean }) {
  if (name !== "open_document" || failed || !sessionId || typeof result !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(result); } catch { return null; }
  if (!isRecord(value) || value.ok !== true || value.mode !== "link" || value.opened !== false
    || typeof value.path !== "string" || !value.path || typeof value.fileLink !== "string") return null;
  const path = value.path;
  let url: URL;
  try { url = new URL(value.fileLink); } catch { return null; }
  if (url.protocol !== "file:") return null;
  return <a href={url.href} className="mx-3 my-1 inline-block max-w-full break-all text-xs underline"
    data-testid="document-tool-link"
    onClick={(event) => {
      event.preventDefault();
      void openDocumentInPanel(path, sessionId, Date.now() + TOOL_TIMEOUT_POLICY.documentPanelAckMs);
    }}>{path}</a>;
}
