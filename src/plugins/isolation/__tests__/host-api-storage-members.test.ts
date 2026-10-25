/** Exercise storage marshalling against real dispatch and host-only storage; bytes are encoded and resolve stays child-local. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a recognizable ciphertext envelope to detect plaintext persistence.
const mockedElectron = vi.hoisted(() => {
  const enc = { available: true };
  return {
    enc,
    safeStorage: {
      getSelectedStorageBackend: () => "gnome_libsecret" as const,
      isEncryptionAvailable: vi.fn(() => enc.available),
      encryptString: vi.fn((s: string) => Buffer.from(`ENC(${s})`, "utf-8")),
      decryptString: vi.fn((b: Buffer) => {
        const raw = Buffer.from(b).toString("utf-8");
        const match = /^ENC\(([\s\S]*)\)$/.exec(raw);
        if (!match) throw new Error("decryptString: not ciphertext from this seam");
        return match[1];
      }),
    },
  };
});
vi.mock("electron", () => ({ safeStorage: mockedElectron.safeStorage }));

import { EffectBoundaryDeniedError } from "../../../permissions/effect-enforcement.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { PluginStorageError } from "../../public-contract.js";
import { createNoopHostApi } from "../../runtime/sandbox.js";
import type { PluginHostApi, PluginStorage } from "../../types.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  createStorageHostApiPaths,
  type HostApiPathHandler,
} from "../host-api-dispatcher.js";
import {
  createStorageChildMembers,
  type ChildHostApiMember,
} from "../host-api-child.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  PluginHostApiError,
  STORAGE_HOSTAPI_PATHS,
  WIRE_BYTES_MAX,
  type ChildNotificationSink,
  type DispatchedStorageHostApiPath,
  type HostApiPath,
  type HostApiRequest,
  type WireBytes,
} from "../host-api-wire.js";
import {
  argsOfRequest,
  directHostApiChannel,
  hostApiRequest,
  settleHostApiReply,
} from "../../../__tests__/support/host-protocol-wire.js";
import {
  createChildHostApiStub,
  createHostApiCaller,
  unimplementedChildMember,
} from "../plugin-child-runtime.js";
import { pluginDataDirIn } from "../../__tests__/test-helpers.js";

const PLUGIN_ID = "com.example.storage";
const silentSink: ChildNotificationSink = { deliver: () => {} };

/** Round-trip invalid UTF-8 sequences as bytes so successful calls cannot silently change content. */
const HOSTILE_BYTES = new Uint8Array([
  0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x41, 0x00, 0xed, 0xa0, 0x80, 0x7f,
]);

interface Harness {
  readonly storage: PluginStorage;
  readonly dataDir: string;
  readonly requests: HostApiRequest[];
  readonly raw: (path: string, args: readonly unknown[]) => Promise<unknown>;
}

let scratch: string;
let dataDir: string;
let storageDir: string;

beforeEach(() => {
  mockedElectron.enc.available = true;
  scratch = mkdtempSync(join(tmpdir(), "ave-storage-boundary-"));
  // The runtime passes data/ while storage operates in its host-only sibling storage/.
  dataDir = join(scratch, PLUGIN_ID, "data");
  storageDir = join(scratch, PLUGIN_ID, "storage");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
});

afterEach(async () => {
  await cleanupTmpDir(scratch);
});

/** Bind handlers to the actual incarnation storage; unbound-table cases must fail. */
function harness(
  hostApi: PluginHostApi = createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage),
  options: { readonly bind?: boolean } = {},
): Harness {
  const requests: HostApiRequest[] = [];
  const hostLogs: { message: string; meta?: unknown }[] = [];
  const host = new HostApiDispatcher({
    // Capture host diagnostics so silently discarded failures cannot pass.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    isActive: () => true,
    notifications: silentSink,
    reportUnknownField: () => {},
    shutdownChild: async (subscriptionId) => {
      throw new Error(`no child to run shutdown handler '${subscriptionId}'`);
    },
    table:
      options.bind === false
        ? HOSTAPI_DISPATCH_TABLE
        : { ...HOSTAPI_DISPATCH_TABLE, ...createStorageHostApiPaths(hostApi) },
  });
  const channel = directHostApiChannel(host, { requests });
  const context = { pluginId: PLUGIN_ID };
  // Compose defaults exactly as the child runtime does so unwired paths fail at runtime.
  const members: Partial<Record<HostApiPath, ChildHostApiMember>> = {
    ...createStorageChildMembers(createHostApiCaller(channel, context), {
      pluginId: PLUGIN_ID,
      pluginDataDir: dataDir,
    }),
  };
  const stub = createChildHostApiStub(
    PLUGIN_ID,
    (path) => members[path] ?? unimplementedChildMember(PLUGIN_ID, path),
  );
  return {
    storage: stub.storage,
    dataDir,
    requests,
    raw: async (path, args) => settleHostApiReply(await host.handle(hostApiRequest(path, args))),
  };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof PluginHostApiError) return error.code;
    return `not a wire error: ${String(error)}`;
  }
  return "resolved";
}

