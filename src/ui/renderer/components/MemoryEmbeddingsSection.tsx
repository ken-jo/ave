import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { MemoryMapApi, MemoryMapError, MemoryEmbeddingSettings } from "../../../shared/memory-map.js";
import { MEMORY_EMBEDDING_CONSENT_VERSION } from '../../../shared/memory-embedding-config.js';
import type { MemoryModelStatus } from "../../../shared/memory-model.js";

export function MemoryEmbeddingsSection({ api }: { api: MemoryMapApi }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MemoryModelStatus | null>(null);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState<MemoryMapError | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<MemoryEmbeddingSettings | null>(null);
  const [source, setSource] = useState<'local' | 'provider'>('local');
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [consent, setConsent] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const stop = api.onModelProgress(value => { if (active) { generation.current++; setStatus(value); setError(value.error ?? null); } });
    const current = generation.current;
    void api.modelStatus().then(result => {
      if (!active || current !== generation.current) return;
      if (result.ok) { setStatus(result.value); setError(result.value.error ?? null); } else setError(result.error);
    }).catch(() => { if (active) setError("model-download-failed"); });
    void api.settingsGet().then(result => { if (active && result.ok) {
      setSettings(result.value); setRevision(result.value.namespace.modelRevision); setSource(result.value.source);
      setProviderId(result.value.namespace.providerId ?? ''); setModelId(result.value.source === 'provider' ? result.value.namespace.modelId : '');
      setConsent(result.value.consent?.version === MEMORY_EMBEDDING_CONSENT_VERSION && result.value.consent.providerId === result.value.namespace.providerId && result.value.consent.modelId === result.value.namespace.modelId && result.value.consent.endpointId === result.value.namespace.modelRevision);
    } }).catch(() => {});
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
  const handleSave = async (nextSource = source) => {
    setBusy(true); setError(null);
    try {
      const result = await api.settingsSet(nextSource === 'local' ? { source: 'local' } : { source: 'provider', providerId, modelId, consent });
      if (!result.ok) setError(result.error);
      else {
        setSettings(result.value);
        setSource(result.value.source);
        if (result.value.source === 'local') setConsent(false);
      }
    } catch { setError('provider-embedding-failed'); }
    finally { setBusy(false); }
  };
  const handleConsentChange = (checked: boolean) => {
    if (!checked && settings?.source === 'provider' && settings.consent) {
      void handleSave('local');
      return;
    }
    setConsent(checked);
  };
  const selectedProvider = settings?.providers?.find(value => value.id === providerId);
  const downloading = status?.status === "downloading";
  return <section data-settings-section="memory-embeddings" tabIndex={-1} aria-labelledby="memory-embeddings-heading" className="space-y-3 rounded-lg border p-4">
    <h2 id="memory-embeddings-heading" className="text-sm font-semibold">{t("memoryEmbeddings.title")}</h2>
    <p className="text-xs text-muted-foreground">{t("memoryEmbeddings.localDefault")}</p>
    <fieldset className="space-y-3 text-xs">
      <legend>{t('memoryEmbeddings.source')}</legend>
      <div className="flex gap-4">
        <label><input type="radio" name="memory-embedding-source" checked={source === 'local'} disabled={busy || !settings} onChange={() => void handleSave('local')}/>{t('memoryEmbeddings.local')}</label>
        <label><input type="radio" name="memory-embedding-source" checked={source === 'provider'} disabled={busy || !settings} onChange={() => { setSource('provider'); setConsent(false); }}/>{t('memoryEmbeddings.provider')}</label>
      </div>
      {source === 'provider' && <>
        <label className="block">{t('memoryEmbeddings.provider')}<select className="ml-2 rounded border bg-background p-1" value={providerId} disabled={busy} onChange={event => { setProviderId(event.target.value); setModelId(''); setConsent(false); }}>
          <option value="">{t('memoryEmbeddings.chooseProvider')}</option>
          {settings?.providers?.map(provider => <option key={provider.id} value={provider.id}>{provider.id}</option>)}
        </select></label>
        <label className="block">{t('memoryEmbeddings.model')}<select className="ml-2 rounded border bg-background p-1" value={modelId} disabled={busy || !selectedProvider?.models.length} onChange={event => { setModelId(event.target.value); setConsent(false); }}>
          <option value="">{t('memoryEmbeddings.chooseModel')}</option>
          {selectedProvider?.models.map(model => <option key={model} value={model}>{model}</option>)}
        </select></label>
        {(!settings?.providers?.length || selectedProvider?.reason) && <p role="status">{t(selectedProvider?.reason ? `memoryMap.error.${selectedProvider.reason}` : 'memoryEmbeddings.noProviders')}</p>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={busy || !modelId} onChange={event => handleConsentChange(event.target.checked)}/><span>{t('memoryEmbeddings.consent', { provider: providerId || t('memoryEmbeddings.chooseProvider') })}</span></label>
        <Button size="sm" disabled={busy || !consent || !selectedProvider?.models.includes(modelId)} onClick={() => void handleSave()}>{t('memoryEmbeddings.save')}</Button>
        <p>{t('memoryEmbeddings.rebuildNotice')}</p>
      </>}
    </fieldset>
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
