/** Only accepted raises charge budgets and deliver host-owned cards, notifications, audit records, and events. */
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
import { formatPluginNotificationTitle, resolvePluginDisplayName } from "../shared/plugin-provenance.js";

const log = createLogger("alerts");

const EXPIRY_SWEEP_MS = 60_000;

export type AlertWithdrawReason = "withdrawn" | "expired" | "evicted" | AlertCardClosedReason;

export interface AlertsServiceDeps {
  migration: AlertMigrationPorts;
  dir: () => string;
  settings: {
    get(): AlertSettings;
    set(next: AlertSettings): Promise<void>;
  };
  /** Plugins present on first service boot count as existing installs. */
  installedPluginIds: () => Promise<readonly string[]>;
  appVersion: string;
  locale: () => string;
  predecessorBlocks: (pluginId: string, sourceHint: string) => Promise<boolean>;
  overlay: {
    /** Retain staged cards for windows that appear later. */
    show(card: AlertCard): void;
    dismiss(cardId: string): void;
  };
  notifications: {
    isFocusGateActive(): boolean;
    fire(opts: { kind: "alert"; title: string; body: string; bypassFocusGate?: boolean; sticky?: boolean }): void;
  };
  emit: (type: "alert.raised" | "alert.withdrawn", payload: Record<string, unknown>) => void;
  audit: (entry: AuditEntry) => void;
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

  /** Every registration and raise must await the one-time identity and ledger load. */
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

  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), EXPIRY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  register(pluginId: string, manifest: Pick<PluginManifest, "alerts" | "configInherits" | "name">, isReady: () => boolean = () => true): Promise<void> {
    return this.prepareRegistration(pluginId, manifest, isReady).publish();
  }

  /** Keep candidate grants, choices, and inheritance private until publication. */
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
          return { ...resolved, pluginLabel: resolvePluginDisplayName(pluginId, manifest.name), reasoning: manifest.alerts?.reasoning ?? "" };
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

  reconcileMigration(): Promise<void> {
    return this.mutate(async () => { await this.loaded(); await this.migration.run(); });
  }

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

  /** Even an empty settings patch acknowledges the current declaration and clears flags. */
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
      // Recheck the declaration after waiting so uninstall or update cannot consent to stale data.
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

    // Recheck revocation after asynchronous predecessor lookup.
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
      // Refresh preserves opening visibility; redraw restart-lost cards without promoting cardless alerts.
      if (open.visibility === "user-visible") this.stageCard(pluginId, registration.pluginLabel, kind.id, alertId, rendered, priority, now);
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
    if (card) this.stageCard(pluginId, registration.pluginLabel, kind.id, alertId, rendered, priority, now);
    const cues = this.notify(pluginId, registration.pluginLabel, kind, rendered, visibility, priority, choice.osNotification && settings.osNotificationsEnabled);

    this.writeAudit({
      timestamp: new Date(now).toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input: `[plugin:${pluginId}] alert.raised kind=${kind.id} alertId=${alertId} visibility=${visibility} priority=${priority}`,
    });
    this.deps.emit("alert.raised", { pluginId, kind: kind.id, alertId, visibility, priority, raisedAt: new Date(now).toISOString() });
    return { status: "raised", alertId, delivered: { card, osNotification: cues.os, toast: cues.toast } };
  }

  async withdraw(pluginId: string, kindId: string, key: string): Promise<boolean> {
    await this.loaded();
    if (typeof kindId !== "string" || typeof key !== "string" || !ALERT_KEY_RE.test(key)) return false;
    const alertId = alertIdFor(this.requireSecret(), pluginId, kindId, key);
    // Caller-keyed ids prevent naming another plugin's alert.
    const open = this.store.remove(alertId);
    if (!open) return false;
    this.finish(open, "withdrawn");
    return true;
  }

  /** User answers close an identity for the remainder of its lifetime. */
  cardClosed(alertId: string, reason: AlertCardClosedReason): boolean {
    const open = this.store.close(alertId);
    if (!open) return false;
    this.cards.delete(alertId);
    this.announceWithdrawn(open, reason);
    return true;
  }

  listOpen(): AlertCard[] {
    return [...this.cards.values()];
  }

  /** Revocation withdraws cards but preserves installed choices. */
  setRevokedPlugins(pluginIds: readonly string[]): void {
    this.revokedPlugins = new Set(pluginIds);
    for (const pluginId of this.revokedPlugins) {
      for (const open of this.store.removePlugin(pluginId)) this.finish(open, "withdrawn");
    }
    this.deps.kindsChanged?.();
  }

  /** Uninstall removes cards while retaining choices until expiry. */
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

  sweep(): void {
    for (const open of this.store.expire(this.now())) this.finish(open, "expired");
  }

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
    pluginDisplayName: string,
    kindId: string,
    alertId: string,
    rendered: RenderedAlert,
    priority: AlertPriority,
    now: number,
  ): void {
    const item: AlertCard = {
      id: cardId(alertId),
      source: { kind: "alert", pluginId, kindId, alertId },
      pluginDisplayName,
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
      log.warn(`alert card delivery failed: ${errorMessage(err)}`);
    }
  }

  /** Gate OS notifications on declared capability, consent, priority, and focus. Focused summary-only alerts use toasts; high-priority toasts persist. */
  private notify(
    pluginId: string,
    pluginDisplayName: string,
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
    const title = pluginId === ALERT_HOST_PLUGIN_ID
      ? rendered.title
      : formatPluginNotificationTitle(
        (key, vars) => translate(this.deps.locale(), key, vars), pluginId, pluginDisplayName, rendered.title,
      );
    if (os) {
      this.deps.notifications.fire({
        kind: "alert",
        title,
        body: rendered.notificationBody,
        ...(focused ? { bypassFocusGate: true } : {}),
      });
    } else if (toast) {
      this.deps.notifications.fire({
        kind: "alert",
        title,
        body: rendered.notificationBody,
        ...(priority === "high" ? { sticky: true } : {}),
      });
    }
    return { toast, os };
  }

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

  /** Audit failure must not turn an answered raise into a failed one. */
  private writeAudit(entry: AuditEntry): void {
    try {
      this.deps.audit(entry);
    } catch (err) {
      log.warn(`alert audit failed: ${errorMessage(err)}`);
    }
  }
}
