import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { useTranslation } from "../../../../i18n/react.js";
import type { TranslateFn } from "../../../../i18n/translate.js";
import type { PluginStudioApi, StudioAvailableParts, StudioDraft, StudioDraftView, StudioLocalPreview, StudioDiagnostic, StudioConnectorCopyPreview, StudioErrorCode } from "../../../../shared/plugin-studio.js";
import type { ComponentConsent } from "../../../../shared/git-marketplace.js";

const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;

function studioErrorText(t: TranslateFn, code: StudioErrorCode): string {
  switch (code) {
    case "invalid-request": return t("pluginStudio.invalidRequest");
    case "unavailable": return t("pluginStudio.unavailable");
    case "connector-changed": return t("pluginStudio.connectorChanged");
  }
}

function DiagnosticGroup({ title, diagnostics }: { title: string; diagnostics: StudioDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return <section className="space-y-1 rounded-md border p-3"><h4 className="text-sm font-semibold">{title}</h4><ul className="list-disc pl-5 text-xs">{diagnostics.map((item, index) => <li key={`${item.path}:${index}`}><code>{item.path}</code>: {item.message}</li>)}</ul></section>;
}

export function LocalPluginPackageSheet({ api, preview, onClose, onInstalled }: {
  api: PluginStudioApi; preview: StudioLocalPreview | null; onClose: () => void; onInstalled: () => void;
}) {
  const { t } = useTranslation();
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [approvedHooks, setApprovedHooks] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => { setApproved({}); setApprovedHooks({}); setFailure(""); }, [preview]);
  const install = async () => {
    if (!preview) return;
    setBusy(true);
    const selected: ComponentConsent[] = Object.entries(preview.components.mcpServers)
      .filter(([name]) => approved[name]).map(([name, server]) => ({ name, digest: server.digest }));
    selected.push(...preview.components.hooks.flatMap((hook, index) => approvedHooks[index]
      ? [{ kind: "hook" as const, index, digest: hook.digest }] : []));
    const result = await api.installFromFile(preview.previewId, selected);
    setBusy(false);
    if (!result.ok) { setFailure(studioErrorText(t, result.code)); return; }
    onInstalled();
    onClose();
  };
  return <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto" data-testid="plugin-studio:package-sheet">
      <DialogHeader><DialogTitle>{preview?.name} {preview?.version}</DialogTitle><DialogDescription>{preview?.description}</DialogDescription></DialogHeader>
      {preview && <div className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{t("pluginStudio.installNoSource")}</p>
        <p className="text-xs text-muted-foreground">{t("pluginStudio.provenanceNotice")}</p>
        {preview.files.map((file) => <section key={file.path} className="space-y-1 border-t pt-2">
          <h4 className="font-mono text-xs font-semibold">{file.path}</h4>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{file.text ?? t("pluginStudio.binaryFile")}</pre>
        </section>)}
        {Object.entries(preview.components.mcpServers).map(([name, server]) => <label key={name} className="flex items-start gap-2 rounded-md border p-2">
          <Checkbox checked={approved[name] === true} onCheckedChange={(checked) => setApproved((current) => ({ ...current, [name]: checked === true }))} />
          <span className="text-xs"><strong>{name}</strong> · {server.transport === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url}<br />{t("pluginStudio.mcpConsent")}</span>
        </label>)}
        {preview.components.hooks.length > 0 && <section className="space-y-2 rounded-md border p-3">
          <h4 className="font-semibold">{t("gitMarketplace.review.hookConsentTitle")}</h4>
          <p className="text-xs text-muted-foreground">{t("gitMarketplace.review.hookConsentHelp")}</p>
          <p className="text-xs text-muted-foreground">{t(`gitMarketplace.review.hookConfinement.${preview.hookConfinement}`)}</p>
          {preview.components.hooks.map((hook, index) => <label key={index} className="flex items-start gap-2" data-testid={`plugin-studio:hook-consent:${index}`}>
            <Checkbox checked={approvedHooks[index] === true} disabled={preview.hookConfinement === "unavailable"}
              onCheckedChange={(checked) => setApprovedHooks((current) => ({ ...current, [index]: checked === true }))} />
            <span className="text-xs"><strong>{t("gitMarketplace.review.hookConsent", { event: hook.event })}</strong>
              <code className="block break-all">{JSON.stringify(hook.command)}</code>
              {hook.matcher && <span className="block">{hook.matcher}</span>}
              <span className="block">{t("gitMarketplace.review.hookTimeout", { timeout: hook.timeoutMs })}</span>
              <span className="block">{t("gitMarketplace.review.mcpFingerprint", { digest: hook.digest })}</span>
            </span>
          </label>)}
        </section>}
        {preview.components.routineTemplates.length > 0 && <p className="text-xs text-muted-foreground">{t("pluginStudio.routineNotScheduled")}</p>}
        {failure && <p className="text-destructive" role="alert">{failure}</p>}
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button><Button disabled={busy} onClick={() => void install()} data-testid="plugin-studio:install-confirm">{t("pluginStudio.install")}</Button></div>
      </div>}
    </DialogContent>
  </Dialog>;
}

