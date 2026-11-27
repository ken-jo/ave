/** Every configuration mutation requires fresh local keyboard intent and host-owned persistence; renderer settings must not widen network policy. */

import { isRecord } from "./is-record.js";
import { hasControlChars } from "./display-safe-text.js";

export const TAILNET_OBSERVER_PORT_BLOCKED = "tailnet-observer-port-blocked";
export const TAILNET_CONFINED_RANGE_UNVERIFIED = "tailnet-observer-confined-range-unverified";
export const TAILNET_PORT_CONFINED_WORKER_RANGE = "tailnet-observer-port-confined-worker-range";

type TailnetObserverConfigSourceView = "file" | "env-override" | "unset";

/** Identity authorization requires pairing and a share; app-capability additionally requires administrator policy. Missing authorization is rejected. */
export type TailnetAuthorization =
  | { readonly kind: "tailnet-identity" }
  | { readonly kind: "app-capability"; readonly capability: string };

export const TAILNET_OBSERVER_CONFIG_KEYS = [
  "enabled",
  "authorization",
  "port",
  "controllerEnabled",
  "pairedSharingEnabled",
  "webEnabled",
  "webOrigin",
] as const;

export type TailnetObserverConfigKeyView = (typeof TAILNET_OBSERVER_CONFIG_KEYS)[number];

/** Use empty strings for unset fields so IPC form defaults are unambiguous. */
export interface TailnetObserverConfigView {
  readonly enabled: boolean;
  readonly authorization: TailnetAuthorization;
  readonly port: number;
  readonly controllerEnabled: boolean;
  readonly pairedSharingEnabled: boolean;
  readonly webEnabled: boolean;
  readonly webOrigin: string;
}

/** Report probed install states explicitly; never invent an account or DNS name. */
const TAILSCALE_ENVIRONMENT_STATES = [
  "ready",
  "logged-out",
  "stopped",
  "cli-not-found",
  "cli-failed",
] as const;

type TailscaleEnvironmentState = (typeof TAILSCALE_ENVIRONMENT_STATES)[number];

export interface TailscaleEnvironmentView {
  readonly state: TailscaleEnvironmentState;
  readonly login: string | null;
  /** This node's MagicDNS name without the trailing dot, or null when it has none. */
  readonly dnsName: string | null;
  readonly tailnetName: string | null;
  readonly serveConfigured: boolean;
  /** The loopback port Serve forwards to, when it forwards to one. */
  readonly serveTargetPort: number | null;
  /** Preserve command diagnostics so the owner can act on the actual failure. */
  readonly detail: string | null;
}

export type TailnetObserverPortHint = "excluded-range" | "mirrored-range";

export interface TailnetObserverPortBlock {
  readonly code: "EADDRINUSE" | "EACCES";
  readonly port: number;
  readonly hint: TailnetObserverPortHint | null;
}

export interface TailnetObserverSnapshot {
  readonly saved: TailnetObserverConfigView;
  /** File plus environment overrides — what the next boot would resolve. */
  readonly effective: TailnetObserverConfigView;
  readonly provenance: Readonly<
    Record<TailnetObserverConfigKeyView, TailnetObserverConfigSourceView>
  >;
  /** The port the listener actually bound, or null when nothing is listening. */
  readonly listeningPort: number | null;
  /** Kebab-case code of the last failed start, or null. */
  readonly lastStartError: string | null;
  readonly portBlock: TailnetObserverPortBlock | null;
  /** Whether paired-sharing setup failed at boot, leaving owner controls off. */
  readonly pairedSharingBootstrapFailed: boolean;
  /** Same-account auto-approval defaults off; other accounts still need invitation and approval, and every device still needs an explicit conversation share. */
  readonly ownDeviceAdmission: boolean;
  readonly environment: TailscaleEnvironmentView;
  /** Derive the web origin from the probed DNS name, never renderer input. */
  readonly derivedWebOrigin: string | null;
  /** Show the exact command before execution; null means no listener is ready. */
  readonly serveCommand: string | null;
  /** Report unreadable saved configuration without disabling the form, so the owner can replace it. */
  readonly configFileError: string | null;
}

type TailnetObserverErrorCode =
  | "tailnet-observer-unavailable"
  | "tailnet-observer-input-invalid"
  | "tailnet-observer-keyboard-intent-required"
  | "tailnet-observer-unauthorized"
  | "tailnet-observer-write-failed"
  | (string & {});

export type TailnetObserverSnapshotResult =
  | { readonly ok: true; readonly snapshot: TailnetObserverSnapshot }
  | { readonly ok: false; readonly error: TailnetObserverErrorCode };

