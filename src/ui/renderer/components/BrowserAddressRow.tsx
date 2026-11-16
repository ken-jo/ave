/** The one address row every browser host draws: a user tab in the side panel, a web pane, and a tab the agent opened. */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import { navigateBrowserSurface, useBrowserSurface, useGuestNavigation } from "../hooks/use-browser-navigation.js";
import { navigateBrowserTabAsUser } from "../preview/agent-browser-bridge.js";
import { resolveAddressSubmission } from "../preview/url-safety.js";
import { validateExternalUrl } from "../../../shared/external-url.js";

export interface BrowserAddressRowTestIds {
  readonly back: string; readonly forward: string; readonly reload: string; readonly address: string;
  readonly go: string; readonly openExternal: string; readonly error: string;
}

export const SIDE_PANEL_ADDRESS_ROW_TEST_IDS: BrowserAddressRowTestIds = {
  back: "browser-back", forward: "browser-forward", reload: "browser-reload", address: "chat-side-panel-browser-address",
  go: "chat-side-panel-browser-go", openExternal: "chat-side-panel-browser-open-external", error: "chat-side-panel-browser-address-error",
};
export const WEB_PANEL_ADDRESS_ROW_TEST_IDS: BrowserAddressRowTestIds = {
  back: "web-panel-back", forward: "web-panel-forward", reload: "web-panel-reload", address: "web-panel-address",
  go: "web-panel-go", openExternal: "web-panel-open-external", error: "web-panel-address-error",
};

/**
 * Back, forward, reload, the address field, Go and open-in-system-browser for one browser tab.
 *
 * Every action is the user's: it first takes the tab back from the agent (`navigateBrowserTabAsUser`), so a tab the agent
 * opened is driven from here exactly like one the user opened.
 *
 * The field holds a draft only while the user is editing it. A page that reports a new address meanwhile (a load
 * finishing, a redirect) does not erase the draft; leaving the field, Escape, and back, forward or reload put the page's
 * real address back, so the row never shows a typed address over a page it is not showing.
 */
export function BrowserAddressRow({ api, tabId, fallbackUrl, onNavigate, chrome, testIds }: {
  api: AveApi;
  tabId: string;
  /** The address the host pointed the tab at, shown until the page reports its own. */
  fallbackUrl: string | null;
  /** Point the tab at `url`. Called only after the takeover succeeded. */
  onNavigate: (url: string) => void;
  /** Which host surface the row sits on, for the native page layer's chrome treatment. */
  chrome: "background" | "card";
  testIds: BrowserAddressRowTestIds;
}) {
  const { t } = useTranslation();
  const surface = useBrowserSurface(tabId);
  const navigation = useGuestNavigation(surface);
  const reported = navigation.url ?? fallbackUrl ?? "";
  // An empty bootstrap page has no address a person would recognise or retype.
  const currentAddress = reported === "about:blank" ? "" : reported;
  const [draft, setDraft] = useState(currentAddress);
  const [error, setError] = useState<string | null>(null);
  const draftEditedForTab = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const goRef = useRef<HTMLButtonElement | null>(null);

  const discardDraft = () => {
    draftEditedForTab.current = null;
    setDraft(currentAddress);
    setError(null);
  };
  useEffect(() => {
    if (draftEditedForTab.current === tabId) return;
    draftEditedForTab.current = null;
    setDraft(currentAddress);
    setError(null);
  }, [currentAddress, tabId]);

  const act = (action: "back" | "forward" | "reload") => {
    discardDraft();
    void navigateBrowserTabAsUser(api, tabId, () => navigateBrowserSurface(surface, action));
  };
  const submit = async () => {
    const target = await resolveAddressSubmission(api, draft);
    if (!target) {
      setError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    draftEditedForTab.current = null;
    setDraft(target.url);
    setError(null);
    void navigateBrowserTabAsUser(api, tabId, () => onNavigate(target.url));
  };
  // Only an address the page actually reported, or the host set, as a complete http(s) URL leaves the app: no scheme is
  // guessed for the system browser.
  const checked = validateExternalUrl(currentAddress);
  const externalUrl = checked.ok ? checked.url : null;

  const iconButton = (label: string, testId: string, icon: React.ReactNode, onClick: () => void, disabled: boolean) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={label} disabled={disabled}
          onClick={onClick} data-testid={testId}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      <form
        data-native-page-chrome={chrome}
        data-testid="browser-address-row"
        data-tab-id={tabId}
        className="flex shrink-0 items-center gap-1 border-b px-2 py-1"
        onBlur={(event) => {
          // The draft lives while focus stays on the field or the Go button that submits it; focus going anywhere else,
          // from either of them, drops it. Switching away from the whole window is not leaving the edit: focus comes back to
          // the field when the window does, so the draft stays.
          const left: EventTarget = event.target;
          const next: EventTarget | null = event.relatedTarget;
          if (left !== inputRef.current && left !== goRef.current) return;
          if (next === inputRef.current || next === goRef.current) return;
          if (next === null && !document.hasFocus()) return;
          discardDraft();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {iconButton(t("mainPanels.back"), testIds.back, <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />, () => act("back"), !navigation.canGoBack)}
        {iconButton(t("mainPanels.forward"), testIds.forward, <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />, () => act("forward"), !navigation.canGoForward)}
        {iconButton(t("mainPanels.reload"), testIds.reload, <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />, () => act("reload"), !surface || !currentAddress)}
        <Globe className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={inputRef}
          data-testid={testIds.address}
          aria-label={t("browserAddressRow.address")}
          value={draft}
          onChange={(event) => {
            draftEditedForTab.current = tabId;
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") discardDraft();
          }}
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="submit" size="icon" variant="ghost" className="h-7 w-7 shrink-0" ref={goRef}
              aria-label={t("chatPreviewRail.browserGo")} data-testid={testIds.go}>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.browserGo")}</TooltipContent>
        </Tooltip>
        {iconButton(t("chatPreviewRail.openUrl"), testIds.openExternal, <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />,
          () => { if (externalUrl) void api.openExternalUrl(externalUrl); }, externalUrl === null)}
      </form>
      {error ? (
        <div role="alert" className="shrink-0 border-b px-3 py-1.5 text-dense text-destructive" data-native-page-chrome="background" data-testid={testIds.error}>
          {error}
        </div>
      ) : null}
    </>
  );
}
