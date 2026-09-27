import { randomBytes } from "node:crypto";
import type { ApiKeyLease, ApiKeyRaw } from "../public-contract.js";

export type CredentialScheme = "bearer" | "api-key" | "x-api-key";
export type LeaseStage = "before-send" | "redirect" | "after-await";

export class CredentialLeaseError extends Error {
  constructor(
    readonly code: "lease-unavailable" | "lease-audience-denied" | "credential-conflict",
    readonly detail: Record<string, string | number> = {},
  ) {
    super({
      "lease-unavailable": "Credential lease is unavailable.",
      "lease-audience-denied": "Credential lease audience denied this URL.",
      "credential-conflict": "Credential selector conflicts with request credentials.",
    }[code]);
    this.name = "CredentialLeaseError";
  }
}

export interface LeaseStateSource {
  getProviderConfigRevision(): number;
  getSecretGeneration(key: string): number;
  isSecretIdentityUsable?(): boolean;
  onLeaseStateChanged(listener: () => void): () => void;
}

interface Snapshot {
  readonly permissionSignal: AbortSignal;
  readonly permissionEpoch: number;
  readonly providerConfigRevision: number;
  readonly secretGenerations: ReadonlyMap<string, number>;
}

interface Registration {
  readonly id: string;
  readonly pluginId: string;
  readonly incarnation: object;
  readonly snapshot: Snapshot;
  readonly key: string;
  readonly vendor: string;
  readonly baseUrl?: string;
  readonly audience: (url: URL) => boolean;
  readonly scheme: CredentialScheme;
  readonly uses: Set<AbortController>;
  readonly listeners: Set<(reason: "revoked" | "peer-gone") => void>;
  readonly onClose?: (reason: "revoked" | "peer-gone") => void;
  secret: string | null;
  state: "active" | "released" | "revoked";
  reason?: "revoked" | "peer-gone";
}

/** One reservation starts before the first asynchronous authority lookup. */
export interface IssuanceReservation {
  readonly pluginId: string;
  readonly incarnation: object;
  readonly snapshot: Snapshot;
  readonly id: string;
  finish(): void;
}