const TRAVERSAL_CALLS: ReadonlyArray<readonly [string, (s: PluginStorage) => Promise<unknown>]> = [
  ["storage.read", (s) => s.read("../escape.bin")],
  ["storage.readText", (s) => s.readText("../escape.txt")],
  ["storage.readJson", (s) => s.readJson("../escape.json")],
  ["storage.list", (s) => s.list("../")],
  ["storage.exists", (s) => s.exists("../escape.txt")],
  ["storage.write", (s) => s.write("../escape.txt", "x")],
  ["storage.writeJson", (s) => s.writeJson("../escape.json", { a: 1 })],
  ["storage.rm", (s) => s.rm("../escape.txt")],
  ["storage.mkdir", (s) => s.mkdir("../escape")],
  ["storage.writeEncrypted", (s) => s.writeEncrypted("../escape.enc", "x")],
  ["storage.readEncrypted", (s) => s.readEncrypted("../escape.enc")],
];

describe("storage.resolve is answered in the child", () => {
  it("joins under the host storage root without a round trip", () => {
    const { storage, requests } = harness();
    expect(storage.resolve("nested", "file.txt")).toBe(join(storageDir, "nested/file.txt"));
    expect(storage.resolve()).toBe(storageDir);
    expect(requests).toHaveLength(0);
  });

  it("refuses an escape with the same class the host raises", () => {
    const { storage } = harness();
    expect(() => storage.resolve("..", "evil.txt")).toThrow(PluginStorageError);
    expect(() => storage.resolve("/etc/passwd")).toThrow(/absolute paths are not allowed/);
    // Refuse nonstrings with plugin diagnostics before path.join can throw a bare TypeError.
    expect(() => (storage.resolve as (...a: unknown[]) => string)(7)).toThrow(
      PluginStorageError,
    );
  });

  it("refuses the same call if a child sends it anyway", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.resolve", ["a"]))).toBe("path-not-dispatchable");
  });
});

describe("bytes survive the boundary unchanged", () => {
  it("round-trips content a text codec would corrupt", async () => {
    const { storage, requests } = harness();
    await storage.write("blob.bin", HOSTILE_BYTES);
    const read = await storage.read("blob.bin");
    expect(Array.from(read)).toEqual(Array.from(HOSTILE_BYTES));
    expect(Array.from(readFileSync(join(storageDir, "blob.bin")))).toEqual(
      Array.from(HOSTILE_BYTES),
    );
    // Assert the binary tag survives in both directions.
    expect((argsOfRequest(requests[0])[1] as WireBytes).encoding).toBe("base64");
  });

  it("keeps a base64-looking STRING verbatim, which the tag is what stops", async () => {
    const { storage, requests } = harness();
    await storage.write("verbatim.txt", "aGVsbG8=");
    expect((argsOfRequest(requests[0])[1] as WireBytes).encoding).toBe("utf8");
    expect(readFileSync(join(storageDir, "verbatim.txt"), "utf-8")).toBe("aGVsbG8=");
  });

  it("still honours the separate StorageEncoding argument", async () => {
    const { storage } = harness();
    // Wire text tagging and write-time base64 interpretation are independent.
    await storage.write("decoded.bin", "aGVsbG8=", "base64");
    expect(readFileSync(join(storageDir, "decoded.bin"), "utf-8")).toBe("hello");
    expect(await storage.readText("decoded.bin", "base64")).toBe("aGVsbG8=");
  });

  it("returns bytes, not the `{type:'Buffer'}` a naive round trip produces", async () => {
    const { storage } = harness();
    await storage.write("blob.bin", HOSTILE_BYTES);
    const read = await storage.read("blob.bin");
    expect(read).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(JSON.stringify(read))).not.toHaveProperty("type", "Buffer");
  });

  it("refuses a payload over the boundary limit instead of truncating it", async () => {
    const { storage, requests } = harness();
    await expect(
      storage.write("huge.bin", new Uint8Array(WIRE_BYTES_MAX + 1)),
    ).rejects.toMatchObject({ code: "payload-too-large" });
    expect(requests).toHaveLength(0);
    expect(existsSync(join(storageDir, "huge.bin"))).toBe(false);
  });

  it("refuses an over-limit READ rather than handing back part of the file", async () => {
    const base = createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage);
    const oversized: PluginHostApi = {
      ...base,
      storage: {
        ...base.storage,
        read: async () => new Uint8Array(WIRE_BYTES_MAX + 1),
      },
    };
    const { storage } = harness(oversized);
    expect(await codeOf(storage.read("big.bin"))).toBe("payload-too-large");
  });
});

