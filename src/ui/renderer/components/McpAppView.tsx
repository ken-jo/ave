/** Use a per-server partition with no node integration and isolated context. A CSP-protected proxy embeds the app in a
 * sandboxed inner frame so window.parent is a distinct frame; bridge messages cross the relay preload and webview IPC. */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiPayload, McpUiResourceBundle } from "../../../mcp/types.js";
import { Loader2, AlertCircle, PlugZap, ExternalLink } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { mcpAppPartitionName } from "../../../shared/mcp-app-partition.js";
// The card-size bounds SoT. `ui/notifications/size-changed` and the payload's `height`
// seed are UNTRUSTED numbers, and CSS cannot bound them (the card's containing block has
// an indefinite height, so a percentage max-height resolves to `none`) — so they are
// clamped arithmetically, at the one sink that turns them into pixels.
import {
  clampMcpAppCardSize,
  mcpAppCardSeedHeight,
  type McpAppCardSize,
} from "../../../shared/mcp-app-card-size.js";
import { useOptionalTheme, findBundle, bundleToPluginTokens, DEFAULT_BUNDLE_ID } from "../theme/index.js";
// The host-side wiring lives in its own React-free module so the real-<webview> e2e gate can import and exercise THE
// SHIPPING WIRING rather than a look-alike copy.
import { createMcpAppBridge } from "./mcp-app-bridge.js";
// Standard ext-apps `McpUiHostContext` builder (theme/locale/timeZone → standard style-variable vocabulary). React-free so
// it stays importable by the e2e gate.
import { buildMcpAppHostContext } from "./mcp-app-host-context.js";
// The display-mode SoT: what the host advertises (`availableDisplayModes`) AND what the `onrequestdisplaymode` handler
// will accept — one module, so they cannot drift.
import {
  MCP_APP_DEFAULT_DISPLAY_MODE,
  type McpUiDisplayMode,
} from "../../../shared/mcp-app-display-mode.js";
import type { BridgeWebviewElement, WebviewIpcTransport } from "./webview-ipc-transport.js";
// The renderer-side location authority: which of a card's THREE possible mounts
// (inline home / pip panel / fullscreen panel) is the currently live one. See
// `mcp-app-card-location-store.ts` for why this moved out of local mount state — an
// away panel is a DIFFERENT component than the card's home mount, so "where is this
// card" can no longer be a boolean local to whichever mount happened to start the
// move.
import {
  getCardLocation,
  moveCard,
  reviveCardIfAt,
  subscribeCardLocation,
} from "../state/mcp-app-card-location-store.js";
// `openExternalUrl` (the `onopenlink` egress path) lives on `window.aveApi`, reached through the renderer's `getApi()` —
// NOT `window.ave` (a curated subset without it).
import { getApi } from "../api-client.js";
// The card's ORIGIN chat session — the second binding `onmessage` needs (see below). Optional: this component also mounts
// outside the chat subtree.
import { useOptionalChatContext } from "../context/ChatContext.js";
import { hostTimeZone } from "../../../shared/format-time.js";
import { errorMessage } from "../../../shared/error-message.js";

/** Extract the `?t=<token>` proxy-session token from a `ave-mcp-app://` URL. */
function tokenFromProxyUrl(proxyUrl: string): string | null {
  try {
    return new URL(proxyUrl).searchParams.get("t");
  } catch {
    return null;
  }
}