export type TailnetObserverMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TailnetObserverErrorCode };

export type TailnetObserverApplyResult =
  | { readonly ok: true; readonly restartNeeded: boolean }
  | Extract<TailnetObserverMutationResult, { ok: false }>;

/** Return the reachable URL on success and command output on failure. */
export type TailnetServeResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly error: TailnetObserverErrorCode;
      readonly output: string | null;
    };

type TailnetGuidedServeOutcome = "configured" | "already-configured";

export type TailnetGuidedSetupResult =
  | {
      readonly ok: true;
      readonly snapshot: TailnetObserverSnapshot;
      readonly webOrigin: string | null;
      readonly port: number;
      readonly serve: TailnetGuidedServeOutcome;
    }
  | {
      readonly ok: false;
      readonly error: TailnetObserverErrorCode;
      /** Preserve failed command output, especially certificate diagnostics promised by the failure message. */
      readonly output: string | null;
    };

export interface TailnetObserverConfigApi {
  snapshot(): Promise<TailnetObserverSnapshotResult>;
  apply(config: TailnetObserverConfigView): Promise<TailnetObserverApplyResult>;
  /** Put the running listener behind Tailscale Serve, after the owner approved the command. */
  configureServe(): Promise<TailnetServeResult>;
  guidedSetup(): Promise<TailnetGuidedSetupResult>;
  /** Renderer supplies only on/off; host probes the account eligible for same-account admission. */
  setOwnDeviceAdmission(enabled: boolean): Promise<TailnetObserverMutationResult>;
}

export const DEFAULT_TAILNET_OBSERVER_PORT = 28_173;

/** Reject spaces that split grant tokens and prototype-sensitive keys that index parsed headers. */
export function isTailnetAppCapabilityKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype"
    && !hasControlChars(value)
    && !value.includes(" ");
}

export function parseTailnetAuthorization(value: unknown): TailnetAuthorization | null {
  if (!isRecord(value)) return null;
  if (value.kind === "tailnet-identity") {
    return Object.keys(value).length === 1
      ? Object.freeze({ kind: "tailnet-identity" as const })
      : null;
  }
  if (value.kind === "app-capability" && typeof value.capability === "string") {
    return Object.keys(value).length === 2
      ? Object.freeze({ kind: "app-capability" as const, capability: value.capability })
      : null;
  }
  return null;
}

export function parseTailnetObserverConfigView(
  value: unknown,
): TailnetObserverConfigView | null {
  if (!isRecord(value)) return null;
  const {
    enabled,
    port,
    controllerEnabled,
    pairedSharingEnabled,
    webEnabled,
    webOrigin,
  } = value;
  const authorization = parseTailnetAuthorization(value.authorization);
  if (
    typeof enabled !== "boolean"
    || typeof controllerEnabled !== "boolean"
    || typeof pairedSharingEnabled !== "boolean"
    || typeof webEnabled !== "boolean"
    || authorization === null
    || typeof webOrigin !== "string"
    || typeof port !== "number"
    || !Number.isSafeInteger(port)
  ) {
    return null;
  }
  return Object.freeze({
    enabled,
    authorization,
    port,
    controllerEnabled,
    pairedSharingEnabled,
    webEnabled,
    webOrigin,
  });
}

function parseProvenance(
  value: unknown,
): TailnetObserverSnapshot["provenance"] | null {
  if (!isRecord(value)) return null;
  const provenance = {} as Record<
    TailnetObserverConfigKeyView,
    TailnetObserverConfigSourceView
  >;
  for (const key of TAILNET_OBSERVER_CONFIG_KEYS) {
    const source = value[key];
    if (source !== "file" && source !== "env-override" && source !== "unset") return null;
    provenance[key] = source;
  }
  return Object.freeze(provenance);
}

function isOptionalPort(value: unknown): value is number | null {
  return value === null
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535);
}

function isOptionalText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseTailscaleEnvironmentView(
  value: unknown,
): TailscaleEnvironmentView | null {
  if (!isRecord(value)) return null;
  const { state, login, dnsName, tailnetName, serveConfigured, serveTargetPort, detail } = value;
  if (
    typeof state !== "string"
    || !(TAILSCALE_ENVIRONMENT_STATES as readonly string[]).includes(state)
    || !isOptionalText(login)
    || !isOptionalText(dnsName)
    || !isOptionalText(tailnetName)
    || typeof serveConfigured !== "boolean"
    || !isOptionalPort(serveTargetPort)
    || !isOptionalText(detail)
  ) {
    return null;
  }
  return Object.freeze({
    state: state as TailscaleEnvironmentState,
    login,
    dnsName,
    tailnetName,
    serveConfigured,
    serveTargetPort,
    detail,
  });
}

