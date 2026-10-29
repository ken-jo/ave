/** Contract and effect tables must enumerate the same HostApi surface; mismatches must fail closed. */
import { describe, expect, it, vi } from "vitest";
import {
  ENFORCEMENT_EXCLUSIONS,
  EffectBoundaryDeniedError,
  GATED_EFFECT_PATHS,
  pathReadEffectPaths,
} from "../../../permissions/effect-enforcement.js";
import { HOSTAPI_EFFECT_BY_PATH } from "../../../permissions/effect-kind.js";
import { ManifestIntegrityError } from "../../../permissions/manifest-integrity.js";
import { PluginRuntimeDetachedOperationError } from "../../runtime/detached-operation.js";
import {
  PluginStorageEncryptionUnavailableError,
  PluginStorageError,
} from "../../public-contract.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  isHostApiPath,
  type HostApiPath,
} from "../host-api-wire.js";
import {
  HOSTAPI_DISPATCH_TABLE,
  HostApiDispatcher,
  UNKNOWN_FIELD_REPORTS_MAX,
  childLocalHostApiPath,
  classifyHostApiError,
  defineHostApiPath,
  unimplementedHostApiPath,
  type HostApiCall,
  type HostApiPathStatus,
  type UnknownFieldReport,
  type SubscriptionScope,
} from "../host-api-dispatcher.js";
import { DISPATCH_SUBSCRIPTION_KIND_MAX, type HostApiBudgetAudit } from "../host-api-budgets.js";
import {
  HostApiBoundaryError,
  UNIVERSAL_WIRE_ERROR_CODES,
  WIRE_BYTES_MAX,
  decodeWireBinary,
  decodeWireBytes,
  encodeWireBytes,
  fromHostApiRpcError,
  hostApiPathOf,
  inactiveHostApiMessage,
  reconstructWireError,
  type ArgumentMarshalling,
  type ChildNotificationSink,
  type DisposerLifetime,
  type HostApiRequest,
  type ResultMarshalling,
} from "../host-api-wire.js";
import { allPluginsAreOutOfProcess } from "../out-of-process-plugins.js";
import {
  isProductionSourceModule,
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  SOURCE_ROOT,
  sourceDisplayPath,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "../../__tests__/test-helpers.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildRuntimeImportGraph } from "../../../../scripts/check-import-cycles.mjs";
import { hostApiRequest } from "../../../__tests__/support/host-protocol-wire.js";

const PLUGIN_ID = "com.example.contract";

const silentSink: ChildNotificationSink = { deliver: () => {} };

/** The connection binds plugin identity; requests must never choose it. */
function request(
  overrides: {
    readonly path?: string;
    readonly args?: readonly unknown[];
    readonly params?: Record<string, unknown>;
  } = {},
): HostApiRequest {
  const base = hostApiRequest(
    overrides.path ?? "hasRoutineBySource",
    overrides.args ?? ["nightly"],
    "c1",
  );
  return overrides.params ? { ...base, params: overrides.params } : base;
}

function dispatcher(
  options: Partial<ConstructorParameters<typeof HostApiDispatcher>[0]> = {},
): HostApiDispatcher {
  const hostLogs: { message: string; meta?: unknown }[] = [];
  return new HostApiDispatcher({
    // Capture host diagnostics so silently discarded failures cannot pass.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    isActive: () => true,
    notifications: silentSink,
    reportUnknownField: () => {},
    shutdownChild: async (subscriptionId) => {
      throw new Error(`no child to run shutdown handler '${subscriptionId}'`);
    },
    ...options,
  });
}

describe("the marshalling contract covers exactly the classified hostApi surface", () => {
  it("declares one contract per effect-SOT member, and no others", () => {
    expect(Object.keys(HOSTAPI_PATH_CONTRACTS).sort()).toEqual(
      Object.keys(HOSTAPI_EFFECT_BY_PATH).sort(),
    );
  });

  it("counts the surface from the SOT rather than from the design prose", () => {
    // Derive the surface count from the authoritative table so new members cannot escape coverage.
    expect(Object.keys(HOSTAPI_PATH_CONTRACTS)).toHaveLength(
      Object.keys(HOSTAPI_EFFECT_BY_PATH).length,
    );
  });

  it("gives every member a dispatch-table entry keyed to its own contract", () => {
    for (const path of Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]) {
      const handler = HOSTAPI_DISPATCH_TABLE[path];
      expect(handler, `no dispatch entry for '${path}'`).toBeDefined();
      expect(handler.path).toBe(path);
      expect(handler.contract).toBe(HOSTAPI_PATH_CONTRACTS[path]);
    }
    expect(Object.keys(HOSTAPI_DISPATCH_TABLE).sort()).toEqual(
      Object.keys(HOSTAPI_PATH_CONTRACTS).sort(),
    );
  });

  it("answers all four axes for every member", () => {
    for (const [path, contract] of Object.entries(HOSTAPI_PATH_CONTRACTS)) {
      expect(contract.arguments, path).toBeTruthy();
      expect(contract.result, path).toBeTruthy();
      expect(contract.lifetime, path).toBeTruthy();
      expect(Array.isArray(contract.errors), path).toBe(true);
    }
  });

  it("uses every value each axis's vocabulary offers", () => {
    // Every declared vocabulary value must be used and remain inside its type union.
    const argumentValues: ArgumentMarshalling[] = [
      "plain-json",
      "encoded",
      "handler-registration",
      "child-local",
    ];
    const resultValues: ResultMarshalling[] = [
      "plain-json",
      "void",
      "encoded",
      "handle",
      "handle-or-denied",
      "child-local",
    ];
    const lifetimeValues: DisposerLifetime[] = [
      "none",
      "child-disposable",
      "host-terminated",
    ];
    const contracts = Object.values(HOSTAPI_PATH_CONTRACTS);
    expect([...new Set(contracts.map((c) => c.arguments))].sort()).toEqual(
      [...argumentValues].sort(),
    );
    expect([...new Set(contracts.map((c) => c.result))].sort()).toEqual(
      [...resultValues].sort(),
    );
    expect([...new Set(contracts.map((c) => c.lifetime))].sort()).toEqual(
      [...lifetimeValues].sort(),
    );
  });

  it("starts with every dispatchable member unimplemented", () => {
    // Track default-table implementation count so adding handlers is visible.
    const byStatus = new Map<HostApiPathStatus, string[]>();
    for (const handler of Object.values(HOSTAPI_DISPATCH_TABLE)) {
      byStatus.set(handler.status, [
        ...(byStatus.get(handler.status) ?? []),
        handler.path,
      ]);
    }
    expect(byStatus.get("implemented")).toBeUndefined();
    expect(byStatus.get("child-local")).toHaveLength(4);
    expect(byStatus.get("unimplemented")).toHaveLength(
      Object.keys(HOSTAPI_PATH_CONTRACTS).length - 4,
    );
  });

  it("builds the same handler shape however an entry is declared", () => {
    const unimplemented = unimplementedHostApiPath("getSecret");
    const childLocal = childLocalHostApiPath("config.get");
    const implemented = defineHostApiPath("getSecret", async () => "k");
    for (const handler of [unimplemented, childLocal, implemented]) {
      expect(Object.keys(handler).sort()).toEqual([
        "contract",
        "invoke",
        "path",
        "status",
      ]);
    }
    expect(unimplemented.status).toBe("unimplemented");
    expect(childLocal.status).toBe("child-local");
    expect(implemented.status).toBe("implemented");
  });

  it("hands a handler the member, its positional arguments and the request's own signal", async () => {
    let seen: HostApiCall | undefined;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", async (call) => {
        seen = call;
        return true;
      }),
    };
    await dispatcher({ table }).handle(request());
    expect(Object.keys(seen ?? {}).sort()).toEqual(["args", "path", "signal"]);
    expect(seen?.path).toBe("hasRoutineBySource");
    expect(seen?.args).toEqual(["nightly"]);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.signal.aborted).toBe(false);
  });

  it("marks a member child-local in the table exactly when its contract says so", () => {
    const contractSaysLocal = Object.entries(HOSTAPI_PATH_CONTRACTS)
      .filter(([, contract]) => contract.result === "child-local")
      .map(([path]) => path)
      .sort();
    const tableSaysLocal = Object.values(HOSTAPI_DISPATCH_TABLE)
      .filter((handler) => handler.status === "child-local")
      .map((handler) => handler.path)
      .sort();
    expect(tableSaysLocal).toEqual(contractSaysLocal);
    // These synchronous members must remain round-trip-free.
    expect(contractSaysLocal).toEqual([
      "config.get",
      "getAppPreference",
      "getInstalledPluginIds",
      "storage.resolve",
    ]);
  });

  it("declares effect-boundary denial exactly where the gate can actually fire", () => {
    // Derive all write and path-read boundaries from actual enforcement.
    const canDeny = new Set<string>([...GATED_EFFECT_PATHS, ...pathReadEffectPaths]);
    // hostFetch gates its captured verb inline; wrapper exclusion grants no bypass.
    expect(ENFORCEMENT_EXCLUSIONS.has("hostFetch")).toBe(true);
    canDeny.add("hostFetch");

    const declared = Object.entries(HOSTAPI_PATH_CONTRACTS)
      .filter(([, contract]) =>
        (contract.errors as readonly string[]).includes("effect-boundary-denied"),
      )
      .map(([path]) => path)
      .sort();
    expect(declared).toEqual([...canDeny].sort());
  });

  it("never re-declares an error the boundary itself always produces", () => {
    for (const [path, contract] of Object.entries(HOSTAPI_PATH_CONTRACTS)) {
      for (const code of contract.errors) {
        expect(
          UNIVERSAL_WIRE_ERROR_CODES,
          `'${path}' lists '${code}', which every path can already reply with`,
        ).not.toContain(code);
      }
    }
  });

  it("recognises a wire path and refuses anything else", () => {
    expect(isHostApiPath("getSecret")).toBe(true);
    expect(isHostApiPath("callTool")).toBe(false);
    expect(isHostApiPath(42)).toBe(false);
    // Only own table keys are HostApi paths; attacker-controlled prototype names must be refused.
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(isHostApiPath(inherited), inherited).toBe(false);
    }
  });
});

