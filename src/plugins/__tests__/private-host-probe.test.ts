import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture the mock with vi.hoisted so the hoisted factory avoids the temporal dead zone.
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  __esModule: true,
  default: { lookup: mockLookup },
  lookup: mockLookup,
}));

import {
  probePrivateHost,
  __resetPrivateHostProbeInFlightForTests,
  MAX_INFLIGHT_DISTINCT_HOSTS,
} from "../private-host-probe.js";

describe("probePrivateHost", () => {
  beforeEach(() => {
    __resetPrivateHostProbeInFlightForTests();
    mockLookup.mockReset();
  });

  it("returns true when the host resolves", async () => {
    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    expect(await probePrivateHost("intranet.example.com", { timeoutMs: 500 })).toBe(true);
    expect(mockLookup).toHaveBeenCalledWith("intranet.example.com");
  });

  it("returns false on ENOTFOUND", async () => {
    mockLookup.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND intranet.example.com"), { code: "ENOTFOUND" }),
    );
    expect(await probePrivateHost("intranet.example.com", { timeoutMs: 500 })).toBe(false);
  });

  it("returns false on timeout (fail-safe)", async () => {
    mockLookup.mockReturnValueOnce(new Promise(() => {}) as unknown as Promise<never>);
    expect(await probePrivateHost("intranet.example.com", { timeoutMs: 100 })).toBe(false);
  });

  it("does NOT cache — every call re-probes (off→on and on→off both work)", async () => {
    mockLookup.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await probePrivateHost("intranet.example.com", { timeoutMs: 500 })).toBe(false);

    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    expect(await probePrivateHost("intranet.example.com", { timeoutMs: 500 })).toBe(true);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent callers on the same host (single-flight)", async () => {
    let resolveLookup: (v: { address: string; family: number }) => void = () => {};
    mockLookup.mockReturnValueOnce(
      new Promise((res) => {
        resolveLookup = res;
      }) as unknown as Promise<{ address: string; family: number }>,
    );
    const p1 = probePrivateHost("intranet.example.com", { timeoutMs: 5000 });
    const p2 = probePrivateHost("intranet.example.com", { timeoutMs: 5000 });
    resolveLookup({ address: "10.0.0.1", family: 4 });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it("timeout-wins-race does NOT release the dedup slot (shared in-flight lookup)", async () => {
    let resolveLookup: (v: { address: string; family: number }) => void = () => {};
    mockLookup.mockReturnValueOnce(
      new Promise((res) => {
        resolveLookup = res;
      }) as unknown as Promise<{ address: string; family: number }>,
    );
    const p1 = probePrivateHost("slow.example.com", { timeoutMs: 100 });
    const p2 = probePrivateHost("slow.example.com", { timeoutMs: 100 });
    expect(await p1).toBe(false);
    resolveLookup({ address: "10.0.0.1", family: 4 });
    await p2;
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it("dedup is per-host — different hosts probe independently", async () => {
    mockLookup
      .mockResolvedValueOnce({ address: "10.0.0.1", family: 4 })
      .mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    const [a, b] = await Promise.all([
      probePrivateHost("internal-a.example.com", { timeoutMs: 500 }),
      probePrivateHost("internal-b.example.com", { timeoutMs: 500 }),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it("rejects empty / whitespace / non-string host (never reaches dns.lookup)", async () => {
    await expect(probePrivateHost("")).rejects.toThrow(TypeError);
    await expect(probePrivateHost("   ")).rejects.toThrow(TypeError);
    // @ts-expect-error — runtime guard
    await expect(probePrivateHost(null)).rejects.toThrow(TypeError);
    // @ts-expect-error — runtime guard
    await expect(probePrivateHost(undefined)).rejects.toThrow(TypeError);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects IP literals — an IP resolves numerically and never reaches dns.lookup", async () => {
    // Reject IP literals: dns.lookup can resolve them locally and falsely imply private-network access.
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "8.8.8.8", "0.0.0.0"]) {
      await expect(probePrivateHost(ip)).rejects.toThrow(/IP literal/);
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects a new distinct host once the concurrent in-flight cap is reached (DoS bound)", async () => {
    // Hung distinct hosts fill the in-flight cap; overflow throws while existing-host dedup remains available.
    mockLookup.mockReturnValue(new Promise(() => {}) as unknown as Promise<never>);
    const pending: Array<Promise<boolean>> = [];
    for (let i = 0; i < MAX_INFLIGHT_DISTINCT_HOSTS; i++) {
      pending.push(probePrivateHost(`host-${i}.example.com`, { timeoutMs: 5000 }));
    }
    // Dedup registration is synchronous even though lookup dispatch uses a microtask.
    // A host already in flight consumes no extra slot.
    pending.push(probePrivateHost("host-0.example.com", { timeoutMs: 5000 }));
    await expect(
      probePrivateHost("overflow.example.com", { timeoutMs: 5000 }),
    ).rejects.toThrow(/too many concurrent/);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLookup).toHaveBeenCalledTimes(MAX_INFLIGHT_DISTINCT_HOSTS);
    // Observe hung promises until their unref deadlines resolve false.
    pending.forEach((p) => void p.then(() => {}));
  });

  it("rejects non-bare hostnames — URLs, host:port, paths, userinfo, whitespace", async () => {
    for (const bad of [
      "https://intranet.example.com",
      "intranet.example.com:443",
      "intranet.example.com/login",
      "user@intranet.example.com",
      "intranet.example.com?q=1",
      "has space.example.com",
    ]) {
      await expect(probePrivateHost(bad)).rejects.toThrow(/bare hostname/);
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("clamps an absurdly large timeout so a hung lookup still fails-safe within bounds", async () => {
    // Virtual time verifies the module ceiling clamps an excessive requested timeout.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockLookup.mockReturnValueOnce(new Promise(() => {}) as unknown as Promise<never>);
      let answer: boolean | undefined;
      const probe = probePrivateHost("hang.example.com", { timeoutMs: 3_600_000 }).then((value) => {
        answer = value;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await probe;
      expect(answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default timeout for NaN / negative / non-number input", async () => {
    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    expect(typeof (await probePrivateHost("a.example.com", { timeoutMs: Number.NaN }))).toBe("boolean");
    mockLookup.mockResolvedValueOnce({ address: "10.0.0.1", family: 4 });
    expect(typeof (await probePrivateHost("b.example.com", { timeoutMs: -50 }))).toBe("boolean");
  });
});