export function PluginStudioView({ api, onInstalled }: { api: PluginStudioApi; onInstalled: () => void }) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<StudioDraft[]>([]);
  const [available, setAvailable] = useState<StudioAvailableParts | null>(null);
  const [view, setView] = useState<StudioDraftView | null>(null);
  const [preview, setPreview] = useState<StudioLocalPreview | null>(null);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const [description, setDescription] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [promptName, setPromptName] = useState("");
  const [promptBody, setPromptBody] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [connectorPreviews, setConnectorPreviews] = useState<Record<string, StudioConnectorCopyPreview>>({});
  const [connectorConfirmed, setConnectorConfirmed] = useState<Record<string, boolean>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [projection, setProjection] = useState(false);
  const [reviewVersion, setReviewVersion] = useState("");
  const [reviewDescription, setReviewDescription] = useState("");
  const [fileEdits, setFileEdits] = useState<Record<string, string>>({});
  const [hookCommands, setHookCommands] = useState<string[]>([]);
  const [adaptedHooksConfirmed, setAdaptedHooksConfirmed] = useState(false);
  const [failure, setFailure] = useState("");
  const [checkoutSteps, setCheckoutSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [listed, parts] = await Promise.all([api.listDrafts(), api.availableParts()]);
    if (listed.ok) setDrafts(listed.value); else setFailure(studioErrorText(t, listed.code));
    if (parts.ok) setAvailable(parts.value); else setFailure(studioErrorText(t, parts.code));
  };
  const showView = (next: StudioDraftView) => {
    setView(next); setConfirmed(false); setAdaptedHooksConfirmed(false);
    const manifest = next.files.find((file) => file.path === "plugin.json")?.text;
    let fields: { version?: unknown; description?: unknown } = {};
    try { fields = manifest ? JSON.parse(manifest) as typeof fields : {}; } catch { /* validation shows the parse error */ }
    setReviewVersion(typeof fields.version === "string" ? fields.version : "");
    setReviewDescription(typeof fields.description === "string" ? fields.description : "");
    setFileEdits(Object.fromEntries(next.files.filter((file) => file.text !== null).map((file) => [file.path, file.text!])))
    setHookCommands(next.draft.pendingHooks.map((hook) => JSON.stringify(hook.command)));
    setConnectorPreviews({});
    setConnectorConfirmed({});
    void Promise.all((next.draft.connectorCopies ?? []).map(async (copy) => {
      const result = await api.connectorCopyPreview(copy.serverId);
      return { copy, result };
    })).then((results) => {
      const previews: Record<string, StudioConnectorCopyPreview> = {};
      const checked: Record<string, boolean> = {};
      for (const { copy, result } of results) {
        if (!result.ok) { setFailure(studioErrorText(t, result.code)); continue; }
        const preview = result.value;
        previews[copy.serverId] = preview;
        if (copy.specDigest !== preview.specDigest) continue;
        for (const item of preview.args) checked[`arg:${copy.serverId}:${item.index}`] = copy.confirmedArgs[String(item.index)] === item.digest;
        for (const item of preview.env) checked[`env:${copy.serverId}:${item.name}`] = copy.confirmedEnv[item.name] === item.digest;
      }
      setConnectorPreviews(previews);
      setConnectorConfirmed(checked);
    });
  };
  useEffect(() => { void refresh(); }, [api]);
  const open = async (draftName: string) => {
    const result = await api.readDraft(draftName);
    if (result.ok) { showView(result.value); setFailure(""); }
    else setFailure(studioErrorText(t, result.code));
  };
  const create = async () => {
    setFailure(""); setBusy(true);
    const files: Array<{ path: string; text: string }> = [];
    if (skillName || skillBody) {
      if (!COMPONENT.test(skillName) || !skillBody.trim()) { setFailure(t("pluginStudio.invalidSkill")); setBusy(false); return; }
      files.push({ path: `skills/${skillName}/SKILL.md`, text: `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n${skillBody}\n` });
    }
    if (promptName || promptBody) {
      if (!COMPONENT.test(promptName) || !promptBody.trim()) { setFailure(t("pluginStudio.invalidPrompt")); setBusy(false); return; }
      files.push({ path: `ai.agent-connector.ave/prompts/${promptName}.md`, text: `---\nname: ${promptName}\ndescription: ${JSON.stringify(description)}\nkind: template\n---\n${promptBody}\n` });
    }
    const references = Object.entries(selected).filter(([, yes]) => yes).map(([key]) => {
      const [kind, ...rest] = key.split(":");
      return { kind: kind as "skill" | "routine" | "prompt" | "agent" | "connector", name: rest.join(":") };
    });
    const result = await api.writeDraft({ name, version, description, files, references });
    setBusy(false);
    if (result.ok) { showView(result.value); void refresh(); }
    else setFailure(studioErrorText(t, result.code));
  };
  const importPackage = async () => {
    const result = await api.importPackage();
    if (result.ok && result.value) { showView(result.value); void refresh(); }
    else if (!result.ok) setFailure(studioErrorText(t, result.code));
  };
  const installFile = async () => {
    const result = await api.previewInstallFromFile();
    if (result.ok && result.value) setPreview(result.value);
    else if (!result.ok) setFailure(studioErrorText(t, result.code));
  };
  const installDraft = async () => {
    if (!view || view.reviewStatus !== "reviewed") return;
    const result = await api.previewInstallDraft(view.draft.name);
    if (result.ok) setPreview(result.value); else setFailure(studioErrorText(t, result.code));
  };
  const markReviewed = async () => {
    if (!view || !confirmed) return;
    const result = await api.reviewDraft(view.draft.name, view.treeDigest);
    if (result.ok) showView(result.value); else setFailure(studioErrorText(t, result.code));
  };
  const saveReviewEdits = async () => {
    if (!view) return;
    let adaptedHooks: Array<{ index: number; command: string[] }> | undefined;
    if (adaptedHooksConfirmed) {
      try {
        adaptedHooks = hookCommands.map((value, index) => ({ index, command: JSON.parse(value) as string[] }));
      } catch { setFailure(t("pluginStudio.invalidHookArgv")); return; }
    }
    const files = view.files.filter((file) => file.text !== null && file.path !== "plugin.json" && file.path !== "ai.agent-connector.ave/provenance.json"
      && fileEdits[file.path] !== file.text).map((file) => ({ path: file.path, text: fileEdits[file.path] ?? "" }));
    const result = await api.writeDraft({ name: view.draft.name, version: reviewVersion, description: reviewDescription, files,
      ...(adaptedHooks ? { adaptedHooks } : {}) });
    if (result.ok) { showView(result.value); setFailure(""); } else setFailure(studioErrorText(t, result.code));
  };
  const confirmConnector = async (serverId: string) => {
    if (!view) return;
    const preview = connectorPreviews[serverId];
    if (!preview) return;
    const result = await api.confirmConnectorCopy(view.draft.name, serverId, {
      specDigest: preview.specDigest,
      args: preview.args.filter((item) => connectorConfirmed[`arg:${serverId}:${item.index}`]).map(({ index, digest }) => ({ index, digest })),
      env: preview.env.filter((item) => connectorConfirmed[`env:${serverId}:${item.name}`]).map(({ name, digest }) => ({ name, digest })),
    });
    if (result.ok) { showView(result.value); setFailure(""); }
    else setFailure(studioErrorText(t, result.code));
  };
  const share = async () => {
    if (!view) return;
    const result = await api.exportDraft(view.draft.name, projection);
    if (!result.ok) setFailure(studioErrorText(t, result.code));
  };
  const shareCheckout = async () => {
    if (!view) return;
    const result = await api.exportToCheckout(view.draft.name);
    if (result.ok && result.value) setCheckoutSteps([result.value.path, ...result.value.steps]);
    else if (!result.ok) setFailure(studioErrorText(t, result.code));
  };
  const reviewed = view?.reviewStatus === "reviewed";
  return <div className="mt-3 space-y-4" data-testid="plugin-studio">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => void importPackage()} data-testid="plugin-studio:import">{t("pluginStudio.import")}</Button>
      <Button size="sm" variant="outline" onClick={() => void installFile()} data-testid="plugin-studio:install-file">{t("pluginStudio.installFile")}</Button>
    </div>
    {failure && <p className="text-sm text-destructive" role="alert">{failure}</p>}
    {view ? <div className="space-y-3" data-testid="plugin-studio:review">
      <div className="flex items-center justify-between"><h3 className="text-base font-semibold">{t("pluginStudio.reviewTitle", { name: view.draft.name })}</h3><Button size="sm" variant="ghost" onClick={() => setView(null)}>{t("pluginStudio.back")}</Button></div>
      {view.reviewStatus === "needs-review" && <p className="text-xs text-muted-foreground" data-testid="plugin-studio:review-status">{t("pluginStudio.needsReview")}</p>}
      <DiagnosticGroup title={t("pluginStudio.lost")} diagnostics={view.diagnostics.filter((item) => item.group === "lost")} />
      <DiagnosticGroup title={t("pluginStudio.rewritten")} diagnostics={view.diagnostics.filter((item) => item.group === "rewritten")} />
      <DiagnosticGroup title={t("pluginStudio.needsInput")} diagnostics={view.diagnostics.filter((item) => item.group === "needs-input")} />
      {view.connectorStatuses.map((status) => {
        const connector = connectorPreviews[status.serverId];
        return <section key={status.serverId} className="space-y-2 rounded-md border p-3 text-xs" data-testid={`plugin-studio:connector:${status.serverId}`}>
          <h4 className="text-sm font-semibold">{t("pluginStudio.confirmConnector", { name: status.serverId })}</h4>
          <p>{t("pluginStudio.connectorStatus", { status: status.status === "confirmed" ? t("pluginStudio.connectorConfirmed")
            : status.status === "stale" ? t("pluginStudio.connectorStale") : t("pluginStudio.connectorPending"),
            confirmed: status.confirmedArgs + status.confirmedEnv, total: status.argsCount + status.envCount })}</p>
          {connector && <>
            <pre className="overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify(connector.spec, null, 2)}</pre>
            {connector.args.map((item) => <label key={`arg:${item.index}`} className="flex items-start gap-2">
              <Checkbox data-testid={`plugin-studio:confirm-arg:${status.serverId}:${item.index}`}
                checked={connectorConfirmed[`arg:${status.serverId}:${item.index}`] === true}
                onCheckedChange={(value) => setConnectorConfirmed((current) => ({ ...current, [`arg:${status.serverId}:${item.index}`]: value === true }))} />
              <span><code>args[{item.index}] = {item.value}</code>{item.warning && <span className="block text-warning">{item.warning}</span>}</span>
            </label>)}
            {connector.env.map((item) => <label key={`env:${item.name}`} className="flex items-start gap-2">
              <Checkbox data-testid={`plugin-studio:confirm-env:${status.serverId}:${item.name}`}
                checked={connectorConfirmed[`env:${status.serverId}:${item.name}`] === true}
                onCheckedChange={(value) => setConnectorConfirmed((current) => ({ ...current, [`env:${status.serverId}:${item.name}`]: value === true }))} />
              <span><code>env.{item.name} = {item.value}</code>{item.warning && <span className="block text-warning">{item.warning}</span>}</span>
            </label>)}
            <Button size="sm" variant="outline" onClick={() => void confirmConnector(status.serverId)} data-testid={`plugin-studio:confirm-connector:${status.serverId}`}>{t("pluginStudio.saveConnectorConfirmation")}</Button>
          </>}
        </section>;
      })}
      {view.errors.map((error, index) => <p key={index} className="text-xs text-destructive">{error}</p>)}
      <div className="grid gap-2 sm:grid-cols-2"><Input value={reviewVersion} onChange={(event) => setReviewVersion(event.target.value)} aria-label={t("pluginStudio.version")} /><Input value={reviewDescription} onChange={(event) => setReviewDescription(event.target.value)} aria-label={t("pluginStudio.description")} /></div>
      {view.draft.pendingHooks.map((hook, index) => <div key={index} className="space-y-1 rounded border p-2 text-xs" data-testid={`plugin-studio:pending-hook:${index}`}><strong>{hook.event} · {t("pluginStudio.needsAdaptation")}</strong><p>{hook.sourcePath}</p><p>{t("pluginStudio.hookAdaptation")}</p><Textarea value={hookCommands[index] ?? ""} onChange={(event) => setHookCommands((current) => current.map((value, i) => i === index ? event.target.value : value))} aria-label={`${hook.event} argv`} /></div>)}
      {view.draft.pendingHooks.length > 0 && <label className="flex items-center gap-2 text-xs"><Checkbox checked={adaptedHooksConfirmed} onCheckedChange={(value) => setAdaptedHooksConfirmed(value === true)} />{t("pluginStudio.hooksConfirmed")}</label>}
      <Button size="sm" variant="outline" onClick={() => void saveReviewEdits()} data-testid="plugin-studio:save-review">{t("pluginStudio.saveReview")}</Button>
      {view.lint.length > 0 && <section className="rounded-md border p-3"><h4 className="text-sm font-semibold">{t("pluginStudio.lintTitle")}</h4><p className="text-xs text-muted-foreground">{t("pluginStudio.lintAdvisory")}</p><ul className="list-disc pl-5 text-xs">{view.lint.map((item, index) => <li key={index}>{item.path}: {item.message} · <code>{item.matched}</code></li>)}</ul></section>}
      {view.files.map((file) => <section key={file.path} className="space-y-1 border-t pt-2"><h4 className="font-mono text-xs font-semibold">{file.path}</h4>{file.text !== null && (/^skills\/[a-z][a-z0-9-]*\/SKILL\.md$/u.test(file.path) || /^ai\.agent-connector\.ave\/prompts\/[a-z][a-z0-9-]*\.md$/u.test(file.path) || file.path === "ai.agent-connector.ave/routines.json" || file.path === "mcp.json")
        ? <Textarea className="min-h-28 font-mono text-xs" value={fileEdits[file.path] ?? ""} onChange={(event) => setFileEdits((current) => ({ ...current, [file.path]: event.target.value }))} aria-label={file.path} />
        : <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{file.text ?? t("pluginStudio.binaryFile")}</pre>}</section>)}
      <div className="flex flex-wrap items-center gap-3"><Button disabled={!reviewed} onClick={() => void installDraft()} data-testid="plugin-studio:install">{t("pluginStudio.install")}</Button>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={confirmed} onCheckedChange={(value) => setConfirmed(value === true)} />{t("pluginStudio.readConfirm")}</label>
        <Button size="sm" variant="outline" disabled={!confirmed || view.errors.length > 0 || reviewed} onClick={() => void markReviewed()} data-testid="plugin-studio:mark-reviewed">{t("pluginStudio.markReviewed")}</Button>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={projection} onCheckedChange={(value) => setProjection(value === true)} />{t("pluginStudio.legacyProjection")}</label>
        <Button size="sm" variant="outline" disabled={!reviewed} onClick={() => void share()} data-testid="plugin-studio:share">{t("pluginStudio.share")}</Button>
        <Button size="sm" variant="outline" disabled={!reviewed} onClick={() => void shareCheckout()} data-testid="plugin-studio:share-checkout">{t("pluginStudio.shareCheckout")}</Button>
      </div>
      {checkoutSteps.length > 0 && <ol className="list-decimal pl-5 text-xs" data-testid="plugin-studio:checkout-steps">{checkoutSteps.map((step) => <li key={step}>{step}</li>)}</ol>}
    </div> : <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t("pluginStudio.createTitle")}</h3>
      <div className="grid gap-2 sm:grid-cols-2"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("pluginStudio.name")} aria-label={t("pluginStudio.name")} data-testid="plugin-studio:name" /><Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder={t("pluginStudio.version")} aria-label={t("pluginStudio.version")} data-testid="plugin-studio:version" /></div>
      <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("pluginStudio.description")} aria-label={t("pluginStudio.description")} data-testid="plugin-studio:description" />
      {available && <div className="grid gap-2 sm:grid-cols-2">{(["skills", "routines", "connectors", "prompts", "agents"] as const).map((group) => <fieldset key={group} className="rounded border p-2"><legend className="px-1 text-xs font-semibold">{t(`pluginStudio.${group}`)}</legend>{available[group].map((item) => <label key={item.name} className="flex items-center gap-2 text-xs"><Checkbox data-testid={`plugin-studio:select:${group.slice(0, -1)}:${item.name}`} checked={selected[`${group.slice(0, -1)}:${item.name}`] === true} onCheckedChange={(value) => setSelected((current) => ({ ...current, [`${group.slice(0, -1)}:${item.name}`]: value === true }))} />{item.name} · {item.description}</label>)}</fieldset>)}</div>}
      <p className="text-xs text-muted-foreground">{t("pluginStudio.hooksNotComposable")}</p>
      <div className="grid gap-2 sm:grid-cols-2"><Input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder={t("pluginStudio.newSkillName")} aria-label={t("pluginStudio.newSkillName")} /><Input value={promptName} onChange={(event) => setPromptName(event.target.value)} placeholder={t("pluginStudio.newPromptName")} aria-label={t("pluginStudio.newPromptName")} /><Textarea value={skillBody} onChange={(event) => setSkillBody(event.target.value)} placeholder={t("pluginStudio.newSkillBody")} aria-label={t("pluginStudio.newSkillBody")} /><Textarea value={promptBody} onChange={(event) => setPromptBody(event.target.value)} placeholder={t("pluginStudio.newPromptBody")} aria-label={t("pluginStudio.newPromptBody")} /></div>
      <Button disabled={busy} onClick={() => void create()} data-testid="plugin-studio:create">{t("pluginStudio.create")}</Button>
      {drafts.length > 0 && <section className="space-y-1"><h3 className="text-sm font-semibold">{t("pluginStudio.drafts")}</h3>{drafts.map((draft) => <Button key={draft.name} size="sm" variant="ghost" onClick={() => void open(draft.name)}>{draft.name}</Button>)}</section>}
    </div>}
    <LocalPluginPackageSheet api={api} preview={preview} onClose={() => setPreview(null)} onInstalled={onInstalled} />
  </div>;
}