describe("the plain-json members carry their declared values", () => {
  it("reads text with and without an explicit encoding", async () => {
    const { storage } = harness();
    await storage.write("note.txt", "안녕하세요");
    // Omitted encoding stays absent; undefined array elements are invalid JSON payloads.
    expect(await storage.readText("note.txt")).toBe("안녕하세요");
    expect(await storage.readText("note.txt", "utf-8")).toBe("안녕하세요");
    expect(await storage.readText("note.txt", "hex")).toBe(
      Buffer.from("안녕하세요", "utf-8").toString("hex"),
    );
  });

  it("round-trips JSON and answers null for a missing file", async () => {
    const { storage } = harness();
    await storage.writeJson("state.json", { nested: { list: [1, null, "x"] } });
    expect(await storage.readJson("state.json")).toEqual({
      nested: { list: [1, null, "x"] },
    });
    expect(await storage.readJson("missing.json")).toBeNull();
  });

  it("passes the indent argument through", async () => {
    const { storage } = harness();
    await storage.writeJson("wide.json", { a: 1 }, 4);
    expect(readFileSync(join(storageDir, "wide.json"), "utf-8")).toBe('{\n    "a": 1\n}');
    await storage.writeJson("narrow.json", { a: 1 });
    expect(readFileSync(join(storageDir, "narrow.json"), "utf-8")).toBe('{\n  "a": 1\n}');
  });

  it("lists the root and a subdirectory, and empty for a missing one", async () => {
    const { storage } = harness();
    await storage.mkdir("nested");
    await storage.write("nested/a.txt", "a");
    await storage.write("nested/b.txt", "b");
    expect((await storage.list()).sort()).toEqual(["nested"]);
    expect((await storage.list("nested")).sort()).toEqual(["a.txt", "b.txt"]);
    expect(await storage.list("absent")).toEqual([]);
  });

  it("reports existence and removes files and trees", async () => {
    const { storage } = harness();
    expect(await storage.exists("gone.txt")).toBe(false);
    await storage.write("gone.txt", "x");
    expect(await storage.exists("gone.txt")).toBe(true);
    await storage.rm("gone.txt");
    expect(await storage.exists("gone.txt")).toBe(false);

    await storage.mkdir("tree/inner");
    await storage.write("tree/inner/deep.txt", "x");
    await storage.rm("tree", { recursive: true });
    expect(await storage.exists("tree")).toBe(false);
  });

  it("creates a directory recursively", async () => {
    const { storage } = harness();
    await storage.mkdir("a/b/c");
    expect(await storage.exists("a/b/c")).toBe(true);
  });
});

