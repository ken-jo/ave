// Host lifecycle events enter window notification history; unfocused events additionally use OS delivery. Requests use their cards in-app.
// Audit metadata only, never body text; test mode and pre-ready calls have no side effects.
import type { ActivationArguments, BrowserWindow, WebContents } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { createLogger } from "../lib/logger.js";
import { stripMarkdown } from "../shared/strip-markdown.js";
import { errorMessage } from "../shared/error-message.js";
const log = createLogger("ave");

export type NotificationKind =
  | "turn-end"
  | "routine"
  | "ask-user"
  | "approval"
  | "plugin"
  | "alert"
  | "system";

// Closed enumeration of valid `NotificationKind` values. Exported so IPC handlers can validate untrusted renderer payloads without re-listing the kinds
// inline. The `plugin` kind remains available to explicit plugin notification requests.
export const NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set([
  "turn-end",
  "routine",
  "ask-user",
  "approval",
  "plugin",
  "alert",
  "system",
]);

export interface NotificationContextRef {
  sessionId?: string;
  routineId?: string;
  questionId?: string;
  approvalId?: string;
}

export interface FireOptions {
  kind: NotificationKind;
  title: string;
  // Raw text — service caps at 80 chars + ellipsis.
  body: string;
  contextRef?: NotificationContextRef;
  // Approval defaults true; rest default false.
  urgent?: boolean;
  // Opt out of the focus-suppression gate. When true, the OS notification fires regardless of focus state. Other kinds follow `urgent` for sound; turn-end
  // and approval are always silent, because the renderer's accessibility signals own those sounds.
  bypassFocusGate?: boolean;
  // Keep the in-app toast until the user dismisses it, instead of letting it time out. The OS path ignores it. Used for `high` priority alerts.
  sticky?: boolean;
}

// Host notification delivery belongs only to trusted window chrome.
export const IPC_NOTIFICATION_TOAST = CHANNELS.notification.toast;
// IPC channel — renderer → main; fired when the user clicks an in-app toast (via the renderer's status-bar bridge) or when an OS notification's click
// handler triggers focus.
export const IPC_NOTIFICATION_CLICKED = CHANNELS.notification.clicked;

// Output cap — applied to BOTH body (toast / OS / audit) and title (audit). Body and title share the same 80-char limit; the constant name is retained
// for API stability but is now a single output cap rather than a body-only cap.
const BODY_MAX_CHARS = 80;
const HISTORY_BUFFER_CAP = 50;
const ELLIPSIS = "…";

// Cooldowns reset on restart and bound bursts; zero-cooldown lifecycle kinds always fire.
const COOLDOWN_MS_BY_KIND: Record<NotificationKind, number> = {
  "turn-end": 30_000,
  approval: 2_000,
  routine: 0,
  "ask-user": 0,
  // Explicit plugin notifications retain a 5s cooldown. It is lower than turn-end so unrelated plugin requests are not coalesced for long.
  plugin: 5_000,
  alert: 5_000,
  system: 0,
};

// Kinds whose sound is a renderer accessibility signal (`src/shared/accessibility-signals.ts`); their OS banners are silent.
const SIGNAL_OWNED_SOUND_KINDS: ReadonlySet<NotificationKind> = new Set(["turn-end", "approval"]);

// Strip C0, DEL, and C1 controls from title and body; native notification renderers may split or misrender them.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;
function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS_RE, "");
}

interface ToastPayload {
  kind: NotificationKind;
  title: string;
  body: string;
  contextRef?: NotificationContextRef;
  // Stays until the user dismisses it.
  sticky?: true;
}

// Minimal Electron Notification surface used by the service. Exposed as an injectable factory so tests can stub it without spinning Electron.
interface NotificationLike {
  show(): void;
  on(event: "click", handler: () => void): void;
}

type NotificationActivationRegistration = (
  handler: (details: ActivationArguments) => void,
) => void;

export interface NotificationServiceOptions {
  // Read the OS notification master at delivery time for turn-end cues.
  isOsNotificationsEnabled?: () => boolean;
  // Live BrowserWindow getter. Service tolerates null (e.g. window closed).
  getMainWindow: () => BrowserWindow | null;
  auditLogger?: AuditLogger;
  // Test injection — by default the service uses Electron's Notification constructor and `app.isReady()`. Tests pass stubs to avoid loading Electron at all.
  notificationFactory?: (opts: {
    title: string;
    body: string;
    silent: boolean;
    urgency: "normal" | "critical" | "low";
  }) => NotificationLike;
  // Persisted or cold-start notifications need the central activation bridge in addition to per-instance clicks.
  // Undefined selects the default handler; null disables registration for tests.
  notificationActivationRegistration?: NotificationActivationRegistration | null;
  isReady?: () => boolean;
  // Test override of NODE_ENV check. Default: read process.env.NODE_ENV.
  isTestEnv?: () => boolean;
  // Detect focus across every live app window so focused auxiliary viewers do not trigger an OS notification.
  isAnyWindowFocused?: () => boolean;
}

