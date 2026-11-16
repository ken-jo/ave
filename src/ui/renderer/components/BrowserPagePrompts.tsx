/**
 * The question a page is waiting on, drawn in the tab's own panel under its address row and titled with the origin main
 * computed. One question at a time, oldest first; nothing the page supplied is rendered as markup.
 */
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import type { BrowserPagePrompt } from "../../../shared/browser-workspace.js";
import { answerBrowserPagePrompt, useBrowserPageStatus } from "../preview/browser-page-status.js";

function PermissionPrompt({ tabId, prompt }: { tabId: string; prompt: Extract<BrowserPagePrompt, { kind: "permission" }> }) {
  const { t } = useTranslation();
  const answer = (choice: "allow-once" | "block" | "always-block") => answerBrowserPagePrompt(tabId, prompt.id, { kind: "permission", choice });
  return (
    <>
      <p className="min-w-0 flex-1 text-xs">
        <span className="break-all font-medium" data-testid="browser-page-prompt-origin">{prompt.origin}</span>{" "}
        {t("browserPagePrompt.permission.wants", { permissions: prompt.permissions.map((permission) => t(`browserWorkspace.permission.${permission}`)).join(", ") })}
      </p>
      <div className="flex shrink-0 flex-wrap gap-1">
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer("allow-once")} data-testid="browser-page-prompt-allow-once">
          {t("browserWorkspace.permissionPrompt.allowOnce")}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer("block")} data-testid="browser-page-prompt-block">
          {t("browserWorkspace.permissionPrompt.block")}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer("always-block")} data-testid="browser-page-prompt-always-block">
          {t("browserPagePrompt.permission.alwaysBlock")}
        </Button>
      </div>
    </>
  );
}

function LeavePrompt({ tabId, prompt }: { tabId: string; prompt: Extract<BrowserPagePrompt, { kind: "leave" }> }) {
  const { t } = useTranslation();
  const answer = (leave: boolean) => answerBrowserPagePrompt(tabId, prompt.id, { kind: "leave", leave });
  return (
    <>
      <p className="min-w-0 flex-1 text-xs">
        <span className="break-all font-medium" data-testid="browser-page-prompt-origin">{prompt.origin}</span>{" "}
        {t("browserPagePrompt.leave.message")}
      </p>
      <div className="flex shrink-0 flex-wrap gap-1">
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer(true)} data-testid="browser-page-prompt-leave">
          {t("browserPagePrompt.leave.leave")}
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer(false)} data-testid="browser-page-prompt-stay">
          {t("browserPagePrompt.leave.stay")}
        </Button>
      </div>
    </>
  );
}

function ExternalPrompt({ tabId, prompt }: { tabId: string; prompt: Extract<BrowserPagePrompt, { kind: "external" }> }) {
  const { t } = useTranslation();
  const answer = (open: boolean) => answerBrowserPagePrompt(tabId, prompt.id, { kind: "external", open });
  return (
    <>
      <p className="min-w-0 flex-1 text-xs">
        <span className="break-all font-medium" data-testid="browser-page-prompt-origin">{prompt.origin}</span>{" "}
        {prompt.openable
          ? t(prompt.scheme === "mailto" ? "browserPagePrompt.external.mail" : "browserPagePrompt.external.phone")
          : t("browserPagePrompt.external.unsupported", { scheme: prompt.scheme })}
        {prompt.openable && prompt.target ? <span className="break-all font-mono" data-testid="browser-page-prompt-target"> {prompt.target}</span> : null}
      </p>
      <div className="flex shrink-0 flex-wrap gap-1">
        {prompt.openable ? (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer(true)} data-testid="browser-page-prompt-open">
            {t("browserPagePrompt.external.open")}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => answer(false)} data-testid="browser-page-prompt-dismiss">
          {t(prompt.openable ? "browserPagePrompt.external.cancel" : "browserPagePrompt.external.dismiss")}
        </Button>
      </div>
    </>
  );
}

const PROMPT_TITLES = {
  permission: "browserWorkspace.permissionPrompt.title", leave: "browserPagePrompt.leave.title", external: "browserPagePrompt.external.title",
} as const;

export function BrowserPagePrompts({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const prompt = useBrowserPageStatus(tabId)?.prompts[0];
  if (!prompt) return null;
  return (
    <section role="alertdialog" aria-label={t(PROMPT_TITLES[prompt.kind])} data-native-page-chrome="background"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/(--opacity-muted) px-3 py-2"
      data-testid="browser-page-prompt" data-kind={prompt.kind} data-tab-id={tabId}>
      {prompt.kind === "permission" ? <PermissionPrompt tabId={tabId} prompt={prompt} /> : null}
      {prompt.kind === "leave" ? <LeavePrompt tabId={tabId} prompt={prompt} /> : null}
      {prompt.kind === "external" ? <ExternalPrompt tabId={tabId} prompt={prompt} /> : null}
    </section>
  );
}
