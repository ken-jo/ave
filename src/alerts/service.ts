/**
 * The alerts service: the one writer of `settings.alerts` and the host side
 * of `raiseAlert` / `withdrawAlert`.
 *
 * A raise runs the pipeline in order, each step producing exactly one result
 * — grant, shape, predecessor, the user's toggle, open or closed identity,
 * cooldown, rate — and only an accepted alert is rendered, staged, notified,
 * audited and announced. Windows (cooldown, rate, refresh budget) are charged
 * only after acceptance. The card, the OS notification and the conversation
 * an accept starts belong to the host; the plugin supplies typed slot values.
 */
import type {
  AlertInput,
  AlertKindDeclaration,
  AlertResult,
  AlertVisibility,
  PluginManifest,
} from "../plugins/public-contract.js";
import type { AlertCard, AlertCardClosedReason, AlertKindRow, AlertSettings, SetAlertKindResult, SetAlertOsNotificationsResult } from "../shared/alerts-types.js";
import { ALERT_HOST_PLUGIN_ID, ALERT_RESERVED_PACKAGE_ID, isAlertKindKey, isAlertKindPatch, isAlertVisibility } from "../shared/alerts-types.js";
import type { AuditEntry } from "../audit/audit-logger.js";
import { t, translate } from "../i18n/index.js";
import { getDeclaredAlertKinds, getDeclaredConfigInherits } from "../plugins/runtime/manifest-validation.js";
import { AlertMigration, type AlertMigrationPorts } from "./migration.js";
import {
  TriggerConversationRateLimiter,
  TriggerDenyAuditThrottle,
  formatPluginPendingPrompt,
} from "../boot/steps/plugin-runtime/trigger-gate.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { alertIdFor, loadInstallSecret } from "./identity.js";
import { ALERT_KEY_RE, checkSlots, renderAlert, type RenderedAlert } from "./render.js";
import { AlertStore, type AlertPriority, type OpenAlert } from "./store.js";
import {
  ALERT_KIND_COOLDOWN_MS,
  ALERT_RATE_MAX_CALLS,
  ALERT_RATE_WINDOW_MS,
  clampTtl,
  effectiveVisibility,
} from "./gate.js";
import { RegistrationLedger, alertKindKey, markPluginAbsent, resolveRegistration } from "./kinds.js";
import { HOST_ALERT_KINDS } from "./host-kinds.js";

const log = createLogger("alerts");

/** How often open alerts are checked for the end of their lifetime. */
const EXPIRY_SWEEP_MS = 60_000;

export type AlertWithdrawReason = "withdrawn" | "expired" | "evicted" | AlertCardClosedReason;

export interface AlertsServiceDeps {
  migration: AlertMigrationPorts;
  /** The `alerts` feature namespace directory. */
  dir: () => string;
  settings: {
    get(): AlertSettings;
    set(next: AlertSettings): Promise<void>;
  };
  /** Plugin ids installed when the service first runs; they predate it. */
  installedPluginIds: () => Promise<readonly string[]>;
  appVersion: string;
  locale: () => string;
  /** Whether the plugin a kind inherits from still owns the user's choice. */
  predecessorBlocks: (pluginId: string, sourceHint: string) => Promise<boolean>;
  overlay: {
    /**
     * Stage or refresh a card in the window, when there is one. The service
     * keeps every staged card, so a window that appears later pulls them.
     */
    show(card: AlertCard): void;
    dismiss(cardId: string): void;
  };
  notifications: {
    /** Whether a cue fired now without bypassing the focus gate would be an in-app toast. */
    isFocusGateActive(): boolean;
    fire(opts: { kind: "alert"; title: string; body: string; bypassFocusGate?: boolean; sticky?: boolean }): void;
  };
  /** The host event bus. */
  emit: (type: "alert.raised" | "alert.withdrawn", payload: Record<string, unknown>) => void;
  audit: (entry: AuditEntry) => void;
  /** Invalidate the renderer's kind list after registration or a settings write. */
  kindsChanged?: () => void;
  now?: () => number;
}

