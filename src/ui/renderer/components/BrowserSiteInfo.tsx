/**
 * What the host knows about the site a tab shows, opened from the address row: how the page was reached, what this site
 * may use, its stored data, and what the agent of the owning conversation may open here. Every value is the host's own;
 * the page supplies none of it.
 */
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { BROWSER_SITE_DECISIONS, BROWSER_SITE_PERMISSIONS, browserWorkspaceUrl, type BrowserAgentSiteGrant, type BrowserSiteDecision, type BrowserWorkspaceApi } from "../../../shared/browser-workspace.js";
import { useBrowserWorkspaceSnapshot } from "../preview/browser-page-status.js";

export function BrowserSiteInfo({ api, tabId, chrome }: { api: BrowserWorkspaceApi; tabId: string; chrome: "background" | "card" }) {
  const { t } = useTranslation();
  const snapshot = useBrowserWorkspaceSnapshot();
  const tab = snapshot?.tabs.find((candidate) => candidate.tabId === tabId);
  const url = browserWorkspaceUrl(tab?.url);
  const origin = url ? new URL(url).origin : null;
  const generation = tab?.documentGeneration;
  const [grant, setGrant] = useState<BrowserAgentSiteGrant["grant"] | undefined>(undefined);
  const [cleared, setCleared] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setGrant(undefined); setCleared(false); setFailed(false);
    if (origin === null || generation === undefined) return;
    let current = true;
    // A read that failed is not an answer: the agent's access stays unknown and the failure is shown, never "no access".
    void api.agentSiteGrant({ tabId, documentGeneration: generation, origin }).then((result) => {
      if (!current) return;
      if (result.ok) setGrant(result.value.grant);
      else setFailed(true);
    });
    return () => { current = false; };
  }, [api, tabId, generation, origin]);
  if (!snapshot || !tab || origin === null || generation === undefined) {
    return <section className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground" data-native-page-chrome={chrome} data-testid="browser-site-info">{t("browserSiteInfo.noSite")}</section>;
  }
  const target = { tabId, documentGeneration: generation };
  const secure = origin.startsWith("https://");
  const decision = (permission: string): BrowserSiteDecision => snapshot.sitePermissions.find((rule) => rule.origin === origin && rule.permission === permission)?.decision ?? "ask";
  return (
    <section aria-label={t("browserSiteInfo.title")} className="shrink-0 space-y-2 border-b px-3 py-2 text-xs" data-native-page-chrome={chrome} data-testid="browser-site-info">
      <p className="break-all font-medium" data-testid="browser-site-info-origin">{origin}</p>
      <p data-testid="browser-site-info-connection" data-secure={secure}>{t(secure ? "browserSiteInfo.secure" : "browserSiteInfo.notSecure")}</p>
      <div className="grid grid-cols-2 gap-1">
        {BROWSER_SITE_PERMISSIONS.filter((permission) => permission !== "fullscreen" || snapshot.capabilities.fullscreen).map((permission) => (
          <label key={permission} className="flex items-center justify-between gap-2">{t(`browserWorkspace.permission.${permission}`)}
            <select className="rounded border bg-background p-1" aria-label={t(`browserWorkspace.permission.${permission}`)} value={decision(permission)} data-testid={`browser-site-info-permission-${permission}`}
              onChange={(event) => { void api.setSitePermission({ ...target, origin, permission, decision: event.target.value as BrowserSiteDecision }).then((result) => setFailed(!result.ok)); }}>
              {BROWSER_SITE_DECISIONS.map((option) => <option key={option} value={option}>{t(`browserWorkspace.decision.${option}`)}</option>)}
            </select>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" data-testid="browser-site-info-clear"
          onClick={() => { void api.clearSiteData({ ...target, origin }).then((result) => { setCleared(result.ok); setFailed(!result.ok); }); }}>{t("browserWorkspace.clearSiteData")}</Button>
        {cleared ? <span role="status" className="text-muted-foreground" data-testid="browser-site-info-cleared">{t("browserWorkspace.siteDataCleared")}</span> : null}
      </div>
      {grant === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2" data-testid="browser-site-info-agent" data-grant={grant ?? "none"}>
          <span>{t(grant === "any-site" ? "browserSiteInfo.agentAny" : grant === "this-site" ? "browserSiteInfo.agentSite" : "browserSiteInfo.agentNone")}</span>
          {grant === null ? null : (
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" data-testid="browser-site-info-revoke"
              onClick={() => { void api.revokeAgentSiteGrant({ ...target, origin }).then((result) => { if (result.ok) setGrant(null); else setFailed(true); }); }}>{t("browserSiteInfo.revoke")}</Button>
          )}
        </div>
      )}
      {failed ? <p role="alert" className="text-destructive">{t("browserWorkspace.failed")}</p> : null}
    </section>
  );
}