describe("the in-process loader's removal predicate is fed from the registry", () => {
  // Read execution arms recorded by loaded generations, never a plugin-ID census.
  it("is true over a runtime whose loaded plugins are children, and false once an in-process one is registered", async () => {
    const fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-removal-predicate-" });
    const pluginId = "removalpredicatefixture";
    const written = await writeTestPlugin(fixture, {
      id: pluginId,
      tools: ["predicate_ping"],
      entrySource: makeTestPluginEntrySource({ predicate_ping: JSON.stringify("pong") }),
    });
    await writeTestPluginRegistry(fixture, [{ id: pluginId, manifestPath: written.manifestPath }]);
    const runtime = makeTestPluginRuntime(fixture);
    try {
      await runtime.startAll();
      await expect(runtime.call("predicate_ping")).resolves.toBe("pong");
      const loaded = runtime.listLoadedPluginArms();
      expect(loaded).toEqual([{ pluginId, arm: "child" }]);
      expect(allPluginsAreOutOfProcess(loaded)).toBe(true);
      // Repair diagnostics must expose the actual arm and confinement reported by spawn.
      expect(runtime.listPluginCards().find((card) => card.id === pluginId)).toMatchObject({
        loadStatus: "loaded",
        arm: "child",
        confinement: "unconfined",
      });
      // An in-process generation must report false through the same registry-based predicate.
      runtime._testInjectPlugin("inprocessregistryfixture", "inprocess_ping", async () => "in-process");
      const mixed = runtime.listLoadedPluginArms();
      expect(mixed).toContainEqual({ pluginId: "inprocessregistryfixture", arm: "in-process" });
      expect(allPluginsAreOutOfProcess(mixed)).toBe(false);
    } finally {
      await runtime.stopAll();
      rmSync(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it("is false with nothing loaded, which is no evidence either way", () => {
    expect(allPluginsAreOutOfProcess([])).toBe(false);
    expect(allPluginsAreOutOfProcess([{ pluginId: "a", arm: "child" }, { pluginId: "b", arm: "in-process" }])).toBe(false);
    expect(allPluginsAreOutOfProcess([{ pluginId: "a", arm: "child" }, { pluginId: "b", arm: "child" }])).toBe(true);
  });
});

/** Only the child may import plugin entry code; static, namespace and dynamic imports all count. */
const SRC = SOURCE_ROOT;
const PLUGIN_LOADER = join(SRC, "plugins", "runtime", "plugin-loader.ts");
const PLUGIN_CHILD_MAIN = join(SRC, "plugins", "isolation", "plugin-child-main.ts");
const importGraph = buildRuntimeImportGraph(SRC);

const display = sourceDisplayPath;
const isProductionModule = isProductionSourceModule;

function namesPluginLoader(from: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const base = resolve(dirname(from), specifier);
  return [base.replace(/\.js$/u, ".ts"), `${base}.ts`, base].includes(PLUGIN_LOADER);
}

const STATIC_IMPORT = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;

/** Namespace imports, export-all and dynamic imports reach every exported loader binding. */
function bindingsFromPluginLoader(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const names: string[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (!namesPluginLoader(file, match[4]!)) continue;
    const clause = match[3]!.trim();
    if (clause.includes("*")) names.push("*");
    const named = /\{([\s\S]*)\}/u.exec(clause)?.[1] ?? "";
    for (const element of named.split(",")) {
      const exported = element.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!.trim();
      if (exported) names.push(exported);
    }
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    if (namesPluginLoader(file, match[1]!)) names.push("*");
  }
  return names;
}

function pluginLoaderImporters(): string[] {
  return [...importGraph.keys()].filter((file) => file !== PLUGIN_LOADER
    && (importGraph.get(file)!.has(PLUGIN_LOADER)
      || [...readFileSync(file, "utf-8").matchAll(DYNAMIC_IMPORT)].some((match) => namesPluginLoader(file, match[1]!))));
}

function importersOf(binding: string, filter: (file: string) => boolean): string[] {
  return pluginLoaderImporters()
    .filter(filter)
    .filter((file) => bindingsFromPluginLoader(file).some((name) => name === binding || name === "*"))
    .map(display)
    .sort();
}

describe("main imports no plugin code", () => {
  it("imports importPluginFactory only in the plugin child", () => {
    // Inspect production and test importers so plugin entry import remains exclusive to the child.
    expect(importersOf("importPluginFactory", () => true)).toEqual(["plugins/isolation/plugin-child-main.ts"]);
    expect(existsSync(PLUGIN_CHILD_MAIN)).toBe(true);
  });

  it("gives the retained in-process factory no production importer", () => {
    expect(importersOf("importInProcessPluginFactory", isProductionModule)).toEqual([]);
    expect(importersOf("runPluginImportWithTimeout", isProductionModule)).toEqual([]);
  });

  it("sees the imports that do exist, so a green run is not an empty walk", () => {
    // Positive graph controls prevent vacuous importer assertions.
    expect(bindingsFromPluginLoader(PLUGIN_CHILD_MAIN)).toContain("importPluginFactory");
    const runtimeIndex = join(SRC, "plugins", "runtime", "index.ts");
    expect(pluginLoaderImporters()).toContain(runtimeIndex);
    expect(bindingsFromPluginLoader(runtimeIndex)).toEqual(
      expect.arrayContaining(["buildImportUrl", "buildMethodMap", "declaredAppVisibleToolMethods"]),
    );
  });
});

describe("the dispatcher refuses rather than defaults", () => {
  it("fails a member whose handler has not been written", async () => {
    const reply = await dispatcher().handle(request({ path: "getSecret" }));
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("path-not-implemented");
  });

  it("fails a member the child was supposed to answer locally", async () => {
    const reply = await dispatcher().handle(request({ path: "config.get" }));
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("path-not-dispatchable");
  });

  it("fails a member that does not exist", async () => {
    const reply = await dispatcher().handle(
      request({ path: "callTool" as HostApiPath }),
    );
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("path-unknown");
  });

  it("attributes a forged identity to the bound plugin and reports the fields as unknown", async () => {
    // The host owns connection identity; forged identity params are reported once and ignored.
    let seen: HostApiCall | undefined;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", async (call) => {
        seen = call;
        return true;
      }),
    };
    const reported: [string, string][] = [];
    const host = dispatcher({
      table,
      reportUnknownField: (report) => {
        if (report.kind === "field") reported.push([report.method, report.field]);
      },
    });
    const forged = request({
      params: { source: "nightly", pluginId: "com.example.other", generationId: "gen-0" },
    });

    const reply = await host.handle(forged);
    expect(reply).toEqual({ jsonrpc: "2.0", id: "c1", result: true });
    expect(seen?.args).toEqual(["nightly"]);
    expect(reported).toEqual([
      ["ave/host/hasRoutineBySource", "pluginId"],
      ["ave/host/hasRoutineBySource", "generationId"],
    ]);

    // Deduplicate by method and field for the connection lifetime.
    await host.handle(forged);
    expect(reported).toHaveLength(2);

    // Attribute refusals to the bound plugin, never params claiming another identity.
    const refused = await dispatcher({ isActive: () => false }).handle(forged);
    if (!("error" in refused)) throw new Error("expected a refusal");
    expect(refused.error.message).toBe(
      inactiveHostApiMessage(PLUGIN_ID, "hostApi.hasRoutineBySource"),
    );
  });

  it("caps what the child can make it report, and cuts long field names", async () => {
    // Bound dedup memory and diagnostics; both method and field are attacker-controlled.
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", async () => true),
    };
    const reports: UnknownFieldReport[] = [];
    const host = dispatcher({ table, reportUnknownField: (report) => reports.push(report) });
    const long = "f".repeat(10_000);
    await host.handle(request({ params: { source: "nightly", [long]: 1 } }));
    const fields: Record<string, unknown> = { source: "nightly" };
    for (let index = 0; index < 100; index += 1) fields[`extra${index}`] = index;
    await host.handle(request({ params: fields }));
    await host.handle(request({ params: { source: "nightly", another: true } }));

    const named = reports.filter((report) => report.kind === "field");
    expect(named).toHaveLength(UNKNOWN_FIELD_REPORTS_MAX);
    expect(named[0]).toEqual({
      kind: "field",
      method: "ave/host/hasRoutineBySource",
      field: `${"f".repeat(64)}…`,
    });
    expect(reports.filter((report) => report.kind === "suppressed")).toEqual([
      { kind: "suppressed", limit: UNKNOWN_FIELD_REPORTS_MAX },
    ]);
    expect(reports.at(-1)).toEqual({ kind: "suppressed", limit: UNKNOWN_FIELD_REPORTS_MAX });
  });

  it("cuts a long field name by code point, never through a surrogate pair", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", async () => true),
    };
    const reports: UnknownFieldReport[] = [];
    const host = dispatcher({ table, reportUnknownField: (report) => reports.push(report) });
    // Truncate by code point so a surrogate pair is never split.
    const field = `${"f".repeat(63)}\u{1F600}tail`;
    await host.handle(request({ params: { source: "nightly", [field]: 1 } }));
    expect(reports).toEqual([
      { kind: "field", method: "ave/host/hasRoutineBySource", field: `${"f".repeat(63)}\u{1F600}…` },
    ]);
  });

  it("reads an omitted params member as the empty object, and still refuses a non-object", async () => {
    // JSON-RPC permits omitted params for zero-argument calls.
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      listAudioInputDevices: defineHostApiPath("listAudioInputDevices", async () => []),
    };
    const host = dispatcher({ table });
    const { params: _omitted, ...bare } = request({ path: "listAudioInputDevices", args: [] });
    expect("params" in bare).toBe(false);
    expect(await host.handle(bare)).toEqual({ jsonrpc: "2.0", id: "c1", result: [] });
    for (const params of [null, [], "x", 1]) {
      const reply = await host.handle({ ...bare, params } as unknown as HostApiRequest);
      if (!("error" in reply)) throw new Error(`expected a refusal for ${JSON.stringify(params)}`);
      expect(reply.error.data.code).toBe("argument-marshalling-rejected");
    }
  });

  it("answers a method only in its one spelling, never a dotted alias", async () => {
    expect(hostApiPathOf("ave/host/storage/read")).toBe("storage.read");
    for (const alias of ["ave/host/storage.read", "ave/host/agentApproval.request"]) {
      expect(hostApiPathOf(alias), alias).toBeUndefined();
    }
    const reply = await dispatcher().handle({
      jsonrpc: "2.0",
      id: "c1",
      method: "ave/host/storage.read",
      params: { path: "notes.txt" },
    });
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("path-unknown");
  });

  it("reproduces the in-process inactive-incarnation message byte for byte", async () => {
    const reply = await dispatcher({ isActive: () => false }).handle(request());
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("plugin-inactive");
    expect(reply.error.message).toBe(
      `[plugin:${PLUGIN_ID}] hostApi.hasRoutineBySource: plugin instance is no longer active`,
    );
    expect(reply.error.message).toBe(
      inactiveHostApiMessage(PLUGIN_ID, "hostApi.hasRoutineBySource"),
    );
  });

  it("refuses an argument that would not survive the wire", async () => {
    const reply = await dispatcher().handle(
      request({ args: [new Date("2020-01-01")] }),
    );
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("argument-marshalling-rejected");
    expect(reply.error.message).toContain("Date");
  });

  it("refuses a RESULT that would not survive the wire", async () => {
    // Force a serialization check because an in-memory transport otherwise preserves Map by reference.
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath(
        "hasRoutineBySource",
        async () => new Map([["a", 1]]),
      ),
    };
    const reply = await dispatcher({ table }).handle(request());
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("result-marshalling-rejected");
    expect(reply.error.message).toContain("Map");
  });

  it("refuses a void-declared member that returned a value", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      logEvent: defineHostApiPath("logEvent", async () =>
        // A nonvoid host reply must expose signature drift rather than be discarded.
        "surprise" as unknown as void,
      ),
    };
    const reply = await dispatcher({ table }).handle(
      request({ path: "logEvent", args: ["info", "hi"] }),
    );
    if (!("error" in reply)) throw new Error("expected a refusal");
    expect(reply.error.data.code).toBe("result-marshalling-rejected");
  });

  it("carries a value back when the handler is wired", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath(
        "hasRoutineBySource",
        async (call) => call.args[0] === "nightly",
      ),
    };
    const reply = await dispatcher({ table }).handle(request());
    if (!("result" in reply)) throw new Error("expected a value");
    expect(reply.result).toBe(true);
  });
});

