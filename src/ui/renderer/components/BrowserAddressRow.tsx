/** The one address row every browser host draws: a user tab in the side panel, a web pane, and a tab the agent opened. */
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import type { AveApi } from "../types.js";
import { navigateBrowserSurface, useBrowserSurface, useGuestNavigation } from "../hooks/use-browser-navigation.js";
import { loadBrowserPageUrl, navigateBrowserPageAsUser, stopBrowserPageLoad, useBrowserPageStatus, useBrowserWorkspaceSnapshot } from "../preview/browser-page-status.js";
import { BrowserPagePrompts } from "./BrowserPagePrompts.js";
import { BrowserSiteInfo } from "./BrowserSiteInfo.js";
import { resolveAddressSubmission } from "../preview/url-safety.js";
import { browserAddressSuggestions } from "../preview/browser-address-suggestions.js";
import { validateExternalUrl } from "../../../shared/external-url.js";

/** The zoom levels the row offers; a level set elsewhere is listed as its own option. */
const BROWSER_ZOOM_FACTORS: readonly number[] = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export interface BrowserAddressRowTestIds {
  readonly back: string; readonly forward: string; readonly reload: string; readonly stop: string; readonly address: string;
  readonly go: string; readonly openExternal: string; readonly error: string;
}

export const SIDE_PANEL_ADDRESS_ROW_TEST_IDS: BrowserAddressRowTestIds = {
  back: "browser-back", forward: "browser-forward", reload: "browser-reload", stop: "browser-stop", address: "chat-side-panel-browser-address",
  go: "chat-side-panel-browser-go", openExternal: "chat-side-panel-browser-open-external", error: "chat-side-panel-browser-address-error",
};
export const WEB_PANEL_ADDRESS_ROW_TEST_IDS: BrowserAddressRowTestIds = {
  back: "web-panel-back", forward: "web-panel-forward", reload: "web-panel-reload", stop: "web-panel-stop", address: "web-panel-address",
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
  const status = useBrowserPageStatus(tabId);
  const loading = status?.loading ?? false;
  // A failed load leaves the previous page's address in the guest; the row keeps showing the address that failed.
  const reported = (status?.loadError?.url || null) ?? navigation.url ?? fallbackUrl ?? "";
  // An empty bootstrap page has no address a person would recognise or retype.
  const currentAddress = reported === "about:blank" ? "" : reported;
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const snapshot = useBrowserWorkspaceSnapshot();
  const zoomTab = snapshot?.tabs.find((candidate) => candidate.tabId === tabId);
  const [suggestionIndex, setSuggestionIndex] = useState<number | null>(null);
  const suggestionListId = useId();
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
  // A submitted address that never became the page's (the load was stopped, or it was a download) must not stay in the
  // row over a page it does not describe: when a load ends, the row returns to the real address.
  const wasLoading = useRef(false);
  useEffect(() => {
    const ended = wasLoading.current && !loading;
    wasLoading.current = loading;
    if (ended && draftEditedForTab.current !== tabId) setDraft(currentAddress);
  }, [loading, currentAddress, tabId]);

  const act = (action: "back" | "forward" | "reload") => {
    discardDraft();
    navigateBrowserPageAsUser(api, tabId, () => navigateBrowserSurface(surface, action));
  };
  const open = (url: string) => {
    draftEditedForTab.current = null;
    setDraft(url);
    setError(null);
    setSuggestionIndex(null);
    navigateBrowserPageAsUser(api, tabId, () => {
      onNavigate(url);
      // Entering the address the tab is already pointed at changes nothing for the host, so the page is loaded directly.
      if (url === fallbackUrl) loadBrowserPageUrl(tabId, url);
    });
  };
  const submit = async () => {
    const target = await resolveAddressSubmission(api, draft);
    if (!target) {
      setError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    open(target.url);
  };
  // Suggestions exist only while the user is editing this tab's address; they come from this device's own library.
  const suggestions = draftEditedForTab.current === tabId ? browserAddressSuggestions(snapshot, draft) : [];
  const chosen = suggestionIndex !== null ? suggestions[suggestionIndex] : undefined;
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
        className="relative flex shrink-0 items-center gap-1 border-b px-2 py-1"
        aria-busy={loading}
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
          if (chosen) open(chosen.url); else void submit();
        }}
      >
        {iconButton(t("mainPanels.back"), testIds.back, <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />, () => act("back"), !navigation.canGoBack)}
        {iconButton(t("mainPanels.forward"), testIds.forward, <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />, () => act("forward"), !navigation.canGoForward)}
        {/* One slot: while the page loads the control stops the load, otherwise it reloads. */}
        {loading
          ? iconButton(t("browserAddressRow.stop"), testIds.stop, <X className="h-3.5 w-3.5" aria-hidden="true" />, () => { discardDraft(); stopBrowserPageLoad(tabId); }, false)
          : iconButton(t("mainPanels.reload"), testIds.reload, <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />, () => act("reload"), !surface || !currentAddress)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t("browserSiteInfo.title")} aria-expanded={siteInfoOpen}
              disabled={!api.browserWorkspace} onClick={() => setSiteInfoOpen((open) => !open)} data-testid="browser-site-info-toggle">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("browserSiteInfo.title")}</TooltipContent>
        </Tooltip>
        <Input
          ref={inputRef}
          data-testid={testIds.address}
          aria-label={t("browserAddressRow.address")}
          value={draft}
          onChange={(event) => {
            draftEditedForTab.current = tabId;
            setDraft(event.target.value);
            setSuggestionIndex(null);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { setSuggestionIndex(null); discardDraft(); return; }
            if (suggestions.length === 0 || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
            // The arrows walk the list and step off either end back to the typed text.
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            const next = suggestionIndex === null ? (step === 1 ? 0 : suggestions.length - 1) : suggestionIndex + step;
            setSuggestionIndex(next < 0 || next >= suggestions.length ? null : next);
          }}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestionListId}
          aria-autocomplete="list"
          aria-activedescendant={chosen ? `${suggestionListId}-${suggestionIndex}` : undefined}
          autoComplete="off"
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        {api.browserWorkspace && zoomTab ? (
          <select
            aria-label={t("browserWorkspace.zoom")}
            title={t("browserWorkspace.zoom")}
            data-testid="browser-zoom"
            className="h-7 shrink-0 rounded-md border bg-background px-1 text-xs tabular-nums"
            value={zoomTab.zoomFactor}
            onChange={(event) => { void api.browserWorkspace?.zoom({ tabId, documentGeneration: zoomTab.documentGeneration, factor: Number(event.target.value) }).then((result) => setError(result.ok ? null : t("browserWorkspace.failed"))); }}
          >
            {BROWSER_ZOOM_FACTORS.includes(zoomTab.zoomFactor) ? null : <option value={zoomTab.zoomFactor}>{Math.round(zoomTab.zoomFactor * 100)}%</option>}
            {BROWSER_ZOOM_FACTORS.map((factor) => <option key={factor} value={factor}>{Math.round(factor * 100)}%</option>)}
          </select>
        ) : null}
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
        {loading ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden" data-testid="browser-loading-line" role="progressbar"
            aria-label={t("browserAddressRow.loading")}>
            <div className="browser-loading-line h-full w-1/3 bg-primary" />
          </div>
        ) : null}
      </form>
      {error ? (
        <div role="alert" className="shrink-0 border-b px-3 py-1.5 text-dense text-destructive" data-native-page-chrome="background" data-testid={testIds.error}>
          {error}
        </div>
      ) : null}
      {suggestions.length > 0 ? (
        <div id={suggestionListId} role="listbox" aria-label={t("browserAddressRow.suggestions")} className="shrink-0 border-b py-1 text-xs" data-native-page-chrome={chrome} data-testid="browser-address-suggestions">
          {suggestions.map((suggestion, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard reaches an option through the field that owns this list (arrow keys and Enter there); an option never holds focus itself.
            <div key={suggestion.url} id={`${suggestionListId}-${index}`} role="option" tabIndex={-1} aria-selected={index === suggestionIndex} data-testid="browser-address-suggestion" data-source={suggestion.source}
              className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 ${index === suggestionIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent"}`}
              // Pressing on a suggestion must not take focus from the field first: losing focus drops the draft and the list with it.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => open(suggestion.url)}>
              <span className="min-w-0 truncate">{suggestion.title || suggestion.url}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{suggestion.url}</span>
              <span className="shrink-0 text-muted-foreground">{t(suggestion.source === "bookmark" ? "browserAddressRow.suggestionBookmark" : "browserAddressRow.suggestionHistory")}</span>
            </div>
          ))}
        </div>
      ) : null}
      <BrowserPagePrompts tabId={tabId} />
      {siteInfoOpen && api.browserWorkspace ? <BrowserSiteInfo api={api.browserWorkspace} tabId={tabId} chrome={chrome} /> : null}
    </>
  );
}
