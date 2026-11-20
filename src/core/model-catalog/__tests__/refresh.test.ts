/** Download failures must preserve the last verified cache or bundled snapshot; inspect both bytes and next-boot selection. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireSymlinkCapability } from "../../../__tests__/support/symlink-capability.js";
import { buildModelCatalogDocument } from "../document-builder.js";
import { selectBootModelCatalog } from "../bundled.js";
import { MODEL_CATALOG_CACHE_MAX_ENTRIES, modelCatalogCacheDir, readCachedModelCatalog, readModelCatalogPointer } from "../cache.js";
import {
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  MODEL_CATALOG_REFRESH_URL,
  refreshModelCatalogCache,
} from "../refresh.js";
import { decideModelCatalogRefresh, readModelCatalogRefreshPolicy } from "../refresh-policy.js";
import { pruneModelsDevDocument } from "../../../shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../../shared/model-catalog/provider-map.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";
import { activeModelCatalog } from "../../../shared/model-catalog/active.js";
import { withFileLock } from "../../../lib/with-file-lock.js";

vi.mock("../../../lib/admin-policy-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-policy-file.js")>()),
  readAdminPolicyFile: (path: string) => import("node:fs/promises").then(({ readFile }) => readFile(path)),
}));

const lookupMock = vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]);
vi.mock("node:dns", () => ({ promises: { lookup: () => lookupMock() } }));

const LICENSE = {
  spdx: "MIT" as const,
  copyright: "Copyright (c) 2025 models.dev",
  repository: "https://github.com/anomalyco/models.dev",
  text: "MIT License\n\nCopyright (c) 2025 models.dev\n",
};

function rawDocument(openaiContext = 400_000): Record<string, unknown> {
  return {
    openai: { id: "openai", name: "OpenAI", models: { "gpt-fixture": { id: "gpt-fixture", limit: { context: openaiContext, output: 128_000 } } } },
    anthropic: { id: "anthropic", name: "Anthropic", models: { "claude-fixture": { id: "claude-fixture", limit: { context: 200_000, output: 64_000 } } } },
    unrelated: { id: "unrelated", models: { other: { id: "other" } } },
  };
}

function documentFrom(raw: Record<string, unknown>, fetchedAt: string): ModelCatalogDocument {
  return buildModelCatalogDocument({
    input: pruneModelsDevDocument(raw, catalogProviderIds()),
    providerIds: catalogProviderIds(),
    source: { url: MODEL_CATALOG_REFRESH_URL, fetchedAt, rawSha256: "0".repeat(64) },
    license: LICENSE,
  }).document;
}

const BUNDLED = documentFrom(rawDocument(272_000), "2026-01-01T00:00:00Z");
const loadBundled = async () => BUNDLED;

const NOW = new Date("2026-10-12T12:00:00Z");

interface Seen {
  url: string;
  init: RequestInit;
}

function respondWith(make: (seen: Seen) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const seen = { url: String(input), init: init ?? {} };
    calls.push(seen);
    return make(seen);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "model-catalog-refresh-"));
  lookupMock.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function cacheFiles(): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).filter((name) => !name.startsWith(".")).sort().map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
}

async function seedGoodCopy(at = NOW): Promise<string> {
  const { fetchImpl } = respondWith(() => json(rawDocument(), { etag: "\"v1\"" }));
  const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => at });
  expect(result.status).toBe("updated");
  return (result as { sha256: string }).sha256;
}

const STALE = new Date(NOW.getTime() + MODEL_CATALOG_REFRESH_INTERVAL_MS + 1000);

describe("refreshModelCatalogCache", () => {
  it("a waiting refresh does not create a missing anchor before it holds the lock", async () => {
    const anchor = join(dir, ".refresh-lock");
    const { fetchImpl, calls } = respondWith(() => json(rawDocument()));
    let refresh: ReturnType<typeof refreshModelCatalogCache> | undefined;
    try {
      await withFileLock(anchor, async () => {
        rmSync(anchor);
        refresh = refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW });
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(existsSync(anchor)).toBe(false);
        expect(calls).toHaveLength(0);
      });
    } finally {
      if (refresh) {
        expect(await refresh).toMatchObject({ status: "updated" });
      }
    }
    expect(existsSync(anchor)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache" });
  });

  it("keeps the installed process catalog unchanged until another boot", async () => {
    const installed = activeModelCatalog();
    const { fetchImpl } = respondWith(() => json(rawDocument()));
    expect((await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW })).status).toBe("updated");
    expect(activeModelCatalog()).toBe(installed);
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache" });
  });

  it("downloads one public document with nothing about the user, and stores it for the next boot", async () => {
    const { fetchImpl, calls } = respondWith(() => json(rawDocument(), { etag: "\"v1\"" }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW });

    expect(result.status).toBe("updated");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://models.dev/api.json");
    expect(calls[0]!.init.method).toBe("GET");
    expect(Object.keys(calls[0]!.init.headers as Record<string, string>).sort()).toEqual(["accept"]);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(lookupMock).toHaveBeenCalled();

    const sha256 = (result as { sha256: string }).sha256;
    expect(Object.keys(cacheFiles()).sort()).toEqual([`${sha256}.json`, "current.json"].sort());
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of [`${sha256}.json`, "current.json"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    const pointer = await readModelCatalogPointer(dir);
    expect(pointer).toEqual({ ok: true, value: { version: 1, sha256, etag: "\"v1\"", checkedAt: "2026-10-12T12:00:00Z" } });

    const stored = JSON.parse(cacheFiles()[`${sha256}.json`]!) as ModelCatalogDocument;
    expect(stored.provenance).toMatchObject({
      url: MODEL_CATALOG_REFRESH_URL,
      fetchedAt: "2026-10-12T12:00:00Z",
      etag: "\"v1\"",
      rawSha256: createHash("sha256").update(JSON.stringify(rawDocument())).digest("hex"),
    });
    expect(stored.license).toEqual(BUNDLED.license);
    expect(Object.keys(stored.providers).sort()).toEqual(["anthropic", "openai"]);

    const boot = await selectBootModelCatalog({ env: {}, dir, loadBundled });
    expect(boot.origin).toBe("cache");
    expect(boot.document.sha256).toBe(sha256);
    expect(boot.document.providers.openai!.models["gpt-fixture"]!.limits.context).toBe(400_000);
  });

  it("sends nothing while the cached copy is under a day old", async () => {
    await seedGoodCopy();
    const { fetchImpl, calls } = respondWith(() => json(rawDocument()));
    const result = await refreshModelCatalogCache({
      fetchImpl, dir, reference: BUNDLED, now: () => new Date(NOW.getTime() + MODEL_CATALOG_REFRESH_INTERVAL_MS - 1000),
    });
    expect(result.status).toBe("fresh");
    expect(calls).toHaveLength(0);
  });

  it("throttles failed attempts across launches until a day has elapsed", async () => {
    const { fetchImpl, calls } = respondWith(() => new Response(null, { status: 503 }));
    expect((await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW })).status).toBe("failed");
    expect((await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW })).status).toBe("throttled");
    expect(calls).toHaveLength(1);
    expect((await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE })).status).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("serializes concurrent refreshes into one request and one complete pointer", async () => {
    const { fetchImpl, calls } = respondWith(() => json(rawDocument()));
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW })));
    expect(calls).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(["fresh", "fresh", "fresh", "fresh", "updated"]);
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache" });
  });

  it("rechecks after the clock moves behind the recorded check", async () => {
    await seedGoodCopy(STALE);
    const { fetchImpl, calls } = respondWith(() => json(rawDocument()));
    await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW });
    expect(calls).toHaveLength(1);
  });

  it("bounds retained catalogs while keeping current and last-good copies", async () => {
    writeFileSync(join(dir, "notes.json"), "unrelated");
    const hashes: string[] = [];
    for (let index = 0; index < MODEL_CATALOG_CACHE_MAX_ENTRIES + 3; index++) {
      const { fetchImpl } = respondWith(() => json(rawDocument(400_000 + index)));
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => new Date(NOW.getTime() + index * MODEL_CATALOG_REFRESH_INTERVAL_MS) });
      expect(result.status).toBe("updated");
      hashes.push((result as { sha256: string }).sha256);
    }
    const names = readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    expect(names).toHaveLength(MODEL_CATALOG_CACHE_MAX_ENTRIES);
    expect(names).toContain(`${hashes.at(-1)}.json`);
    expect(names).toContain(`${hashes.at(-2)}.json`);
    expect(readFileSync(join(dir, "notes.json"), "utf-8")).toBe("unrelated");
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache", document: { sha256: hashes.at(-1) } });
  });

  it("asks conditionally once the copy is a day old, and a 304 only renews the pointer", async () => {
    const sha256 = await seedGoodCopy();
    const entryBefore = cacheFiles()[`${sha256}.json`];
    const { fetchImpl, calls } = respondWith(() => new Response(null, { status: 304, headers: { etag: "\"v1\"" } }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });

    expect(result).toEqual({ status: "not-modified", sha256 });
    expect((calls[0]!.init.headers as Record<string, string>)["if-none-match"]).toBe("\"v1\"");
    expect(cacheFiles()[`${sha256}.json`]).toBe(entryBefore);
    const pointer = await readModelCatalogPointer(dir);
    expect(pointer.ok && pointer.value.checkedAt).toBe(STALE.toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("rejects an unsolicited 304 when the cached copy has no ETag", async () => {
    const initial = respondWith(() => json(rawDocument()));
    await refreshModelCatalogCache({ fetchImpl: initial.fetchImpl, dir, reference: BUNDLED, now: () => NOW });
    const before = cacheFiles();
    const { fetchImpl, calls } = respondWith(() => new Response(null, { status: 304 }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });
    expect((calls[0]!.init.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("answered 304") });
    expect(cacheFiles()).toEqual(before);
  });

  it("rejects an ETag that would publish an unreadable pointer", async () => {
    const sha256 = await seedGoodCopy();
    const before = readFileSync(join(dir, "current.json"), "utf-8");
    const { fetchImpl } = respondWith(() => json(rawDocument(800_000), { etag: "x".repeat(64 * 1024) }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });
    expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("65536-byte cap") });
    expect(readFileSync(join(dir, "current.json"), "utf-8")).toBe(before);
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache", document: { sha256 } });
  });

  describe("a failed refresh keeps the last good copy", () => {
    const cases: Array<[string, () => Response | Promise<Response>, RegExp]> = [
      ["403", () => new Response("denied", { status: 403 }), /answered 403/],
      ["404", () => new Response("missing", { status: 404 }), /answered 404/],
      ["a declared size over the cap", () => new Response("{}", { status: 200, headers: { "content-length": String(MODEL_CATALOG_MAX_BYTES + 1) } }), /over the 16777216-byte cap/],
      ["a body that grows past the cap", () => {
        const chunk = new Uint8Array(1024 * 1024).fill(0x20);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
            if (sent > MODEL_CATALOG_MAX_BYTES + chunk.byteLength) controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }, /exceeds the 16777216-byte cap/],
      ["a body that is not JSON", () => new Response("<html>maintenance</html>", { status: 200 }), /not JSON/],
      ["JSON that is not a models.dev document", () => json([1, 2, 3]), /not an object/],
      ["a document missing a provider the catalog in force lists", () => json({ openai: rawDocument().openai }), /lists no models for anthropic/],
    ];

    it.each(cases)("%s", async (_label, make, reason) => {
      const sha256 = await seedGoodCopy();
      const before = cacheFiles();
      const { fetchImpl } = respondWith(make);
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });

      expect(result.status).toBe("failed");
      expect((result as { reason: string }).reason).toMatch(reason);
      expect(cacheFiles()).toEqual(before);
      const boot = await selectBootModelCatalog({ env: {}, dir, loadBundled });
      expect(boot).toMatchObject({ origin: "cache", document: { sha256 } });
    });

    it("a request that times out", async () => {
      const sha256 = await seedGoodCopy();
      const before = cacheFiles();
      const { fetchImpl } = respondWith(({ init }) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
      const started = Date.now();
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE, timeoutMs: 50 });

      expect(Date.now() - started).toBeLessThan(3000);
      expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/request failed/) });
      expect(cacheFiles()).toEqual(before);
      expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "cache", document: { sha256 } });
    });

    it("a body that stalls after the headers", async () => {
      await seedGoodCopy();
      const before = cacheFiles();
      const { fetchImpl } = respondWith(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status: 200 }));
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE, timeoutMs: 50 });

      expect(result).toMatchObject({ status: "failed", reason: expect.stringMatching(/did not arrive within 50 ms/) });
      expect(cacheFiles()).toEqual(before);
    });

    it("bounds a stalled DNS lookup by the total deadline", async () => {
      let releaseLookup: ((answers: Array<{ address: string; family: number }>) => void) | undefined;
      let enteredLookup!: () => void;
      const entered = new Promise<void>((resolve) => { enteredLookup = resolve; });
      lookupMock.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = resolve; enteredLookup(); }));
      const { fetchImpl } = respondWith(() => json(rawDocument()));
      let settled: unknown;
      const pending = refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, timeoutMs: 30 })
        .then((result) => { settled = result; return result; });
      try {
        await Promise.race([entered, pending.then(() => { throw new Error("download settled before the DNS fixture started"); })]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(settled).toMatchObject({ status: "failed", reason: expect.stringMatching(/30 ms/) });
      } finally {
        releaseLookup?.([{ address: "93.184.215.14", family: 4 }]);
        await pending;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cacheFiles()).toEqual({});
    });

    it("does not wait for a stalled cancellation after the deadline", async () => {
      let releaseCancel!: () => void;
      const cancellation = new Promise<void>((resolve) => { releaseCancel = resolve; });
      let enteredBody!: () => void;
      const entered = new Promise<void>((resolve) => { enteredBody = resolve; });
      const { fetchImpl } = respondWith(() => {
        enteredBody();
        return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => cancellation }));
      });
      let settled: unknown;
      const pending = refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, timeoutMs: 30 })
        .then((result) => { settled = result; return result; });
      try {
        await Promise.race([entered, pending.then(() => { throw new Error("download settled before the body fixture started"); })]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(settled).toMatchObject({ status: "failed", reason: expect.stringMatching(/30 ms/) });
      } finally {
        releaseCancel();
        await pending;
      }
      expect(cacheFiles()).toEqual({});
    });

    it("cancels a declared oversized body without waiting for cleanup", async () => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const { fetchImpl } = respondWith(() => new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "content-length": String(MODEL_CATALOG_MAX_BYTES + 1) },
      }));
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED });
      expect(result.status).toBe("failed");
      expect(cancel).toHaveBeenCalledOnce();
    });

    it("a download still streaming when the app quits", async () => {
      await seedGoodCopy();
      const before = cacheFiles();
      const quit = new AbortController();
      const { fetchImpl } = respondWith(() => {
        setTimeout(() => quit.abort(), 20);
        return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status: 200 });
      });
      const started = Date.now();
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE, signal: quit.signal });

      expect(Date.now() - started).toBeLessThan(3000);
      expect(result).toEqual({ status: "failed", reason: "aborted" });
      expect(cacheFiles()).toEqual(before);
    });

    it("a redirect to a private address, refused by the guard", async () => {
      await seedGoodCopy();
      const before = cacheFiles();
      const { fetchImpl, calls } = respondWith(() => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/api.json" } }));
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });

      expect(result.status).toBe("failed");
      expect(calls).toHaveLength(1);
      expect(cacheFiles()).toEqual(before);
    });

    it.each([
      "https://example.com/api.json",
      "http://models.dev/api.json",
      "https://models.dev/other.json",
    ])("refuses a redirect away from the fixed source: %s", async (location) => {
      await seedGoodCopy();
      const before = cacheFiles();
      const { fetchImpl, calls } = respondWith(({ url }) => url === MODEL_CATALOG_REFRESH_URL
        ? new Response(null, { status: 302, headers: { location } })
        : json(rawDocument(800_000)));
      const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.redirect).toBe("manual");
      expect(result.status).toBe("failed");
      expect(cacheFiles()).toEqual(before);
    });
  });

  it("with no cache yet, a failure leaves the bundled snapshot in force", async () => {
    const { fetchImpl } = respondWith(() => new Response("down", { status: 503 }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => NOW });

    expect(result.status).toBe("failed");
    expect(cacheFiles()).toEqual({});
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "bundled", document: { sha256: BUNDLED.sha256 } });
  });

  it("refetches without the ETag when the copy the pointer names is damaged", async () => {
    const sha256 = await seedGoodCopy();
    writeFileSync(join(dir, `${sha256}.json`), "{}");
    const { fetchImpl, calls } = respondWith(() => json(rawDocument(), { etag: "\"v2\"" }));
    const result = await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });

    expect(result.status).toBe("updated");
    expect((calls[0]!.init.headers as Record<string, string>)["if-none-match"]).toBeUndefined();
  });
});

describe("selectBootModelCatalog", () => {
  it("leaves an absent cache and its parent absent during boot selection", async () => {
    const absent = join(dir, "absent", "model-catalog");
    expect(await selectBootModelCatalog({ env: {}, dir: absent, loadBundled })).toMatchObject({ origin: "bundled" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.for(["current.json", "entry"])("refuses a linked cache %s", async (name, { skip }) => {
    requireSymlinkCapability(dir, "file", skip);
    const sha256 = await seedGoodCopy();
    const path = join(dir, name === "entry" ? `${sha256}.json` : name);
    const external = join(dir, "outside.json");
    writeFileSync(external, readFileSync(path));
    rmSync(path);
    symlinkSync(external, path);
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "bundled" });
  });

  it("refuses a linked cache directory", async ({ skip }) => {
    requireSymlinkCapability(dir, "dir", skip);
    await seedGoodCopy();
    const linked = join(dir, "linked");
    symlinkSync(dir, linked, "dir");
    expect(await selectBootModelCatalog({ env: {}, dir: linked, loadBundled })).toMatchObject({ origin: "bundled" });
  });

  it("refuses to publish through a linked cache parent", async ({ skip }) => {
    requireSymlinkCapability(dir, "dir", skip);
    const home = join(dir, "home");
    const outside = join(dir, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    symlinkSync(outside, join(home, "cache"), "dir");
    vi.stubEnv("AVE_HOME", home);
    const { fetchImpl } = respondWith(() => json(rawDocument()));
    const result = await refreshModelCatalogCache({ fetchImpl, dir: modelCatalogCacheDir(), reference: BUNDLED });
    expect(result.status).toBe("failed");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("caps a tampered cache file before parsing it", async () => {
    const sha256 = await seedGoodCopy();
    writeFileSync(join(dir, `${sha256}.json`), " ".repeat(MODEL_CATALOG_MAX_BYTES + 1));
    expect(await readCachedModelCatalog(dir, sha256)).toMatchObject({ ok: false, reason: expect.stringContaining("byte cap") });
  });

  it("rejects a pointer trying to escape the directory", async () => {
    await seedGoodCopy();
    writeFileSync(join(dir, "current.json"), JSON.stringify({ version: 1, sha256: "../outside", checkedAt: NOW.toISOString() }));
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "bundled" });
  });

  it("uses the same verified bytes after a cached path is replaced", async () => {
    const sha256 = await seedGoodCopy();
    const read = await readCachedModelCatalog(dir, sha256);
    writeFileSync(join(dir, `${sha256}.json`), "{}");
    expect(read).toMatchObject({ ok: true, value: { sha256, providers: { openai: { models: { "gpt-fixture": { limits: { context: 400_000 } } } } } } });
  });

  it("falls to the bundled snapshot when the cached copy fails verification", async () => {
    const sha256 = await seedGoodCopy();
    const path = join(dir, `${sha256}.json`);
    const tampered = JSON.parse(readFileSync(path, "utf-8")) as ModelCatalogDocument;
    tampered.providers.openai!.models["gpt-fixture"]!.limits.context = 1;
    writeFileSync(path, JSON.stringify(tampered));

    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "bundled", document: { sha256: BUNDLED.sha256 } });
  });

  it("falls to the bundled snapshot when the pointer is damaged", async () => {
    await seedGoodCopy();
    writeFileSync(join(dir, "current.json"), "not json");
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled })).toMatchObject({ origin: "bundled" });
  });

  it("prefers a bundled snapshot newer than the cached copy", async () => {
    await seedGoodCopy();
    const newer = documentFrom(rawDocument(1_000_000), "2026-11-01T00:00:00Z");
    expect(await selectBootModelCatalog({ env: {}, dir, loadBundled: async () => newer })).toMatchObject({ origin: "bundled", document: { sha256: newer.sha256 } });
  });

  describe("AVE_MODEL_CATALOG", () => {
    it("bundled pins the bundled snapshot over a newer cached copy", async () => {
      await seedGoodCopy();
      expect(await selectBootModelCatalog({ env: { AVE_MODEL_CATALOG: "bundled" }, dir, loadBundled })).toMatchObject({ origin: "pinned", document: { sha256: BUNDLED.sha256 } });
    });

    it("a sha256 pins that cached copy", async () => {
      const sha256 = await seedGoodCopy();
      const { fetchImpl } = respondWith(() => json(rawDocument(500_000)));
      await refreshModelCatalogCache({ fetchImpl, dir, reference: BUNDLED, now: () => STALE });
      expect(await selectBootModelCatalog({ env: { AVE_MODEL_CATALOG: sha256 }, dir, loadBundled })).toMatchObject({ origin: "pinned", document: { sha256 } });
    });

    it("an absolute path pins that file", async () => {
      const file = join(dir, "pinned.json");
      const pinned = documentFrom(rawDocument(123_456), "2026-05-05T00:00:00Z");
      writeFileSync(file, JSON.stringify(pinned));
      expect(await selectBootModelCatalog({ env: { AVE_MODEL_CATALOG: file }, dir, loadBundled })).toMatchObject({ origin: "pinned", document: { sha256: pinned.sha256 } });
    });

    it.each([
      ["a sha256 with no cached copy", "f".repeat(64), /cannot be used: .*unreadable/],
      ["a file that fails verification", "__damaged__", /cannot be used: .*hashes to/],
      ["a relative path", "catalog.json", /must be bundled, the sha256 of a cached catalog, or an absolute path/],
    ])("refuses to boot on %s rather than run on another catalog", async (_label, value, reason) => {
      let pin = value;
      if (value === "__damaged__") {
        pin = join(dir, "damaged.json");
        const damaged = documentFrom(rawDocument(), "2026-05-05T00:00:00Z");
        damaged.providers.openai!.models["gpt-fixture"]!.limits.context = 1;
        writeFileSync(pin, JSON.stringify(damaged));
      }
      await expect(selectBootModelCatalog({ env: { AVE_MODEL_CATALOG: pin }, dir, loadBundled })).rejects.toThrow(reason);
    });
  });
});

describe("decideModelCatalogRefresh", () => {
  it("is on by default", () => {
    expect(decideModelCatalogRefresh({ setting: undefined, policy: null, env: {} })).toEqual({ enabled: true });
    expect(decideModelCatalogRefresh({ setting: "auto", policy: null, env: {} })).toEqual({ enabled: true });
  });

  it("is off when the user turns it off", () => {
    expect(decideModelCatalogRefresh({ setting: "off", policy: null, env: {} })).toEqual({ enabled: false, decidedBy: "setting" });
  });

  it("is off under a pin, whatever the setting says", () => {
    expect(decideModelCatalogRefresh({ setting: "auto", policy: null, env: { AVE_MODEL_CATALOG: "bundled" } })).toEqual({ enabled: false, decidedBy: "env" });
    expect(decideModelCatalogRefresh({ setting: "auto", policy: null, env: { AVE_MODEL_CATALOG: "  " } })).toEqual({ enabled: true });
  });

  it("is off under a policy that says off", () => {
    expect(decideModelCatalogRefresh({ setting: "auto", policy: "off", env: {} })).toEqual({ enabled: false, decidedBy: "policy" });
  });
});

describe("readModelCatalogRefreshPolicy", () => {
  const policy = (text: string): string => {
    const path = join(dir, "policy.json");
    writeFileSync(path, text);
    return path;
  };

  it("leaves the decision to the user when the file or the section is absent", async () => {
    expect(await readModelCatalogRefreshPolicy(join(dir, "absent.json"))).toBeNull();
    expect(await readModelCatalogRefreshPolicy(policy(JSON.stringify({ marketplaces: {} })))).toBeNull();
  });

  it("reads { refresh: off } as off", async () => {
    expect(await readModelCatalogRefreshPolicy(policy(JSON.stringify({ modelCatalog: { refresh: "off" } })))).toBe("off");
  });

  it.each([
    ["bad JSON", "{"],
    ["a duplicated key", "{\"modelCatalog\": {\"refresh\": \"off\"}, \"modelCatalog\": {}}"],
    ["an unknown value", JSON.stringify({ modelCatalog: { refresh: "sometimes" } })],
    ["an unknown key", JSON.stringify({ modelCatalog: { refresh: "off", extra: 1 } })],
  ])("fails closed on %s", async (_label, text) => {
    expect(await readModelCatalogRefreshPolicy(policy(text))).toBe("off");
  });
});