interface Registration {
  kinds: ReadonlyMap<string, AlertKindDeclaration>;
  pluginLabel: string;
  reasoning: string;
}

function isPriority(value: unknown): value is AlertPriority {
  return value === "low" || value === "normal" || value === "high";
}

/** The overlay item id of an alert's card. */
function cardId(alertId: string): string {
  return `alert:${alertId}`;
}

export class AlertsService {
  private readonly store: AlertStore;
  private readonly ledger: RegistrationLedger;
  private readonly migration: AlertMigration;
  private mutations: Promise<unknown> = Promise.resolve();
  private readonly registrations = new Map<string, Promise<Registration>>();
  private revokedPlugins = new Set<string>();
  private readonly lastFired = new Map<string, number>();
  private readonly rate = new TriggerConversationRateLimiter(ALERT_RATE_WINDOW_MS, ALERT_RATE_MAX_CALLS);
  private readonly denyThrottle = new TriggerDenyAuditThrottle();
  /** Rendered cards of open user-visible alerts, for a window that appears or reloads later. */
  private readonly cards = new Map<string, AlertCard>();
  private readonly now: () => number;
  private secret: Buffer | null = null;
  private loading: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AlertsServiceDeps) {
    this.store = new AlertStore(deps.dir);
    this.ledger = new RegistrationLedger(deps.dir);
    this.migration = new AlertMigration(deps.migration, deps.settings, deps.predecessorBlocks);
    this.now = deps.now ?? Date.now;
  }

  /**
   * Load the install secret, the identity tables and the registration ledger,
   * once. Every other entry point waits for it, so a plugin that registers or
   * raises while it runs is served after it.
   */
  load(): Promise<void> {
    this.loading ??= (async () => {
      this.secret = await loadInstallSecret(this.deps.dir());
      await this.store.load(this.now());
      await this.ledger.load(this.deps.installedPluginIds);
    })();
    return this.loading;
  }

  private loaded(): Promise<void> {
    if (!this.loading) throw new Error("AlertsService used before load()");
    return this.loading;
  }

  /** Check lifetimes once a minute; stops with {@link stop}. */
  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), EXPIRY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * One registration of a plugin — every start, whether from install, update
   * or load. Writes the missing entries of its declared kinds and escalates
   * entries whose declared visibility went up.
   */
  register(pluginId: string, manifest: Pick<PluginManifest, "alerts" | "configInherits" | "name">, isReady: () => boolean = () => true): Promise<void> {
    return this.prepareRegistration(pluginId, manifest, isReady).publish();
  }

  /** Keep candidate grants, choices and inheritance private until publication. */
  prepareRegistration(pluginId: string, manifest: Pick<PluginManifest, "alerts" | "configInherits" | "name">, isReady: () => boolean = () => true): {
    publish(): Promise<void>;
    unpublish(): void;
  } {
    const kinds = getDeclaredAlertKinds(manifest, pluginId);
    const config = getDeclaredConfigInherits(manifest, pluginId) ?? [];
    const loaded = this.loaded();
    let registration: Promise<Registration> | undefined;
    const isCurrent = () => this.registrations.get(pluginId) === registration && isReady();
    return {
      publish: () => {
        registration ??= this.mutate(async () => {
          await loaded;
          const resolved = await this.resolve(pluginId, kinds);
          return { ...resolved, pluginLabel: manifest.name ?? pluginId, reasoning: manifest.alerts?.reasoning ?? "" };
        });
        this.registrations.set(pluginId, registration);
        return this.mutate(async () => {
          await registration;
          if (this.registrations.get(pluginId) !== registration) return;
          this.migration.register(pluginId, kinds, config, isCurrent);
          await this.migration.run();
          this.deps.kindsChanged?.();
        });
      },
      unpublish: () => {
        if (registration && this.registrations.get(pluginId) === registration) {
          this.registrations.delete(pluginId);
          this.migration.forget(pluginId);
          this.deps.kindsChanged?.();
        }
      },
    };
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  /** Retry pending inheritance when records, installed state, or host kinds change. */
  reconcileMigration(): Promise<void> {
    return this.mutate(async () => { await this.loaded(); await this.migration.run(); });
  }

  /** Host kinds are registered before the Work Board scanner can raise them. */
  registerHostKinds(): Promise<void> {
    return this.register(ALERT_HOST_PLUGIN_ID, {
      alerts: { reasoning: translate("en", "be_alerts.reasoning"), kinds: [...HOST_ALERT_KINDS] },
    });
  }

  private async resolve(pluginId: string, kinds: readonly AlertKindDeclaration[]): Promise<Pick<Registration, "kinds">> {
    const origin = this.ledger.register(pluginId);
    const next = resolveRegistration(this.deps.settings.get(), pluginId, kinds, origin);
    if (next) await this.deps.settings.set(next);
    return { kinds: new Map(kinds.map((kind) => [kind.id, kind])) };
  }

  private async kindRow(pluginId: string, registration: Registration, kind: AlertKindDeclaration): Promise<AlertKindRow> {
    const predecessor = kind.inherits?.[0];
    const blocked = predecessor && await this.deps.predecessorBlocks(predecessor.pluginId, predecessor.sourceId);
    const kindKey = alertKindKey(pluginId, kind.id);
    const host = pluginId === ALERT_HOST_PLUGIN_ID;
    return structuredClone({
      kindKey, pluginId,
      pluginLabel: host ? translate(this.deps.locale(), "be_alerts.builtInLabel") : registration.pluginLabel,
      reasoning: host ? translate(this.deps.locale(), "be_alerts.reasoning") : registration.reasoning,
      declaration: kind,
      choice: this.deps.settings.get().kinds[kindKey]!,
      blockedByPredecessor: blocked ? predecessor.pluginId : null,
      predecessor: null,
    });
  }

  async listKinds(): Promise<AlertKindRow[]> {
    await this.loaded();
    const rows = await Promise.all([...this.registrations].map(async ([pluginId, pending]) => {
      const registration = await pending;
      return Promise.all([...registration.kinds.values()].map((kind) => this.kindRow(pluginId, registration, kind)));
    }));
    return rows.flat();
  }

  /** Calling setKind, including an empty patch, acknowledges the current declaration and clears its flags. */
  async setKind(kindKey: unknown, patch: unknown): Promise<SetAlertKindResult> {
    if (!isAlertKindKey(kindKey) || !isAlertKindPatch(patch)) return { ok: false, error: "invalid-arguments" };
    const [pluginId, kindId] = kindKey.split(":") as [string, string];
    const pending = this.registrations.get(pluginId);
    if (!pending) return { ok: false, error: "kind-not-registered" };
    const registration = await pending;
    const kind = registration.kinds.get(kindId);
    if (!kind) return { ok: false, error: "kind-not-registered" };
    if (patch.osNotification === true && !kind.osNotification) return { ok: false, error: "invalid-arguments" };
    const result = await this.mutate(async (): Promise<SetAlertKindResult> => {
      // An uninstall or update while this call waited must not consent to a stale declaration.
      if (this.registrations.get(pluginId) !== pending) return { ok: false, error: "kind-not-registered" };
      const settings = this.deps.settings.get();
      const existing = settings.kinds[kindKey]!;
      const { repaired: _repaired, escalated: _escalated, ...choice } = existing;
      await this.deps.settings.set({
        ...settings,
        kinds: {
          ...settings.kinds,
          [kindKey]: { ...choice, ...patch, visibility: kind.visibility, seenByUser: true },
        },
      });
      return this.kindRow(pluginId, registration, kind);
    });
    if (!("error" in result)) this.deps.kindsChanged?.();
    return result;
  }

  async setOsNotificationsEnabled(enabled: unknown): Promise<SetAlertOsNotificationsResult> {
    if (typeof enabled !== "boolean") return { ok: false, error: "invalid-arguments" };
    await this.loaded();
    await this.mutate(() => this.deps.settings.set({ ...this.deps.settings.get(), osNotificationsEnabled: enabled }));
    this.deps.kindsChanged?.();
    return { osNotificationsEnabled: enabled };
  }

  async raise(pluginId: string, input: AlertInput): Promise<AlertResult> {
    const pending = this.registrations.get(pluginId);
    if (!pending) throw new Error(`raiseAlert from '${pluginId}' before its kinds were registered`);
    const registration = await pending;
    await this.reconcileMigration();
    if (!input || typeof input !== "object") return { status: "invalid", field: "input" };
    const kind = typeof input.kind === "string" ? registration.kinds.get(input.kind) : undefined;
    if (!kind) return { status: "kind_not_granted", kind: String(input.kind) };

    if (typeof input.key !== "string" || !ALERT_KEY_RE.test(input.key)) return { status: "invalid", field: "key" };
    if (input.priority !== undefined && !isPriority(input.priority)) return { status: "invalid", field: "priority" };
    if (input.visibility !== undefined && !isAlertVisibility(input.visibility)) {
      return { status: "invalid", field: "visibility" };
    }
    const ttlMs = clampTtl(input.ttlMs);
    if (ttlMs === null) return { status: "invalid", field: "ttlMs" };
    const slots = checkSlots(kind, input.slots);
    if (!slots.ok) return { status: "invalid", field: slots.field };

    const predecessor = kind.inherits?.[0];
    if (predecessor && (await this.deps.predecessorBlocks(predecessor.pluginId, predecessor.sourceId))) {
      this.auditSuppressed(pluginId, kind.id, "blocked_by_predecessor");
      return { status: "blocked_by_predecessor", pluginId: predecessor.pluginId };
    }

    // A feed may revoke the caller while predecessor lookup is pending.
    if (this.revokedPlugins.has(pluginId)) return { status: "kind_not_granted", kind: kind.id };
    const settings = this.deps.settings.get();
    const choice = settings.kinds[alertKindKey(pluginId, kind.id)];
    if (!choice?.enabled) {
      this.auditSuppressed(pluginId, kind.id, "disabled_by_user");
      return { status: "disabled_by_user" };
    }

    const now = this.now();
    const priority: AlertPriority = input.priority ?? "normal";
    const visibility = effectiveVisibility(kind.visibility, input.visibility);
    const alertId = alertIdFor(this.requireSecret(), pluginId, kind.id, input.key);
    const rendered = renderAlert(kind, slots.values, this.deps.locale());

    let open = this.store.getOpen(alertId);
    if (open && open.expiresAt <= now) {
      this.store.remove(alertId);
      this.finish(open, "expired");
      open = undefined;
    }
    if (open) {
      if (!this.store.refresh(alertId, now, { expiresAt: now + ttlMs, priority })) {
        this.auditSuppressed(pluginId, kind.id, "rate_limited");
        return { status: "rate_limited" };
      }
      // The identity keeps the level it opened at: a card-less alert gains no
      // card by being raised again. A card lost to a restart is drawn again.
      if (open.visibility === "user-visible") this.stageCard(pluginId, kind.id, alertId, rendered, priority, now);
      return { status: "refreshed", alertId };
    }
    if (this.store.isClosed(alertId, now)) {
      this.auditSuppressed(pluginId, kind.id, "closed");
      return { status: "closed" };
    }
    const cooldownKey = alertKindKey(pluginId, kind.id);
    const last = this.lastFired.get(cooldownKey);
    if (last !== undefined && now - last < ALERT_KIND_COOLDOWN_MS) {
      this.auditSuppressed(pluginId, kind.id, "cooldown");
      return { status: "cooldown" };
    }
    if (this.rate.isOverCap(pluginId, now)) {
      this.auditSuppressed(pluginId, kind.id, "rate_limited");
      return { status: "rate_limited" };
    }

    // Accepted: charge the windows, then deliver.
    this.lastFired.set(cooldownKey, now);
    this.rate.record(pluginId, now);
    const evicted = this.store.add({
      alertId,
      pluginId,
      kindId: kind.id,
      priority,
      visibility,
      raisedAt: now,
      expiresAt: now + ttlMs,
      refreshes: [],
    });
    for (const gone of evicted) this.finish(gone, "evicted");

    const card = visibility === "user-visible";
    if (card) this.stageCard(pluginId, kind.id, alertId, rendered, priority, now);
    const cues = this.notify(kind, rendered, visibility, priority, choice.osNotification && settings.osNotificationsEnabled);

    this.writeAudit({
      timestamp: new Date(now).toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input: `[plugin:${pluginId}] alert.raised kind=${kind.id} alertId=${alertId} visibility=${visibility} priority=${priority}`,
    });
    this.deps.emit("alert.raised", { pluginId, kind: kind.id, alertId, visibility, priority, raisedAt: new Date(now).toISOString() });
    return { status: "raised", alertId, delivered: { card, osNotification: cues.os, toast: cues.toast } };
  }

  /** Withdraw the caller's own open alert; `false` when none is open for `(kind, key)`. */
  async withdraw(pluginId: string, kindId: string, key: string): Promise<boolean> {
    await this.loaded();
    if (typeof kindId !== "string" || typeof key !== "string" || !ALERT_KEY_RE.test(key)) return false;
    const alertId = alertIdFor(this.requireSecret(), pluginId, kindId, key);
    // The id is keyed by the caller's own plugin id, so another plugin's
    // alert is not something it can name.
    const open = this.store.remove(alertId);
    if (!open) return false;
    this.finish(open, "withdrawn");
    return true;
  }

  /** The user accepted or dismissed a card: its identity is closed for the rest of its lifetime. */
  cardClosed(alertId: string, reason: AlertCardClosedReason): boolean {
    const open = this.store.close(alertId);
    if (!open) return false;
    this.cards.delete(alertId);
    this.announceWithdrawn(open, reason);
    return true;
  }

  /** Every staged card, for a window that appeared or reloaded after the alert was raised. */
  listOpen(): AlertCard[] {
    return [...this.cards.values()];
  }

  /** Revocation withdraws cards without forgetting the installed plugin's choices. */
  setRevokedPlugins(pluginIds: readonly string[]): void {
    this.revokedPlugins = new Set(pluginIds);
    for (const pluginId of this.revokedPlugins) {
      for (const open of this.store.removePlugin(pluginId)) this.finish(open, "withdrawn");
    }
  }

  /** An uninstalled plugin's cards go; its choices stay, marked absent, until they age out. */
  async pluginUninstalled(pluginId: string): Promise<void> {
    await this.mutate(async () => {
      await this.loaded();
      for (const open of this.store.removePlugin(pluginId)) this.finish(open, "withdrawn");
      this.registrations.delete(pluginId);
      this.migration.forget(pluginId);
      this.ledger.forget(pluginId);
      const next = markPluginAbsent(this.deps.settings.get(), pluginId, this.deps.appVersion);
      if (next) await this.deps.settings.set(next);
      await this.migration.run();
    });
    this.deps.kindsChanged?.();
  }

  /** End every open alert past its lifetime. */
  sweep(): void {
    for (const open of this.store.expire(this.now())) this.finish(open, "expired");
  }

  /** Resolves once every queued write has settled. */
  async flush(): Promise<void> {
    await this.mutations;
    await this.store.flush();
    await this.ledger.flush();
  }

  private requireSecret(): Buffer {
    if (!this.secret) throw new Error("AlertsService used before load() resolved");
    return this.secret;
  }

  private stageCard(
    pluginId: string,
    kindId: string,
    alertId: string,
    rendered: RenderedAlert,
    priority: AlertPriority,
    now: number,
  ): void {
    const item: AlertCard = {
      id: cardId(alertId),
      source: { kind: "alert", pluginId, kindId, alertId },
      title: rendered.title,
      summary: rendered.summary,
      running: false,
      primaryActionLabel: rendered.actionLabel ?? t("be_pluginRuntime.overlayPrimaryActionLabel"),
      pendingPrompt: formatPluginPendingPrompt(rendered.prompt, `overlay:${pluginId === ALERT_HOST_PLUGIN_ID ? ALERT_RESERVED_PACKAGE_ID : pluginId}--${kindId}`),
      priority,
      createdAt: new Date(now).toISOString(),
    };
    this.cards.set(alertId, item);
    try {
      this.deps.overlay.show(item);
    } catch (err) {
      // The accepted card remains queued for the next window snapshot.
      log.warn(`alert card delivery failed: ${errorMessage(err)}`);
    }
  }

  /**
   * One cue at most, after the alert is accepted and staged. The OS
   * notification needs the kind to declare one, its toggle and the master
   * switch on, a priority above `low`, and no focused window unless the kind
   * bypasses the focus gate. Otherwise a `summary-only` kind — which has no
   * card — is heard as an in-app toast while a window has focus; a `high`
   * toast stays until the user dismisses it.
   */
  private notify(
    kind: AlertKindDeclaration,
    rendered: RenderedAlert,
    visibility: AlertVisibility,
    priority: AlertPriority,
    osToggles: boolean,
  ): { toast: boolean; os: boolean } {
    if (visibility === "silent") return { toast: false, os: false };
    const focused = this.deps.notifications.isFocusGateActive();
    const bypass = kind.osNotification?.bypassFocusGate === true;
    const os = kind.osNotification !== undefined && osToggles && priority !== "low" && (!focused || bypass);
    const toast = !os && visibility === "summary-only" && focused;
    if (os) {
      this.deps.notifications.fire({
        kind: "alert",
        title: rendered.title,
        body: rendered.notificationBody,
        ...(focused ? { bypassFocusGate: true } : {}),
      });
    } else if (toast) {
      this.deps.notifications.fire({
        kind: "alert",
        title: rendered.title,
        body: rendered.notificationBody,
        ...(priority === "high" ? { sticky: true } : {}),
      });
    }
    return { toast, os };
  }

  /** An open alert left without the user: its card goes and the bus hears why. */
  private finish(open: OpenAlert, reason: Exclude<AlertWithdrawReason, AlertCardClosedReason>): void {
    if (this.cards.delete(open.alertId)) {
      try {
        this.deps.overlay.dismiss(cardId(open.alertId));
      } catch (err) {
        log.warn(`alert card dismissal failed: ${errorMessage(err)}`);
      }
    }
    this.announceWithdrawn(open, reason);
  }

  private announceWithdrawn(open: OpenAlert, reason: AlertWithdrawReason): void {
    this.deps.emit("alert.withdrawn", { pluginId: open.pluginId, kind: open.kindId, alertId: open.alertId, reason });
  }

  private auditSuppressed(pluginId: string, kindId: string, reason: string): void {
    if (!this.denyThrottle.shouldEmit(pluginId, reason, this.now())) return;
    const suppressed = this.denyThrottle.drainSuppressed(pluginId, reason);
    this.writeAudit({
      timestamp: new Date(this.now()).toISOString(),
      sessionId: "plugin",
      type: "warn",
      input:
        `[plugin:${pluginId}] alert.suppressed kind=${kindId} reason=${reason}`
        + (suppressed > 0 ? ` (+${suppressed} suppressed)` : ""),
    });
  }

  /** The audit log must not turn an answered raise into a failed one. */
  private writeAudit(entry: AuditEntry): void {
    try {
      this.deps.audit(entry);
    } catch (err) {
      log.warn(`alert audit failed: ${errorMessage(err)}`);
    }
  }
}
