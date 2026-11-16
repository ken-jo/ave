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

export function BrowserPagePrompts({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
  const prompt = useBrowserPageStatus(tabId)?.prompts[0];
  if (!prompt) return null;
  return (
    <section role="alertdialog" aria-label={t("browserWorkspace.permissionPrompt.title")} data-native-page-chrome="background"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/(--opacity-muted) px-3 py-2"
      data-testid="browser-page-prompt" data-kind={prompt.kind} data-tab-id={tabId}>
      <PermissionPrompt tabId={tabId} prompt={prompt} />
    </section>
  );
}