export class CredentialLeaseRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly occupied = new Map<object, number>();
  private readonly retired = new WeakSet<object>();

  constructor(private readonly state: LeaseStateSource, private readonly getPermissionEpoch: (pluginId: string) => number = () => 0) {
    state.onLeaseStateChanged(() => this.closeStale());
  }

  reserve(
    pluginId: string,
    incarnation: object,
    keys: readonly string[],
    permissionSignal: AbortSignal,
    exposure: "lease" | "raw",
  ): IssuanceReservation | null {
    const occupied = this.occupied.get(incarnation) ?? 0;
    if (occupied >= 32) return null;
    this.occupied.set(incarnation, occupied + 1);
    const secretGenerations = new Map(keys.map((key) => [key, this.state.getSecretGeneration(key)]));
    const snapshot: Snapshot = {
      permissionSignal,
      permissionEpoch: this.getPermissionEpoch(pluginId),
      secretGenerations,
      providerConfigRevision: this.state.getProviderConfigRevision(),
    };
    let finished = false;
    return {
      id: `${exposure === "lease" ? "lease" : "raw"}_${randomBytes(16).toString("hex")}`,
      pluginId,
      incarnation,
      snapshot,
      finish: () => {
        if (finished) return;
        finished = true;
        this.occupied.set(incarnation, (this.occupied.get(incarnation) ?? 1) - 1);
      },
    };
  }

  current(reservation: IssuanceReservation, key: string, permissionSignal: AbortSignal): boolean {
    const snapshot = reservation.snapshot;
    return !snapshot.permissionSignal.aborted
      && !this.retired.has(reservation.incarnation)
      && snapshot.permissionSignal === permissionSignal
      && snapshot.permissionEpoch === this.getPermissionEpoch(reservation.pluginId)
      && snapshot.providerConfigRevision === this.state.getProviderConfigRevision()
      && snapshot.secretGenerations.get(key) === this.state.getSecretGeneration(key)
      && this.state.isSecretIdentityUsable?.() !== false;
  }

  register(
    reservation: IssuanceReservation,
    input: {
      key: string;
      vendor: string;
      baseUrl?: string;
      secret: string;
      audience: (url: URL) => boolean;
      scheme: CredentialScheme;
      permissionSignal: AbortSignal;
      onClose?: (reason: "revoked" | "peer-gone") => void;
    },
  ): ({ ok: true } & (ApiKeyLease | ApiKeyRaw)) | null {
    if (!this.current(reservation, input.key, input.permissionSignal)) {
      reservation.finish();
      return null;
    }
    const isRaw = reservation.id.startsWith("raw_");
    const registration: Registration = {
      id: reservation.id,
      pluginId: reservation.pluginId,
      incarnation: reservation.incarnation,
      snapshot: reservation.snapshot,
      key: input.key,
      vendor: input.vendor,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      audience: input.audience,
      scheme: input.scheme,
      uses: new Set(),
      listeners: new Set(),
      ...(input.onClose ? { onClose: input.onClose } : {}),
      secret: isRaw ? null : input.secret,
      state: "active",
    };
    this.registrations.set(registration.id, registration);
    input.permissionSignal.addEventListener("abort", () => this.close(registration.id, "revoked"), { once: true });
    const release = async (): Promise<void> => { this.close(registration.id, "released"); };
    if (isRaw) return Object.defineProperties({
      ok: true,
      exposure: "raw",
      vendor: input.vendor,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      key: input.secret,
      release,
    }, {
      handleId: { value: registration.id },
      onClosed: { value: (listener: (reason: "revoked" | "peer-gone") => void) => {
        if (registration.reason) listener(registration.reason);
        else if (registration.state === "active") registration.listeners.add(listener);
        return () => { registration.listeners.delete(listener); };
      } },
    });
    return {
      ok: true,
      exposure: "lease",
      leaseId: registration.id,
      vendor: input.vendor,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      release,
      onClosed: (listener) => {
        if (registration.reason) listener(registration.reason);
        else if (registration.state === "active") registration.listeners.add(listener);
        return () => { registration.listeners.delete(listener); };
      },
    };
  }

  close(id: string, reason: "released" | "revoked" | "peer-gone"): void {
    const registration = this.registrations.get(id);
    if (!registration) return;
    this.registrations.delete(id);
    registration.state = reason === "released" ? "released" : "revoked";
    registration.secret = null;
    for (const use of registration.uses) use.abort();
    registration.uses.clear();
    this.occupied.set(registration.incarnation, (this.occupied.get(registration.incarnation) ?? 1) - 1);
    if (reason !== "released") {
      registration.reason = reason;
      for (const listener of registration.listeners) {
        try { listener(reason); } catch { /* every listener still receives closure */ }
      }
      try { registration.onClose?.(reason); } catch { /* closure remains terminal */ }
    }
    registration.listeners.clear();
  }

  endIncarnation(incarnation: object): void {
    this.retired.add(incarnation);
    for (const registration of [...this.registrations.values()]) {
      if (registration.incarnation === incarnation) this.close(registration.id, "peer-gone");
    }
    this.occupied.delete(incarnation);
  }

  private closeStale(): void {
    for (const registration of [...this.registrations.values()]) {
      if (!this.isCurrent(registration)) this.close(registration.id, "revoked");
    }
  }

  private isCurrent(registration: Registration): boolean {
    return registration.state === "active" && !registration.snapshot.permissionSignal.aborted
      && !this.retired.has(registration.incarnation)
      && registration.snapshot.permissionEpoch === this.getPermissionEpoch(registration.pluginId)
      && registration.snapshot.providerConfigRevision === this.state.getProviderConfigRevision()
      && registration.snapshot.secretGenerations.get(registration.key) === this.state.getSecretGeneration(registration.key)
      && this.state.isSecretIdentityUsable?.() !== false;
  }

  beginUse(id: string, pluginId: string, incarnation: object): {
    signal: AbortSignal;
    assertLive(stage: LeaseStage): void;
    headersFor(url: URL, hop: number): Headers;
    finish(): void;
  } {
    const registration = this.registrations.get(id);
    if (!registration || registration.pluginId !== pluginId || registration.incarnation !== incarnation
      || id.startsWith("raw_")) throw new CredentialLeaseError("lease-unavailable", { stage: "before-send" });
    const controller = new AbortController();
    registration.uses.add(controller);
    const assertLive = (stage: LeaseStage): void => {
      if (!this.isCurrent(registration) || controller.signal.aborted) {
        this.close(id, "revoked");
        throw new CredentialLeaseError("lease-unavailable", { stage });
      }
    };
    return {
      signal: controller.signal,
      assertLive,
      headersFor: (url, hop) => {
        assertLive(hop === 0 ? "before-send" : "redirect");
        if (url.protocol !== "https:" || !registration.audience(url)) {
          throw new CredentialLeaseError("lease-audience-denied", { origin: url.origin, hop });
        }
        const headers = new Headers();
        const key = registration.secret;
        if (key === null) throw new CredentialLeaseError("lease-unavailable", { stage: "after-await" });
        if (registration.scheme === "bearer") headers.set("authorization", `Bearer ${key}`);
        else if (registration.scheme === "api-key") headers.set("api-key", key);
        else {
          headers.set("x-api-key", key);
          headers.set("anthropic-version", "2023-06-01");
        }
        return headers;
      },
      finish: () => { registration.uses.delete(controller); },
    };
  }
}
