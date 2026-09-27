import { describe, expect, it, vi } from "vitest";
import { CredentialLeaseRegistry, type LeaseStateSource } from "../credential-lease-registry.js";

function setup() {
  let config = 0;
  const secrets = new Map<string, number>();
  const listeners = new Set<() => void>();
  const source: LeaseStateSource = {
    getProviderConfigRevision: () => config,
    getSecretGeneration: (key) => secrets.get(key) ?? 0,
    onLeaseStateChanged: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const registry = new CredentialLeaseRegistry(source);
  const incarnation = {};
  const permission = new AbortController();
  const key = "llm.apiKey.openai";
  const reserve = (exposure: "lease" | "raw" = "lease") =>
    registry.reserve("sample", incarnation, [key], permission.signal, exposure);
  const issue = (exposure: "lease" | "raw" = "lease") => {
    const reservation = reserve(exposure);
    if (!reservation) throw new Error("reservation missing");
    const result = registry.register(reservation, {
      key, vendor: "openai", secret: "synthetic-secret", scheme: "bearer",
      audience: (url) => url.origin === "https://api.example.test",
      permissionSignal: permission.signal,
    });
    if (!result) throw new Error("registration missing");
    return result;
  };
  return {
    registry, incarnation, permission, key, reserve, issue,
    changeConfig: () => { config += 1; for (const listener of listeners) listener(); },
    changeSecret: () => { secrets.set(key, (secrets.get(key) ?? 0) + 1); for (const listener of listeners) listener(); },
  };
}

describe("credential lease registry", () => {
  it("reserves the 32 slots before an asynchronous gate can admit a 33rd", () => {
    const state = setup();
    const reservations = Array.from({ length: 32 }, () => state.reserve());
    expect(reservations.every(Boolean)).toBe(true);
    expect(state.reserve()).toBeNull();
    reservations[0]?.finish();
    expect(state.reserve()).not.toBeNull();
  });

  it("refuses a registration whose configuration, secret, permission or incarnation changed during issuance", () => {
    for (const change of ["config", "secret", "permission", "retire"] as const) {
      const state = setup();
      const reservation = state.reserve();
      if (!reservation) throw new Error("reservation missing");
      if (change === "config") state.changeConfig();
      else if (change === "secret") state.changeSecret();
      else if (change === "permission") state.permission.abort();
      else state.registry.endIncarnation(state.incarnation);
      expect(state.registry.register(reservation, {
        key: state.key, vendor: "openai", secret: "synthetic-secret", scheme: "bearer",
        audience: () => true, permissionSignal: state.permission.signal,
      })).toBeNull();
      if (change !== "retire") expect(state.reserve()).not.toBeNull();
    }
  });

  it("binds use to the owner, incarnation and HTTPS audience", async () => {
    const state = setup();
    const result = state.issue();
    if (result.exposure !== "lease") throw new Error("expected lease");
    expect(() => state.registry.beginUse(result.leaseId, "foreign", state.incarnation)).toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
    expect(() => state.registry.beginUse(result.leaseId, "sample", {})).toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
    const use = state.registry.beginUse(result.leaseId, "sample", state.incarnation);
    expect(use.headersFor(new URL("https://api.example.test/path"), 0).get("authorization")).toBe("Bearer synthetic-secret");
    expect(() => use.headersFor(new URL("https://else.example.test/"), 1)).toThrowError(expect.objectContaining({ code: "lease-audience-denied" }));
    expect(() => use.headersFor(new URL("http://api.example.test/"), 1)).toThrowError(expect.objectContaining({ code: "lease-audience-denied" }));
    await result.release();
    expect(use.signal.aborted).toBe(true);
    expect(() => state.registry.beginUse(result.leaseId, "sample", state.incarnation)).toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
    await expect(result.release()).resolves.toBeUndefined();
  });

  it("closes all concurrent uses on revoke and replays closure to a late listener", () => {
    const state = setup();
    const result = state.issue();
    if (result.exposure !== "lease") throw new Error("expected lease");
    const first = state.registry.beginUse(result.leaseId, "sample", state.incarnation);
    const second = state.registry.beginUse(result.leaseId, "sample", state.incarnation);
    const early = vi.fn();
    result.onClosed(early);
    state.changeSecret();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(early).toHaveBeenCalledExactlyOnceWith("revoked");
    const late = vi.fn();
    result.onClosed(late);
    expect(late).toHaveBeenCalledExactlyOnceWith("revoked");
  });

  it("marks every lease from a retired incarnation peer-gone", () => {
    const state = setup();
    const first = state.issue();
    const second = state.issue();
    if (first.exposure !== "lease" || second.exposure !== "lease") throw new Error("expected leases");
    const closed = vi.fn();
    first.onClosed(closed);
    second.onClosed(closed);
    state.registry.endIncarnation(state.incarnation);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenNthCalledWith(1, "peer-gone");
    expect(closed).toHaveBeenNthCalledWith(2, "peer-gone");
    expect(() => state.registry.beginUse(first.leaseId, "sample", state.incarnation))
      .toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
  });

  it("keeps raw registrations out of hostFetch", () => {
    const state = setup();
    const result = state.issue("raw");
    if (result.exposure !== "raw") throw new Error("expected raw");
    expect(result.key).toBe("synthetic-secret");
    const id = (result as typeof result & { handleId: string }).handleId;
    expect(() => state.registry.beginUse(id, "sample", state.incarnation)).toThrowError(expect.objectContaining({ code: "lease-unavailable" }));
  });

  it.each([
    ["bearer", "authorization", "Bearer synthetic-secret"],
    ["api-key", "api-key", "synthetic-secret"],
    ["x-api-key", "x-api-key", "synthetic-secret"],
  ] as const)("injects the host-selected %s scheme only inside its audience", (scheme, header, value) => {
    const state = setup();
    const reservation = state.reserve();
    if (!reservation) throw new Error("reservation missing");
    const result = state.registry.register(reservation, {
      key: state.key, vendor: "source", secret: "synthetic-secret", scheme,
      audience: (url) => url.origin === "https://api.example.test",
      permissionSignal: state.permission.signal,
    });
    if (!result || result.exposure !== "lease") throw new Error("lease missing");
    const use = state.registry.beginUse(result.leaseId, "sample", state.incarnation);
    const headers = use.headersFor(new URL("https://api.example.test/"), 0);
    expect(headers.get(header)).toBe(value);
    expect(() => use.headersFor(new URL("https://other.example.test/"), 1))
      .toThrowError(expect.objectContaining({ code: "lease-audience-denied" }));
  });
});