export function McpAppView({
  payload,
  /** A mount's display mode is fixed; mode changes move the card to another mount and retire the losing bridge. */
  displayMode: mountDisplayMode = MCP_APP_DEFAULT_DISPLAY_MODE,
  /**
   * The card's ORIGIN chat session, threaded in by a mount with no `ChatContext`
   * ancestor, or by an away panel rendering on a home mount's behalf. Without it such
   * a card would post `sessionId: ""`, main would drop every `ui/message` /
   * `ui/update-model-context` on the session check, and the app (whose
   * `ui/update-model-context` has no error channel in the spec) would never find out.
   */
  originSessionId,
  /** Home mints a stable location id and passes it to away mounts; per-mount model-context ids are separate. */
  locationId,
}: {
  payload: McpUiPayload;
  displayMode?: McpUiDisplayMode;
  originSessionId?: string;
  locationId?: string;
}) {
  const { t, locale } = useTranslation();
  // Translate standard theme context without exposing host tokens; isolated mounts without a theme provider use the light
  // default.
  const themeCtx = useOptionalTheme();
  // The theme `:root` holds and its revision: shell and tokens both come from
  // it, and only once it is written. `resolved` and `effectiveBundleId` change
  // before the write, so a context built from them would pair the old shell
  // with the new tokens (or the new with :root's old values) for a render.
  const appliedBundle = themeCtx?.appliedBundle ?? findBundle(DEFAULT_BUNDLE_ID);
  const appliedRevision = themeCtx?.appliedRevision ?? 0;

  // Latch the card's origin session; stale-card messages must not enter a newly selected conversation. Missing origin never
  // matches a live session.
  const chatCtx = useOptionalChatContext();
  const originSessionIdRef = useRef("");
  if (originSessionIdRef.current === "") {
    originSessionIdRef.current = originSessionId ?? chatCtx?.currentSessionId ?? "";
  }

    // `ui/update-model-context` OVERWRITES one slot per card, so main needs to know WHICH
  // card is speaking. The id is minted HERE, in the trusted renderer, once per mount: the
  // app never sees it and cannot name one, so it can only ever overwrite its own slot.
  const cardIdRef = useRef("");
  if (cardIdRef.current === "") cardIdRef.current = crypto.randomUUID();

    // See the `locationId` prop doc above. Minted once (seeded from the prop when this is
  // an AWAY mount rendering on a home's behalf), stable for the mount's lifetime.
  const cardLocationIdRef = useRef("");
  if (cardLocationIdRef.current === "") cardLocationIdRef.current = locationId ?? crypto.randomUUID();

  const subscribeLocation = useCallback(
    (listener: () => void) => subscribeCardLocation(cardLocationIdRef.current, listener),
    [],
  );
  const getLocationSnapshot = useCallback(
    () => getCardLocation(cardLocationIdRef.current),
    [],
  );
  // Where this card's ONE live mount currently is. For a HOME mount this can drift
  // away from "inline" (the card moved elsewhere) without this mount's OWN
  // `mountDisplayMode` ever changing — that prop is this MOUNT's fixed role, `location`
  // is the CARD's current whereabouts, and only the home mount ever needs to compare
  // the two (see the render branch below).
  const location = useSyncExternalStore(subscribeLocation, getLocationSnapshot);

  const [bundle, setBundle] = useState<McpUiResourceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // b3.3 — disable-in-place on server disconnect. Lives INSIDE McpAppView so
  // every mount site (inline preview rail + away panels) inherits it from
  // one source. Reconnect does NOT auto-re-enable (§3.4): the user re-invokes
  // the tool → a fresh McpUiPayload → a fresh card.
  const [disabled, setDisabled] = useState(false);
  const bridgeRef = useRef<{ bridge: AppBridge; transport: WebviewIpcTransport; token: string | null } | null>(null);

  // Bound both initial and live app sizes through the same validator; retain responsive width until the app declares one.
  const seedHeight = mcpAppCardSeedHeight(payload.height);
  const [size, setSize] = useState<McpAppCardSize>({ height: seedHeight });

  // Clamp reported sizes at ingress; percentage max-height cannot bound an indefinite container. Keep resize callback
  // identity stable to preserve the bridge.
  const handleResize = useCallback((next: { width?: number; height?: number }) => {
    setSize((prev) => clampMcpAppCardSize(next, prev));
  }, []);

    // This mount's mode is `mountDisplayMode` and never changes; the ref only exists so the
  // bridge handler reads the current prop rather than a stale closure.
  const displayModeRef = useRef(mountDisplayMode);
  displayModeRef.current = mountDisplayMode;
  const getDisplayMode = useCallback(() => displayModeRef.current, []);

  // Move cards, never clone them: exactly one mount owns a live bridge. Inline revival must match the current shared
  // location before reporting success.
  const applyDisplayMode = useCallback(
    async (mode: McpUiDisplayMode): Promise<McpUiDisplayMode> => {
      const current = displayModeRef.current;
      if (mode === current) return current;

      if (mode === "fullscreen" || mode === "pip") {
        moveCard(
          cardLocationIdRef.current,
          { kind: mode },
          { payload, originSessionId: originSessionIdRef.current },
        );
        return mode;
      }

      // mode === "inline". The card is in this renderer's store, so the revive needs no IPC — and if the guard rejects it (the
      // card is no longer where this mount thinks), nothing moved and the mount reports the mode it is still in.
      if (current === "pip" || current === "fullscreen") {
        if (!reviveCardIfAt(cardLocationIdRef.current, { kind: current })) return current;
      }
      return "inline";
    },
    [payload],
  );

  // Only true home-mount unmount reclaims the current away entry; re-renders and away-mount cleanup must not revive
  // duplicate bridges.
  useEffect(() => {
    if (mountDisplayMode !== "inline") return undefined;
    return () => {
      const at = getCardLocation(cardLocationIdRef.current);
      if (at.kind !== "inline") reviveCardIfAt(cardLocationIdRef.current, at);
    };
  }, [mountDisplayMode]);

  // Host IANA time zone — stable for the app's lifetime; read once.
  const timeZone = useMemo(() => hostTimeZone(), []);

  // Build the STANDARD `McpUiHostContext` from the current host theme + locale +
  // time zone. `findBundle` may return undefined mid lazy-load — fall back to the
  // always-resident default bundle, and if even that is missing (never in practice)
  // emit no style variables rather than throw.
  const buildHostContext = useCallback(() => {
    const tokens: Record<string, string> = appliedBundle ? { ...bundleToPluginTokens(appliedBundle) } : {};

    // Read the live custom-font override from root styles; absent an override, guests keep their own default font.
    if (typeof document !== "undefined") {
      const family = getComputedStyle(document.documentElement)
        .getPropertyValue("--ave-font-family")
        .trim();
      if (family) tokens["--ave-font-family"] = family;
    }

    // `displayMode` is this MOUNT's mode, which never changes — a mount cannot report a presentation it is not in (a mode
    // change moves the card to the other mount instead).
    return buildMcpAppHostContext({
      shell: appliedBundle?.shell ?? "light",
      tokens,
      locale,
      timeZone,
      displayMode: mountDisplayMode,
    });
  }, [appliedBundle, locale, timeZone, mountDisplayMode]);

  // Hold the latest builder in a ref so the ref-callback bridge lifecycle (`attachWebview`, keyed only on [payload, bundle])
  // can seed the initial context at mount without re-subscribing on every theme/locale change.
  const buildHostContextRef = useRef(buildHostContext);
  buildHostContextRef.current = buildHostContext;

  // Fetch the ui:// resource via IPC on first render. Main installs the partition
  // policy (declared-origin network gate + sandbox-proxy protocol handler + relay
  // preload) and mints the proxy session BEFORE returning, so all three are in place
  // before the webview navigates.
  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    // A fresh payload (new card / re-invocation) starts enabled even if the previous serverId had disconnected; the disconnect
    // event only disables the specific card that was live when it fired.
    setDisabled(false);
    // Re-seed the live card size from the new payload (bounded — the seed is untrusted too); the app will resize it again via
    // `ui/notifications/size-changed` once it renders.
    setSize({ height: mcpAppCardSeedHeight(payload.height) });
    // Only home mounts reclaim a fresh payload from its current location; away mounts would revive a second bridge.
    if (mountDisplayMode === "inline") {
      const awayLocation = getCardLocation(cardLocationIdRef.current);
      if (awayLocation.kind !== "inline") {
        reviveCardIfAt(cardLocationIdRef.current, awayLocation);
      }
    }

    window.ave.mcp.readUiResource(payload.serverId, payload.resourceUri, payload.generationId)
      .then((next) => {
        if (cancelled) return;
        setBundle(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      });

    return () => { cancelled = true; };
  }, [payload, mountDisplayMode]);

  // b3 — subscribe to the main→renderer server-disconnected broadcast. When the payload's own server is torn down, disable
  // in place (webview unmounts via the `disabled` render branch below; the transcript record is untouched).
  useEffect(() => {
    const onServerDisconnected = window.ave?.mcp?.onServerDisconnected;
    if (typeof onServerDisconnected !== "function") return;
    const unsub = onServerDisconnected((serverId: string) => {
      if (serverId === payload.serverId) setDisabled(true);
    });
    return unsub;
  }, [payload.serverId]);

  // Attach the AppBridge via a ref callback keyed to the mounted node,
  // NOT a post-mount `setAttribute` effect. Electron binds `partition` only when
  // it is present BEFORE `src` loads, so the sandbox attributes are declared as
  // `createElement` props (below); the bridge lifecycle rides the ref callback so
  // it never races the conditional render.
  const attachWebview = useCallback((node: HTMLElement | null) => {
    if (bridgeRef.current) {
      void bridgeRef.current.transport.close();
      // Free the main-side sandbox-proxy session so its token isn't held until the
      // global LRU evicts it (which, on a long chat with many cards, could evict a
      // still-mounted card's token instead). Fire-and-forget; idempotent in main.
      // Optional-chained: teardown can race a torn-down bridge surface (unmount).
      const { token } = bridgeRef.current;
      if (token) window.ave?.mcp?.disposeUiSession?.(token);
      bridgeRef.current = null;
    }
    if (node && bundle) {
      const { bridge, transport } = createMcpAppBridge(
        payload,
        bundle.html,
        node as unknown as BridgeWebviewElement,
        // Seed the initial standard host context. Read the latest builder via ref so this callback stays keyed on [payload,
        // bundle].
        buildHostContextRef.current(),
        // React-owned adapters: resize drives card state; open-link reuses the host's
        // existing effect-gated egress (`window.aveApi.openExternalUrl`); call-tool
        // is BOUND HERE to this card's `payload.serverId` — the app supplies only a
        // tool name + args and has no channel through which to name a server. Main
        // re-verifies ownership and runs the call through the host's risk/consent gate.
        {
          onResize: handleResize,
          openLink: (url) => getApi().openExternalUrl(url),
          callTool: (name, args) => window.ave.mcp.callTool(
            payload.serverId,
            name,
            args,
            payload.generationId,
          ),
          // `onmessage` is bound to BOTH the card's server and the card's origin session. The app names neither, so it can neither
          // impersonate another server nor speak into a conversation the user has left.
          postMessage: (params) =>
            window.ave.mcp.postUiMessage(payload.serverId, originSessionIdRef.current, params),
          // `onrequestdisplaymode` — the card's mode is McpAppView's state, and the applier maps a mode onto the host's EXISTING
          // window seams (see above).
          getDisplayMode,
          applyDisplayMode,
          // `ondownloadfile` is bound to the card's server (for the audit trail; the app names none). Main decodes the inline bytes,
          // refuses to fetch any URI the app supplies, and the user's save dialog authorizes the write.
          downloadFile: (params) => window.ave.mcp.downloadFile(payload.serverId, params),
          // `onupdatemodelcontext` is bound to the card's server, its origin session, AND
          // this card instance. The app names none of the three, so it can overwrite only
          // its OWN slot, only in the conversation it belongs to. Main reads that slot at
          // the next prompt build — nothing here can start a turn.
          updateModelContext: (params) =>
            window.ave.mcp.postUiModelContext(
              payload.serverId,
              originSessionIdRef.current,
              cardIdRef.current,
              params,
            ),
        },
      );
      bridgeRef.current = { bridge, transport, token: tokenFromProxyUrl(bundle.proxyUrl) };
    }
  }, [payload, bundle, handleResize, getDisplayMode, applyDisplayMode]);

  // Push context after appliedRevision so shell and tokens come from the same theme; locale may change, but a mount's mode
  // cannot.
  useEffect(() => {
    const current = bridgeRef.current;
    if (!current) return;
    current.bridge.setHostContext(buildHostContextRef.current());
  }, [appliedRevision, locale]);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "MCP App"}</span>
        <span className="text-[10px] opacity-60">
          {t("mcpAppView.sandboxBadge")}
        </span>
      </div>
      {disabled ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }} data-testid="mcp-app-disconnected">
          <PlugZap className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t("mcpAppView.serverDisconnected")}</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : mountDisplayMode === "inline" && location.kind !== "inline" ? (
        // Only dormant home mounts render away placeholders; no webview or bridge exists there until guarded revival.
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }} data-testid={`mcp-app-${location.kind}`}>
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{location.kind === "pip" ? t("mcpAppView.openInPip") : t("mcpAppView.openInFullscreen")}</span>
        </div>
      ) : !bundle ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("mcpAppView.loading")}</span>
        </div>
      ) : (
        createElement("webview", {
          ref: attachWebview,
          src: bundle.proxyUrl,
          partition: mcpAppPartitionName(payload.serverId),
          allowpopups: "false",
          // No `preload` attribute — under `sandbox=yes` it is silently ignored. The relay preload rides
          // `session.registerPreloadScript()` on the partition, which is the only mechanism that actually loads it.
          webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
          disablewebsecurity: "false",
          style: {
            // Bound height at ingress because percentage max-height resolves to none in an indefinite container; percentage width
            // remains a valid responsive guard.
            width: size.width != null ? `${size.width}px` : "100%",
            maxWidth: "100%",
            height: `${size.height}px`,
            border: 0,
            display: "flex",
            background: "transparent",
          },
        })
      )}
    </div>
  );
}