describe("error identity survives the wire by code, never by message", () => {
  it("rejects a rate-limited reply without a bounded retry delay", () => {
    for (const retryAfterMs of [undefined, -1, 5001, 0.5]) {
      const reply = {
        code: -32000, message: "Host API rate limit exceeded.",
        data: {
          code: "rate-limited", name: "HostApiBoundaryError",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      };
      expect(() => fromHostApiRpcError(reply)).toThrow(/bounded retryAfterMs/u);
    }
  });

  it("classifies each host error class the boundary carries", () => {
    const cases: Array<[unknown, string]> = [
      [
        new EffectBoundaryDeniedError(PLUGIN_ID, "storage.write", "notes", "denied"),
        "effect-boundary-denied",
      ],
      [
        new ManifestIntegrityError(PLUGIN_ID, "tool_x", "writeFileSync"),
        "manifest-integrity-violation",
      ],
      [
        new PluginRuntimeDetachedOperationError(
          new Error("ceiling fired"),
          Promise.resolve(),
        ),
        "detached-operation",
      ],
      [
        new PluginStorageEncryptionUnavailableError(PLUGIN_ID),
        "plugin-storage-encryption-unavailable",
      ],
      [new PluginStorageError("escapes the root", PLUGIN_ID, "../x"), "plugin-storage"],
      [new HostApiBoundaryError("subscription-unknown", "gone"), "subscription-unknown"],
      [new RangeError("something else entirely"), "host-internal"],
    ];
    for (const [error, code] of cases) {
      expect(classifyHostApiError(error).code, String(error)).toBe(code);
    }
  });

  it("preserves the class name the public contract tells plugins to match on", () => {
    const wire = classifyHostApiError(
      new PluginStorageError("escapes the root", PLUGIN_ID, "../x"),
    );
    const rebuilt = reconstructWireError(wire);
    expect(rebuilt.name).toBe("PluginStorageError");
    expect(rebuilt.code).toBe("plugin-storage");
    expect(rebuilt.message).toBe(
      new PluginStorageError("escapes the root", PLUGIN_ID, "../x").message,
    );
    expect(rebuilt.detail).toEqual({ pluginId: PLUGIN_ID, attemptedPath: "../x" });
  });

  it("carries the effect-gate's own fields so a plugin can act on the denial", () => {
    const wire = classifyHostApiError(
      new EffectBoundaryDeniedError(PLUGIN_ID, "storage.write", "notes", "headless"),
    );
    expect(wire.detail).toEqual({
      pluginId: PLUGIN_ID,
      methodPath: "storage.write",
      target: "notes",
      reason: "headless",
    });
    expect(reconstructWireError(wire)).toBeInstanceOf(Error);
  });

  it("keeps a detached operation's settlement promise host-side", () => {
    const wire = classifyHostApiError(
      new PluginRuntimeDetachedOperationError(new Error("boom"), Promise.resolve(1)),
    );
    expect(wire.detail).toBeUndefined();
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe("the shared byte codec, which three members would otherwise each write", () => {
  it("keeps text and bytes distinguishable, which is the point of the tag", () => {
    // Tag bytes separately from base64-looking literal strings.
    const asText = encodeWireBytes("aGk=", "storage.write(data)");
    const asBytes = encodeWireBytes(new Uint8Array([104, 105]), "storage.write(data)");
    expect(asText).toEqual({ encoding: "utf8", data: "aGk=" });
    expect(asBytes).toEqual({ encoding: "base64", data: "aGk=" });
    expect(decodeWireBytes(asText, "x")).toBe("aGk=");
    expect(decodeWireBytes(asBytes, "x")).toEqual(new Uint8Array([104, 105]));
  });

  it("round-trips bytes that are not valid text", () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13]);
    const decoded = decodeWireBinary(encodeWireBytes(bytes, "storage.read()"), "x");
    expect(decoded).toEqual(bytes);
  });

  it("survives the JSON hop it exists to survive", () => {
    const wire = encodeWireBytes(new Uint8Array([1, 2, 3]), "storage.read()");
    const rehydrated = JSON.parse(JSON.stringify(wire)) as unknown;
    expect(decodeWireBinary(rehydrated, "x")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("throws over the cap rather than truncating, in both directions", () => {
    const oversized = new Uint8Array(WIRE_BYTES_MAX + 1);
    expect(() => encodeWireBytes(oversized, "storage.write(data)")).toThrow(
      HostApiBoundaryError,
    );
    try {
      encodeWireBytes(oversized, "storage.write(data)");
    } catch (error) {
      expect((error as HostApiBoundaryError).code).toBe("payload-too-large");
    }
    // Oversized binary payloads must refuse rather than silently truncate.
    expect(() =>
      decodeWireBytes(
        { encoding: "base64", data: "A".repeat(WIRE_BYTES_MAX * 2) },
        "storage.read()",
      ),
    ).toThrow(/exceeds/u);
  });

  it("refuses a payload that is not tagged at all", () => {
    for (const bad of [null, "raw", { data: "aGk=" }, { encoding: "hex", data: "6869" }]) {
      expect(() => decodeWireBytes(bad, "storage.write(data)"), String(bad)).toThrow(
        /not a tagged byte payload/u,
      );
    }
  });

  it("refuses text where a member declared it delivers bytes", () => {
    expect(() => decodeWireBinary({ encoding: "utf8", data: "hi" }, "storage.read()"))
      .toThrow(/expected bytes/u);
  });
});

describe("dispatcher resource budgets", () => {
  it("refuses exhausted request buckets before invoking their handlers", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => ({ status: 200 }));
      const resolve = vi.fn(async (_call: HostApiCall, scope: SubscriptionScope) => ({
        ok: true,
        exposure: "lease",
        vendor: "openai",
        handleId: scope.open(() => {}),
      }));
      const read = vi.fn(async () => null);
      const host = dispatcher({ table: {
        ...HOSTAPI_DISPATCH_TABLE,
        getSecret: defineHostApiPath("getSecret", read),
        hostFetch: defineHostApiPath("hostFetch", fetch),
        resolveApiKey: defineHostApiPath("resolveApiKey", resolve),
      } });
      for (let index = 0; index < 200; index += 1) {
        expect(await host.handle(hostApiRequest("getSecret", ["sample"], `read-${index}`)))
          .toHaveProperty("result");
      }
      expect(await host.handle(hostApiRequest("getSecret", ["sample"], "read-overflow")))
        .toMatchObject({ error: { data: { code: "rate-limited", retryAfterMs: 20 } } });
      expect(read).toHaveBeenCalledTimes(200);
      for (let index = 0; index < 60; index += 1) {
        expect(await host.handle(hostApiRequest("hostFetch", [], index))).toHaveProperty("result");
      }
      const fetchRefusal = await host.handle(hostApiRequest("hostFetch", [], "fetch-overflow"));
      expect(fetchRefusal).toMatchObject({ error: { data: {
        code: "rate-limited", retryAfterMs: 50, detail: { method: "hostFetch" },
      } } });
      expect(fetch).toHaveBeenCalledTimes(60);
      if (!("error" in fetchRefusal)) throw new Error("expected a request refusal");
      expect(reconstructWireError(fromHostApiRpcError(fetchRefusal.error)).retryAfterMs).toBe(50);
      for (let index = 0; index < 30; index += 1) {
        expect(await host.handle(hostApiRequest("resolveApiKey", [], `resolve-${index}`)))
          .toHaveProperty("result");
      }
      const resolveRefusal = await host.handle(hostApiRequest("resolveApiKey", [], "resolve-overflow"));
      expect(resolveRefusal).toMatchObject({ error: { data: {
        code: "rate-limited", retryAfterMs: 100, detail: { method: "resolveApiKey" },
      } } });
      expect(resolve).toHaveBeenCalledTimes(30);
      await vi.advanceTimersByTimeAsync(100);
      expect(await host.handle(hostApiRequest("resolveApiKey", [], "after-refill")))
        .toHaveProperty("result");
      expect(host.childGone()).toBe(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops and counts notification floods, then emits one aggregate", async () => {
    vi.useFakeTimers();
    try {
      const logs = vi.fn();
      const emits = vi.fn();
      const logEvents = vi.fn();
      const audits: HostApiBudgetAudit[] = [];
      const host = dispatcher({
        log: logs,
        reportBudgetAudit: (entry) => audits.push(entry),
        table: {
          ...HOSTAPI_DISPATCH_TABLE,
          emitEvent: defineHostApiPath("emitEvent", async () => { emits(); }),
          logEvent: defineHostApiPath("logEvent", async () => { logEvents(); }),
        },
      });
      for (let index = 0; index < 510; index += 1) {
        host.handleNotification({
          jsonrpc: "2.0", method: "notifications/ave/log",
          params: { message: `line-${index}` },
        });
      }
      expect(logs).toHaveBeenCalledTimes(500);
      expect(await host.handle(hostApiRequest("logEvent", ["info", "dropped"], "log-overflow")))
        .toHaveProperty("result", null);
      expect(logEvents).not.toHaveBeenCalled();
      for (let index = 0; index < 210; index += 1) {
        expect(await host.handle(hostApiRequest("emitEvent", ["demo.event"], index)))
          .toHaveProperty("result", null);
      }
      expect(emits).toHaveBeenCalledTimes(200);
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "notifications/ave/log", count: 1, summary: false }),
        expect.objectContaining({ method: "emitEvent", count: 1, summary: false }),
      ]));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "notifications/ave/log", count: 9, summary: true }),
        expect.objectContaining({ method: "emitEvent", count: 9, summary: true }),
      ]));
      host.childGone();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves service rate-limit verdicts as results", async () => {
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      raiseAlert: defineHostApiPath("raiseAlert", async () => ({ status: "rate_limited" })),
      proposeWork: defineHostApiPath("proposeWork", async () => ({ status: "rate_limited" })),
      triggerConversation: defineHostApiPath("triggerConversation", async () => ({
        accepted: false, reason: "rate_limited", source: "sample",
      })),
    };
    const host = dispatcher({ table });
    expect(await host.handle(hostApiRequest("raiseAlert", [{}], 1)))
      .toMatchObject({ result: { status: "rate_limited" } });
    expect(await host.handle(hostApiRequest("proposeWork", [{}], 2)))
      .toMatchObject({ result: { status: "rate_limited" } });
    expect(await host.handle(hostApiRequest("triggerConversation", [{}], 3)))
      .toMatchObject({ result: { accepted: false, reason: "rate_limited" } });
    host.childGone();
  });

  it("pins the per-kind ceilings on every lifetime-bearing kind with one", () => {
    expect(DISPATCH_SUBSCRIPTION_KIND_MAX).toEqual({
      onEvent: 64,
      "config.onChange": 16,
      onPluginsChanged: 4,
      spawnWorker: 8,
      startAudioCapture: 2,
      attachFloatingPanel: 1,
      resolveApiKey: 32,
    });
  });

  it("refuses the 65th in-flight call and lets cancellation free capacity", async () => {
    let entered = 0;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      hasRoutineBySource: defineHostApiPath("hasRoutineBySource", (call) => {
        entered += 1;
        return new Promise<boolean>((_resolve, reject) => {
          call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
        });
      }),
    };
    const host = dispatcher({ table });
    const pending = Array.from({ length: 64 }, (_, index) => host.handle({
      ...request(), id: `in-flight-${index}`,
    }));
    expect(entered).toBe(64);
    const refused = await host.handle({ ...request(), id: "overflow" });
    if (!("error" in refused)) throw new Error("expected an in-flight refusal");
    expect(refused.error.data).toMatchObject({
      code: "rate-limited", retryAfterMs: 100,
      detail: { method: "hasRoutineBySource" },
    });
    expect(refused.error.message).toBe("Host API rate limit exceeded.");
    expect(entered).toBe(64);
    host.handleNotification({
      jsonrpc: "2.0", method: "notifications/cancelled",
      params: { requestId: "in-flight-0" },
    });
    const cancelled = await pending[0];
    expect(cancelled).toMatchObject({ error: { data: { code: "host-internal" } } });
    const replacement = host.handle({ ...request(), id: "replacement" });
    expect(entered).toBe(65);
    expect(host.childGone()).toBe(0);
    await Promise.all([...pending.slice(1), replacement]);
  });

  it("reserves per-kind capacity before asynchronous registrations and releases it", async () => {
    let resolveOpen!: () => void;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    let started = 0;
    let stopped = 0;
    const table = {
      ...HOSTAPI_DISPATCH_TABLE,
      spawnWorker: defineHostApiPath("spawnWorker", async (_call, scope) => {
        started += 1;
        await opening;
        return { handleId: scope.open(() => { stopped += 1; }) };
      }),
    };
    const host = dispatcher({ table });
    const pending = Array.from({ length: 8 }, (_, index) => host.handle({
      ...request({ path: "spawnWorker" }), id: `worker-${index}`,
    }));
    expect(started).toBe(8);
    const refused = await host.handle({ ...request({ path: "spawnWorker" }), id: "worker-overflow" });
    expect(refused).toMatchObject({ error: { data: { code: "rate-limited" } } });
    expect(started).toBe(8);
    resolveOpen();
    const opened = await Promise.all(pending);
    expect(host.openSubscriptionCount).toBe(8);
    const first = opened[0];
    if (!("result" in first)) throw new Error("expected a worker handle");
    host.handleNotification({
      jsonrpc: "2.0", method: "notifications/ave/subscription/release",
      params: { subscriptionId: (first.result as { handleId: string }).handleId },
    });
    expect(stopped).toBe(1);
    expect(host.openSubscriptionCount).toBe(7);
    expect(await host.handle({ ...request({ path: "spawnWorker" }), id: "worker-replacement" }))
      .toHaveProperty("result");
    expect(host.childGone()).toBe(8);
    expect(stopped).toBe(9);
  });

  it("caps all subscriptions while release and shutdown remain usable", async () => {
    vi.useFakeTimers();
    try {
      let shutdownScope: SubscriptionScope | undefined;
      const shutdownChild = vi.fn(async () => {});
      const table = {
        ...HOSTAPI_DISPATCH_TABLE,
        onShutdown: defineHostApiPath("onShutdown", async (call, scope) => {
          shutdownScope = scope;
          scope.adopt(String(call.args[0]), () => {});
        }),
      };
      const host = dispatcher({ table, shutdownChild });
      for (let index = 0; index < 256; index += 1) {
        if (index === 190) await vi.advanceTimersByTimeAsync(2000);
        const reply = await host.handle(hostApiRequest("onShutdown", [`shutdown-${index}`], index));
        expect(reply, `registration ${index}`).toHaveProperty("result");
      }
      expect(host.openSubscriptionCount).toBe(256);
      const refused = await host.handle(hostApiRequest("onShutdown", ["overflow"], "overflow"));
      expect(refused).toMatchObject({ error: { data: { code: "rate-limited" } } });
      await shutdownScope?.shutdown("shutdown-0");
      expect(shutdownChild).toHaveBeenCalledWith("shutdown-0");
      host.handleNotification({
        jsonrpc: "2.0", method: "notifications/ave/subscription/release",
        params: { subscriptionId: "shutdown-0" },
      });
      expect(await host.handle(hostApiRequest("onShutdown", ["replacement"], "replacement")))
        .toHaveProperty("result");
      expect(host.childGone()).toBe(256);
    } finally {
      vi.useRealTimers();
    }
  });
});