describe("the encrypted pair fails for its own reasons", () => {
  it("round-trips a secret and never writes the plaintext", async () => {
    const { storage } = harness();
    await storage.writeEncrypted("auth/token.enc", "s3cret");
    // Persist the encryption result and round-trip it intact.
    expect(readFileSync(join(storageDir, "auth/token.enc"), "utf-8")).toBe("ENC(s3cret)");
    expect(mockedElectron.safeStorage.encryptString).toHaveBeenCalledWith("s3cret");
    expect(await storage.readEncrypted("auth/token.enc")).toBe("s3cret");
  });

  it("reports an absent key with its own code, and writes nothing", async () => {
    const { storage } = harness();
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.writeEncrypted("nokey.enc", "s3cret"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
    expect(existsSync(join(storageDir, "nokey.enc"))).toBe(false);
    expect(await codeOf(storage.readEncrypted("nokey.enc"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
  });

  it("distinguishes a missing key from a missing file", async () => {
    const { storage } = harness();
    // A missing encrypted file differs from unavailable encryption; do not suggest reprovisioning an existing key.
    expect(await codeOf(storage.readEncrypted("absent.enc"))).toBe("host-internal");
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.readEncrypted("absent.enc"))).toBe(
      "plugin-storage-encryption-unavailable",
    );
  });

  it("lets a path refusal win over the encryption check", async () => {
    const { storage } = harness();
    mockedElectron.enc.available = false;
    expect(await codeOf(storage.writeEncrypted("../out.enc", "x"))).toBe("plugin-storage");
  });
});

describe("every member reports the errors its contract lists", () => {
  it.each(TRAVERSAL_CALLS)("%s refuses an escape as plugin-storage", async (path, run) => {
    expect(HOSTAPI_PATH_CONTRACTS[path as "storage.read"].errors).toContain(
      "plugin-storage",
    );
    const { storage } = harness();
    expect(await codeOf(run(storage))).toBe("plugin-storage");
  });

  it("keeps the host error's own name and detail across the wire", async () => {
    const { storage } = harness();
    await storage.read("../escape.bin").catch((error: unknown) => {
      expect(error).toBeInstanceOf(PluginHostApiError);
      expect((error as PluginHostApiError).name).toBe("PluginStorageError");
      expect((error as PluginHostApiError).detail).toMatchObject({
        pluginId: PLUGIN_ID,
        attemptedPath: "../escape.bin",
      });
    });
    expect.assertions(3);
  });

  it("carries a denied mutation as effect-boundary-denied", async () => {
    const base = createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage);
    const denied: PluginHostApi = {
      ...base,
      storage: {
        ...base.storage,
        write: async () => {
          throw new EffectBoundaryDeniedError(
            PLUGIN_ID,
            "storage.write",
            "denied.txt",
            "denied",
          );
        },
      },
    };
    const { storage } = harness(denied);
    expect(HOSTAPI_PATH_CONTRACTS["storage.write"].errors).toContain(
      "effect-boundary-denied",
    );
    expect(await codeOf(storage.write("denied.txt", "x"))).toBe("effect-boundary-denied");
  });
});

describe("the group binds to one incarnation and to nothing else", () => {
  const dispatched = STORAGE_HOSTAPI_PATHS.filter(
    (path): path is DispatchedStorageHostApiPath => path !== "storage.resolve",
  );

  it("declares a handler for every dispatchable member of the group", () => {
    const handlers: Record<DispatchedStorageHostApiPath, HostApiPathHandler> =
      createStorageHostApiPaths(createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage));
    expect(Object.keys(handlers).sort()).toEqual([...dispatched].sort());
    for (const path of dispatched) {
      expect(handlers[path].path).toBe(path);
      expect(handlers[path].status).toBe("implemented");
      expect(handlers[path].contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
    }
  });

  it("leaves the shipped table unbound, so nothing is implemented by accident", async () => {
    // Static storage handlers have no owning plugin and must remain unbound.
    const { raw } = harness(undefined, { bind: false });
    for (const path of dispatched) {
      expect(await codeOf(raw(path, ["a.txt"])), path).toBe("path-not-implemented");
    }
  });

  it("services each call against the hostApi its own binding closed over", async () => {
    const first = mkdtempSync(join(tmpdir(), "ave-storage-first-"));
    const second = mkdtempSync(join(tmpdir(), "ave-storage-second-"));
    try {
      const toFirst = harness(createNoopHostApi(PLUGIN_ID, pluginDataDirIn(first), mockedElectron.safeStorage));
      const toSecond = harness(createNoopHostApi(PLUGIN_ID, pluginDataDirIn(second), mockedElectron.safeStorage));
      await toFirst.storage.write("who.txt", "first");
      await toSecond.storage.write("who.txt", "second");
      expect(readFileSync(join(first, "storage", "who.txt"), "utf-8")).toBe("first");
      expect(readFileSync(join(second, "storage", "who.txt"), "utf-8")).toBe("second");
    } finally {
      await Promise.all([cleanupTmpDir(first), cleanupTmpDir(second)]);
    }
  });

  it("keeps the void-drift check reachable by returning the host's promise", async () => {
    const base = createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage);
    const drifting: PluginHostApi = {
      ...base,
      // Return host results so the dispatcher can detect void-contract drift.
      storage: { ...base.storage, mkdir: (async () => "created") as unknown as PluginStorage["mkdir"] },
    };
    const { storage } = harness(drifting);
    expect(await codeOf(storage.mkdir("nested"))).toBe("result-marshalling-rejected");
  });

  it("refuses to build a relaying stub for a member whose contract moved", () => {
    // Change the contract to prove the guard fires, then restore it before assertions can leak state.
    const contracts = HOSTAPI_PATH_CONTRACTS as unknown as Record<
      string,
      { arguments: string; result: string; lifetime: string }
    >;
    const original = contracts["storage.list"];
    contracts["storage.list"] = { ...original, arguments: "encoded" };
    let thrown: unknown;
    try {
      createStorageChildMembers(async () => undefined, {
        pluginId: PLUGIN_ID,
        pluginDataDir: dataDir,
      });
    } catch (error) {
      thrown = error;
    } finally {
      contracts["storage.list"] = original;
    }
    expect(String(thrown)).toMatch(/'storage.list' no longer crosses as plain JSON/);
  });

  it("carries no lifetime, so there is no disposer to own", () => {
    // Storage calls have no lifetime beyond their reply.
    for (const path of STORAGE_HOSTAPI_PATHS) {
      expect(HOSTAPI_PATH_CONTRACTS[path].lifetime, path).toBe("none");
    }
  });

  it("refuses a member of the group the binding does not cover", () => {
    const handlers = createStorageHostApiPaths(createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage));
    // storage.resolve stays child-local; host binding would duplicate path derivation.
    expect(Object.keys(handlers)).not.toContain("storage.resolve");
  });
});

