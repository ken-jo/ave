import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { MemoryMapApi, MemoryMapError } from "../../../shared/memory-map.js";
import type { MemoryModelStatus } from "../../../shared/memory-model.js";

export function MemoryEmbeddingsSection({ api }: { api: MemoryMapApi }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MemoryModelStatus | null>(null);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState<MemoryMapError | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const stop = api.onModelProgress(value => { if (active) { generation.current++; setStatus(value); setError(value.error ?? null); } });
    const current = generation.current;
    void api.modelStatus().then(result => {
      if (!active || current !== generation.current) return;
      if (result.ok) { setStatus(result.value); setError(result.value.error ?? null); } else setError(result.error);
    }).catch(() => { if (active) setError("model-download-failed"); });
    void api.settingsGet().then(result => { if (active && result.ok) setRevision(result.value.namespace.modelRevision); }).catch(() => {});
    return () => { active = false; generation.current++; stop(); };
  }, [api]);
  const handleAction = async (action: "download" | "existing" | "cancel") => {
    setBusy(true); setError(null);
    try {
      const result = await (action === "download" ? api.modelDownload() : action === "existing" ? api.modelUseExisting() : api.modelCancel());
      if (!result.ok) setError(result.error);
      else if (result.value) { setStatus(result.value); setError(result.value.error ?? null); }
      else if (action === "cancel") {
        const next = await api.modelStatus();
        if (next.ok) setStatus(next.value); else setError(next.error);
      }
    } catch { setError(action === "existing" ? "model-folder-invalid" : "model-download-failed"); }
    finally { setBusy(false); }
  };
  const downloading = status?.status === "downloading";
  return <section data-settings-section="memory-embeddings" tabIndex={-1} aria-labelledby="memory-embeddings-heading" className="space-y-3 rounded-lg border p-4">
    <h2 id="memory-embeddings-heading" className="text-sm font-semibold">{t("memoryEmbeddings.title")}</h2>
    <p className="text-xs text-muted-foreground">{t("memoryEmbeddings.localDefault")}</p>
    <div data-provider-choice-slot className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{t("memoryEmbeddings.providerSlot")}</div>
    <p role="status" className="text-xs">{t(status ? `memoryEmbeddings.${status.status}` : "memoryEmbeddings.loading")}{status?.status === "ready" && revision ? ` · ${revision}` : ""}</p>
    {downloading && <div className="space-y-1 text-xs"><progress aria-label={t("memoryEmbeddings.downloading")} value={status.receivedBytes} max={Math.max(1, status.totalBytes)} className="w-full"/><p>{t("memoryEmbeddings.bytes", { received: status.receivedBytes.toLocaleString(), total: status.totalBytes.toLocaleString() })}</p></div>}
    {error && <p role="alert" className="text-xs text-destructive">{t(`memoryMap.error.${error}`)}</p>}
    <p className="text-xs text-muted-foreground">{t("memoryEmbeddings.downloadNotice")}</p>
    <div className="flex flex-wrap gap-2">
      {downloading ? <Button variant="outline" size="sm" onClick={() => void handleAction("cancel")}>{t("memoryEmbeddings.cancel")}</Button> : <>
        <Button size="sm" disabled={busy || !status} onClick={() => void handleAction("download")}>{t(status?.status === "failed" ? "memoryEmbeddings.retry" : "memoryEmbeddings.download")}</Button>
        <Button variant="outline" size="sm" disabled={busy || !status} onClick={() => void handleAction("existing")}>{t("memoryEmbeddings.existing")}</Button>
      </>}
    </div>
  </section>;
}