// Strip control chars then UTF-16 surrogate-safely cap at BODY_MAX_CHARS. Using `[...str]` decomposes the string into code-point units so a 4-byte emoji
// at position 80 doesn't get sliced into a lone surrogate.
function truncateBody(body: string): string {
  const clean = stripControlChars(body);
  const codepoints = [...clean];
  if (codepoints.length <= BODY_MAX_CHARS) return clean;
  return codepoints.slice(0, BODY_MAX_CHARS).join("") + ELLIPSIS;
}

// Cap title to BODY_MAX_CHARS with the same surrogate-safe slicing as body. No ellipsis appended — title slicing is for audit-output bounding only.
function capTitle(title: string): string {
  const clean = stripControlChars(title);
  const codepoints = [...clean];
  if (codepoints.length <= BODY_MAX_CHARS) return clean;
  return codepoints.slice(0, BODY_MAX_CHARS).join("");
}

function defaultIsTestEnv(): boolean {
  return process.env.NODE_ENV === "test";
}

function unavailableNotificationFactory(): never {
  throw new Error("desktop-notification-unavailable");
}

export class NotificationService {
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly auditLogger?: AuditLogger;
  private readonly notificationFactory: NonNullable<NotificationServiceOptions["notificationFactory"]>;
  private readonly isOsNotificationsEnabled: () => boolean;
  private readonly isReady: () => boolean;
  private readonly isTestEnv: () => boolean;
  private readonly isAnyWindowFocused: () => boolean;
  // Use monotonic time for cooldowns to survive wall-clock jumps; audit timestamps remain wall-clock time.
  private readonly lastFiredAt = new Map<NotificationKind, number>();
  private readonly pendingHistory: ToastPayload[] = [];
  private historySubscriber: WebContents | null = null;
  private readonly observedHistoryContents = new WeakSet<WebContents>();

  constructor(opts: NotificationServiceOptions) {
    this.getMainWindow = opts.getMainWindow;
    this.auditLogger = opts.auditLogger;
    this.notificationFactory = opts.notificationFactory ?? unavailableNotificationFactory;
    this.isOsNotificationsEnabled = opts.isOsNotificationsEnabled ?? (() => true);
    this.isReady = opts.isReady ?? (() => false);
    this.isTestEnv = opts.isTestEnv ?? defaultIsTestEnv;
    this.isAnyWindowFocused = opts.isAnyWindowFocused ?? (() => false);

    const activationRegistration = opts.notificationActivationRegistration;
    if (activationRegistration && !this.isTestEnv()) {
      try {
        activationRegistration((details) => {
          this.handleNotificationActivation(details);
        });
      } catch (err) {
        log.warn(
          "notification activation handler registration failed: %s",
          (err as Error).message,
        );
      }
    }
  }