function parseTailnetObserverPortBlock(value: unknown): TailnetObserverPortBlock | null {
  if (!isRecord(value)) return null;
  const { code, port, hint } = value;
  if (
    (code !== "EADDRINUSE" && code !== "EACCES")
    || typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535
    || (hint !== null && hint !== "excluded-range" && hint !== "mirrored-range")
  ) return null;
  return Object.freeze({ code, port, hint });
}

export function parseTailnetObserverSnapshot(
  value: unknown,
): TailnetObserverSnapshot | null {
  if (!isRecord(value)) return null;
  const saved = parseTailnetObserverConfigView(value.saved);
  const effective = parseTailnetObserverConfigView(value.effective);
  const provenance = parseProvenance(value.provenance);
  const environment = parseTailscaleEnvironmentView(value.environment);
  const portBlock = parseTailnetObserverPortBlock(value.portBlock);
  const {
    listeningPort,
    lastStartError,
    pairedSharingBootstrapFailed,
    ownDeviceAdmission,
    derivedWebOrigin,
    serveCommand,
    configFileError,
  } = value;
  if (
    saved === null
    || effective === null
    || provenance === null
    || environment === null
    || !(listeningPort === null || (typeof listeningPort === "number" && Number.isSafeInteger(listeningPort)))
    || !isOptionalText(lastStartError)
    || (portBlock === null && value.portBlock !== null)
    || typeof pairedSharingBootstrapFailed !== "boolean"
    || typeof ownDeviceAdmission !== "boolean"
    || !isOptionalText(derivedWebOrigin)
    || !isOptionalText(serveCommand)
    || !isOptionalText(configFileError)
  ) {
    return null;
  }
  return Object.freeze({
    saved,
    effective,
    provenance,
    listeningPort,
    lastStartError,
    portBlock,
    pairedSharingBootstrapFailed,
    ownDeviceAdmission,
    environment,
    derivedWebOrigin,
    serveCommand,
    configFileError,
  });
}

export function parseTailnetObserverSnapshotResult(
  value: unknown,
): TailnetObserverSnapshotResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const snapshot = parseTailnetObserverSnapshot(value.snapshot);
    return snapshot === null ? null : Object.freeze({ ok: true as const, snapshot });
  }
  if (value.ok === false && typeof value.error === "string") {
    return Object.freeze({ ok: false as const, error: value.error });
  }
  return null;
}

export function parseTailnetObserverMutationResult(
  value: unknown,
): TailnetObserverMutationResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) return Object.freeze({ ok: true as const });
  if (value.ok === false && typeof value.error === "string") {
    return Object.freeze({ ok: false as const, error: value.error });
  }
  return null;
}

export function parseTailnetObserverApplyResult(value: unknown): TailnetObserverApplyResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    return typeof value.restartNeeded === "boolean"
      ? Object.freeze({ ok: true as const, restartNeeded: value.restartNeeded })
      : null;
  }
  const result = parseTailnetObserverMutationResult(value);
  return result?.ok === false ? result : null;
}

export function parseTailnetGuidedSetupResult(
  value: unknown,
): TailnetGuidedSetupResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    const snapshot = parseTailnetObserverSnapshot(value.snapshot);
    const { webOrigin, port, serve } = value;
    if (
      snapshot === null
      || !isOptionalText(webOrigin)
      || !isOptionalPort(port)
      || port === null
      || (serve !== "configured" && serve !== "already-configured")
    ) {
      return null;
    }
    return Object.freeze({ ok: true as const, snapshot, webOrigin, port, serve });
  }
  const output = value.output === undefined ? null : value.output;
  if (value.ok === false && typeof value.error === "string" && isOptionalText(output)) {
    return Object.freeze({ ok: false as const, error: value.error, output });
  }
  return null;
}

export function parseTailnetServeResult(value: unknown): TailnetServeResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true) {
    return typeof value.url === "string" && value.url.length > 0
      ? Object.freeze({ ok: true as const, url: value.url })
      : null;
  }
  // Failures before command execution legitimately have null output.
  const output = value.output === undefined ? null : value.output;
  if (value.ok === false && typeof value.error === "string" && isOptionalText(output)) {
    return Object.freeze({ ok: false as const, error: value.error, output });
  }
  return null;
}