describe("malformed arguments are refused, never coerced", () => {
  it("refuses a non-string path", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.read", [7]))).toBe("argument-marshalling-rejected");
    expect(await codeOf(raw("storage.exists", [null]))).toBe(
      "argument-marshalling-rejected",
    );
  });

  it("refuses an encoding outside the declared union", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.readText", ["a.txt", "rot13"]))).toBe(
      "argument-marshalling-rejected",
    );
    // Inherited prototype keys are not supported encodings.
    expect(await codeOf(raw("storage.readText", ["a.txt", "toString"]))).toBe(
      "argument-marshalling-rejected",
    );
  });

  it("refuses an untagged write payload", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.write", ["a.txt", "raw string"]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.write", ["a.txt", { encoding: "rot13", data: "x" }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(existsSync(join(storageDir, "a.txt"))).toBe(false);
  });

  it("refuses an absent writeJson value rather than writing `undefined`", async () => {
    const { raw } = harness();
    expect(await codeOf(raw("storage.writeJson", ["j.json"]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.writeJson", ["j.json", { a: 1 }, 1.5]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(existsSync(join(storageDir, "j.json"))).toBe(false);
  });

  it("refuses an rm option it does not recognise", async () => {
    const { storage, raw } = harness();
    await storage.mkdir("keep/inner");
    expect(await codeOf(raw("storage.rm", ["keep", { recursive: "yes" }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await codeOf(raw("storage.rm", ["keep", { force: true }]))).toBe(
      "argument-marshalling-rejected",
    );
    expect(await storage.exists("keep/inner")).toBe(true);
  });

  it("refuses a write payload that is neither text nor bytes, before sending it", async () => {
    const { storage, requests } = harness();
    await expect(
      (storage.write as (...a: unknown[]) => Promise<void>)("a.txt", { not: "bytes" }),
    ).rejects.toMatchObject({ code: "argument-marshalling-rejected" });
    expect(requests).toHaveLength(0);
  });
});

describe("the boundary refuses a member the plugin is no longer entitled to", () => {
  it("stops a storage call from a retired incarnation", async () => {
    const hostApi = createNoopHostApi(PLUGIN_ID, dataDir, mockedElectron.safeStorage);
    const hostLogs: { message: string; meta?: unknown }[] = [];
    const host = new HostApiDispatcher({
      // Capture host diagnostics so silently discarded failures cannot pass.
      log: (message, meta) => hostLogs.push({ message, meta }),
      pluginId: PLUGIN_ID,
      isActive: () => false,
      notifications: silentSink,
      reportUnknownField: () => {},
      shutdownChild: async (subscriptionId) => {
        throw new Error(`no child to run shutdown handler '${subscriptionId}'`);
      },
      table: { ...HOSTAPI_DISPATCH_TABLE, ...createStorageHostApiPaths(hostApi) },
    });
    writeFileSync(join(storageDir, "live.txt"), "live");
    const reply = await host.handle(hostApiRequest("storage.read", ["live.txt"], "c1"));
    expect("error" in reply && reply.error.data.code).toBe("plugin-inactive");
  });
});