  /** Only the current main renderer may release buffered history after installing its listener. */
  setHistorySubscriber(target: WebContents, ready: boolean): boolean {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed() || win.webContents !== target || target.isDestroyed()) return false;
    if (!ready) {
      if (this.historySubscriber === target) this.historySubscriber = null;
      return true;
    }
    if (!this.observedHistoryContents.has(target)) {
      this.observedHistoryContents.add(target);
      target.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace && this.historySubscriber === target) this.historySubscriber = null;
      });
      target.on("render-process-gone", () => {
        if (this.historySubscriber === target) this.historySubscriber = null;
      });
      target.once("destroyed", () => {
        if (this.historySubscriber === target) this.historySubscriber = null;
      });
    }
    this.historySubscriber = target;
    while (this.pendingHistory.length > 0) {
      const payload = this.pendingHistory[0];
      try {
        target.send(IPC_NOTIFICATION_TOAST, payload);
        this.pendingHistory.shift();
      } catch (err) {
        this.historySubscriber = null;
        log.warn("notification history replay failed: %s", errorMessage(err));
        break;
      }
    }
    return true;
  }

  private bufferHistory(payload: ToastPayload): void {
    this.pendingHistory.push(payload);
    if (this.pendingHistory.length > HISTORY_BUFFER_CAP) this.pendingHistory.shift();
  }

  // Never let dependency, window, or delivery failures escape fire(); passive cues must not interrupt host lifecycle. Returns the window that received
  // the history record, so a caller can retract it there, including when an OS notification also fired.
  fire(opts: FireOptions): WebContents | null {
    return this.deliver(opts).toast ?? null;
  }

  deliver(opts: FireOptions): { accepted: boolean; toast?: WebContents } {
    // Captured outside the try: a toast already on screen stays retractable even if a later step (the audit) throws.
    let toast: WebContents | undefined;
    try {
      const accepted = this.fireUnguarded(opts, (target) => { toast = target; });
      return { accepted, ...(toast !== undefined ? { toast } : {}) };
    } catch (err) {
      // Delivery failure must never propagate into the calling flow. The inner OS/toast paths already degrade individually; this catch is the structural
      // backstop for everything else (probe callbacks, window races, sanitizer edge cases).
      log.warn("notification fire failed: %s", (err as Error)?.message ?? String(err));
      return { accepted: false, ...(toast !== undefined ? { toast } : {}) };
    }
  }

  private fireUnguarded(opts: FireOptions, onToast: (target: WebContents) => void): boolean {
    // Test-mode + pre-ready hard guard — never pop a notification before the app is ready or inside a vitest run.
    if (this.isTestEnv() || !this.isReady()) return false;

    const win = this.getMainWindow();
    const focusGateActive = !opts.bypassFocusGate && this.canShowToast(win);
    // The completion record is always available in history. Its OS cue remains background-only and obeys the master setting.
    const turnEndOsSuppression = opts.kind !== "turn-end" ? undefined
      : !this.isOsNotificationsEnabled() ? "os-notifications-disabled"
      : focusGateActive ? "foreground" : undefined;

    // Audit cooldown suppression; bypass escapes it while consuming the next slot. History-only completions leave the OS slot untouched.
    // Use monotonic elapsed time so clock changes cannot suppress later notifications.
    const cooldownMs = COOLDOWN_MS_BY_KIND[opts.kind] ?? 0;
    if (cooldownMs > 0 && turnEndOsSuppression === undefined) {
      const last = this.lastFiredAt.get(opts.kind) ?? 0;
      const now = performance.now();
      const elapsedMs = now - last;
      if (last !== 0 && elapsedMs < cooldownMs && opts.bypassFocusGate !== true) {
        this.auditSuppressed(opts.kind, elapsedMs);
        return false;
      }
      this.lastFiredAt.set(opts.kind, now);
    }

    // Sanitize title and body; OS notifications need plain text while in-app records support markdown. Strip markup before the visible-text cap.
    const cleanTitle = capTitle(opts.title);
    const truncatedBody = truncateBody(opts.body);
    const truncatedPlainBody = truncateBody(stripMarkdown(opts.body));
    // Critical bypass implies urgency unless the caller explicitly sets urgent:false.
    const urgent =
      opts.urgent ??
      (opts.kind === "approval" || opts.bypassFocusGate === true);

    if (focusGateActive && (opts.kind === "approval" || opts.kind === "ask-user")) {
      // The request card owns attention; hidden cards already have a pending-answer indicator.
      this.audit("in-app", opts.kind, cleanTitle, "card");
      return true;
    }

    // Records wait for the real history subscriber rather than disappearing into the bootstrap splash.
    let recorded = false;
    if (opts.kind !== "approval" && opts.kind !== "ask-user") {
      const payload: ToastPayload = {
        kind: opts.kind,
        title: cleanTitle,
        body: truncatedBody,
        contextRef: opts.contextRef,
        ...(opts.sticky === true ? { sticky: true as const } : {}),
      };
      if (!win || win.isDestroyed() || this.historySubscriber !== win.webContents) {
        this.bufferHistory(payload);
        recorded = true;
      } else {
        try {
          win.webContents.send(IPC_NOTIFICATION_TOAST, payload);
          recorded = true;
          onToast(win.webContents);
        } catch (err) {
          this.historySubscriber = null;
          this.bufferHistory(payload);
          log.warn("notification history send failed: %s", errorMessage(err));
        }
      }
    }

    if (turnEndOsSuppression !== undefined) {
      // A history-only completion must not consume the OS cooldown or prevent a later background completion cue.
      this.auditSuppressed(opts.kind, 0, turnEndOsSuppression);
      if (recorded) this.audit("in-app", opts.kind, cleanTitle);
      return recorded;
    }

    // Focus gating includes every app-owned window; bypass forces OS delivery. A failed foreground record retains the OS fallback.
    if (focusGateActive && recorded) {
      this.audit("in-app", opts.kind, cleanTitle);
      return true;
    }
    const osDelivered = this.fireOsNotification(opts, cleanTitle, truncatedPlainBody, urgent);
    if (osDelivered || recorded) this.audit(osDelivered ? "os" : "in-app", opts.kind, cleanTitle);
    // OS-selected delivery acknowledges only the OS outcome: a send can precede the renderer subscription during boot.
    return osDelivered;
  }

  // Whether a cue fired now without `bypassFocusGate` would be an in-app toast rather than an OS notification — so a caller can choose between the two
  // before it fires. Never throws, like {@link fire}: a failed window probe reads as "not focused".
  isFocusGateActive(): boolean {
    try {
      return this.canShowToast(this.getMainWindow());
    } catch (err) {
      log.warn("notification focus probe failed: %s", errorMessage(err));
      return false;
    }
  }

  // The main window can show an in-app toast (alive and not minimized, so the user can see it) and some Ave window has focus.
  private canShowToast(win: BrowserWindow | null): boolean {
    const mainAlive = win !== null && !win.isDestroyed() && !win.isMinimized();
    return mainAlive && this.isAnyWindowFocused();
  }

  private fireOsNotification(opts: FireOptions, title: string, body: string, urgent: boolean): boolean {
    try {
      const n = this.notificationFactory({
        title,
        body,
        // The renderer's accessibility signals own the turn-finished and approval-needed sounds (each user-set to off, when
        // unfocused, or on); an audible OS banner too would sound twice.
        silent: SIGNAL_OWNED_SOUND_KINDS.has(opts.kind) || !urgent,
        urgency: urgent ? "critical" : "normal",
      });
      n.on("click", () => {
        this.restoreMainWindowFromNotification({
          kind: opts.kind,
          contextRef: opts.contextRef,
        });
      });
      n.show();
      return true;
    } catch (err) {
      // OS notification can fail on Linux without libnotify, on Windows without AppUserModelId, etc. Never let a failed notification block the lifecycle event that fired it.
      log.warn(
        "OS notification fire failed: %s",
        (err as Error).message,
      );
      return false;
    }
  }

  private handleNotificationActivation(details: ActivationArguments): void {
    void details;
    this.restoreMainWindowFromNotification();
  }

  private restoreMainWindowFromNotification(payload?: {
    kind: NotificationKind;
    contextRef?: NotificationContextRef;
  }): void {
    // Entirely inside the try — this runs from OS notification click / Action Center activation callbacks, where a throw would surface as an unhandled
    // exception in the main process. `getMainWindow()` is an injected getter and shares fire()'s never-throw contract (#2103).
    try {
      const win = this.getMainWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (payload) {
        win.webContents.send(IPC_NOTIFICATION_CLICKED, payload);
      }
    } catch (err) {
      log.warn(
        "notification click handler failed: %s",
        (err as Error).message,
      );
    }
  }

  private audit(gate: "os" | "in-app", kind: NotificationKind, title: string, surface?: "card"): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "notification-service",
        type: "info",
        // Never log notification bodies, which may contain user or assistant text; cap titles again at the audit boundary.
        input: JSON.stringify({
          event: surface === "card" ? "notification.handled" : "notification.fired",
          kind,
          gate,
          ...(surface ? { surface } : {}),
          // reuses body cap as title cap — same 80-char limit applies to audit fields.
          title: title.slice(0, BODY_MAX_CHARS),
        }),
      });
    } catch {
      // audit failure must never block the app
    }
  }

  // Audit a suppressed fire. Must NEVER silently drop — a missing audit trail hides runaway-loop bugs.
  private auditSuppressed(
    kind: NotificationKind,
    elapsedMs: number,
    reason: "cooldown" | "foreground" | "os-notifications-disabled" = "cooldown",
  ): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "notification-service",
        type: "info",
        input: JSON.stringify({
          event: "notification.suppressed",
          kind,
          reason,
          elapsedMs,
        }),
      });
    } catch {
      // audit failure must never block the app
    }
  }
}

export const __test = {
  truncateBody,
  capTitle,
  stripControlChars,
  BODY_MAX_CHARS,
  COOLDOWN_MS_BY_KIND,
};
