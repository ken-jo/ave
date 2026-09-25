/**
 * The boundary contract, held against the surface SOT.
 *
 * Two enumerations have to describe the same 38 members: the effect
 * classification (`HOSTAPI_EFFECT_BY_PATH`, which the completeness test already
 * ties to the REAL hostApi object) and the marshalling contract this work
 * introduces. If they drift, a member exists that the boundary has no decision
 * for — and the failure mode is a plugin that works in every test and misbehaves
 * in the field, because today each member is a direct function call that no test
 * was written to pin.
 */
import { describe, expect, it } from "vitest";
import {
  ENFORCEMENT_EXCLUSIONS,
  EffectBoundaryDeniedError,
  GATED_EFFECT_PATHS,
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
} from "../host-api-dispatcher.js";
import {
  HostApiBoundaryError,
  UNIVERSAL_WIRE_ERROR_CODES,
  WIRE_BYTES_MAX,
  decodeWireBinary,
  decodeWireBytes,
  encodeWireBytes,
  hostApiPathOf,
  inactiveHostApiMessage,
  reconstructWireError,
  type ArgumentMarshalling,
  type ChildNotificationSink,
  type DisposerLifetime,
  type HostApiRequest,
  type ResultMarshalling,
} from "../host-api-wire.js";
import {
  OUT_OF_PROCESS_PLUGIN_IDS,
  allPluginsAreOutOfProcess,
  isOutOfProcessPlugin,
} from "../out-of-process-plugins.js";
import { hostApiRequest } from "../../../__tests__/support/host-protocol-wire.js";

const PLUGIN_ID = "com.example.contract";

const silentSink: ChildNotificationSink = { deliver: () => {} };

/**
 * One `ave/host/*` request. Nothing in it names the plugin: the dispatcher is
 * built for one child, and the connection is the identity.
 */
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
    // Captured, not dropped: a sink that discards is what shipped, and a
    // test that discards could not tell the difference.
    log: (message, meta) => hostLogs.push({ message, meta }),
    pluginId: PLUGIN_ID,
    isActive: () => true,
    notifications: silentSink,
    reportUnknownField: () => {},
    // No child runs here, so a shutdown reaching for one is a test bug.
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
    // The design says 36. It is right today only because the `callTool` drift it
    // named has since been closed; asserting the SOT's own size is what keeps
    // the number honest when the surface next changes.
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
    // A vocabulary member nothing declares is either a decision that was
    // dropped or a word that means nothing — both worth knowing about. The
    // annotations are the other half of the check: a declared value outside its
    // union is a compile error here, not a silently accepted string.
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
    // The routing SOT is empty, so nothing calls these yet. Recording the
    // starting state means a handler landing later is visible as a diff in this
    // count rather than as an untracked change of behaviour.
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
    // Named literally: these four are the round-trip-free members, and the count
    // moving is a design change, not a refactor.
    expect(contractSaysLocal).toEqual([
      "config.get",
      "getAppPreference",
      "getInstalledPluginIds",
      "storage.resolve",
    ]);
  });

  it("declares effect-boundary denial exactly where the gate can actually fire", () => {
    // Derived from the enforcement SOT, not hand-listed: a future async write
    // chokepoint joins GATED_EFFECT_PATHS automatically, and this test then
    // fails until its contract admits the error the gate will throw at it.
    const canDeny = new Set<string>(GATED_EFFECT_PATHS);
    // hostFetch is excluded from the generic wrapper because it self-gates
    // INLINE from its own verb snapshot — excluded from the wrapper, not ungated.
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
    // Inherited members are not hostApi members. The path arrives from the
    // least-trusted process in the system, and an `in` check admits every one
    // of these — after which the table lookup returns something off
    // `Object.prototype` rather than a handler.
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(isHostApiPath(inherited), inherited).toBe(false);
    }
  });
});

describe("the routing set names the isolated plugins and nothing else", () => {
  it("carries exactly the reviewed ids, and no configuration can widen it", () => {
    // Named exactly. A test asserting only "non-empty" would stay green if a
    // plugin were routed out-of-process without its own e2e evidence — and the
    // whole point of a per-plugin SOT is that each addition is a reviewed,
    // visible decision.
    expect([...OUT_OF_PROCESS_PLUGIN_IDS]).toEqual([
      "vega-helper",
      "lyra-mail",
      "local-indexer",
      "meeting",
      "orion-api",
    ]);
    expect(isOutOfProcessPlugin("vega-helper")).toBe(true);
    expect(isOutOfProcessPlugin("lyra-mail")).toBe(true);
    expect(isOutOfProcessPlugin("local-indexer")).toBe(true);
    // `meeting` joined them: its last axis was a floating window it built
    // itself out of `BrowserWindow`/`ipcMain`/`screen`/`session`, reached
    // through a `require` whose specifier lived in a variable. It takes a slot
    // in the host's dock now and resolves `electron` by no path at all.
    expect(isOutOfProcessPlugin("meeting")).toBe(true);
    // `orion-api` was the last one out, and the reason it took longest differed
    // in KIND from the four above: it was not missing a host API. It shipped
    // code written to run where the boundary does not reach — function bodies
    // compiled inside an authenticated page. Those are gone; its cancel flow
    // was the final one, and it could not simply be rewritten because the code
    // did not KNOW the endpoint it used. It was read off the live page instead.
    // Still asserted by id, in the other direction now, so the prose and the
    // set cannot drift apart.
    expect(isOutOfProcessPlugin("orion-api")).toBe(true);
    expect(Object.isFrozen(OUT_OF_PROCESS_PLUGIN_IDS)).toBe(true);
  });

  it("reports the in-process loader as still needed while any plugin is in-process", () => {
    // No FIRST-PARTY id is in-process any more, so the counter-example is a
    // fixture. That is not the same as the predicate being unreachable: a
    // third-party plugin the SOT does not name is exactly this case, and it is
    // why `importPluginFactory` still has to exist.
    const thirdParty = "someinstalledthirdpartyplugin";
    expect(allPluginsAreOutOfProcess([thirdParty])).toBe(false);
    expect(allPluginsAreOutOfProcess(["vega-helper", thirdParty])).toBe(false);
    expect(allPluginsAreOutOfProcess(["vega-helper"])).toBe(true);
    expect(allPluginsAreOutOfProcess([...OUT_OF_PROCESS_PLUGIN_IDS])).toBe(true);
    // An empty install list is not "all isolated" — it is no evidence either way.
    expect(allPluginsAreOutOfProcess([])).toBe(false);
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
    // The plugin never names itself: the host spawned the process and owns its
    // pipes, so the connection IS the plugin and the generation (§2.4). A params
    // field claiming otherwise is not refused and not read — it is one more
    // field the member does not declare, reported once and ignored (§3.3).
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

    // Once per (method, field) for the life of the connection, not per call.
    await host.handle(forged);
    expect(reported).toHaveLength(2);

    // Attributed to the BOUND plugin: a refusal names the plugin this
    // dispatcher serves, never the one the params claimed.
    const refused = await dispatcher({ isActive: () => false }).handle(forged);
    if (!("error" in refused)) throw new Error("expected a refusal");
    expect(refused.error.message).toBe(
      inactiveHostApiMessage(PLUGIN_ID, "hostApi.hasRoutineBySource"),
    );
  });

  it("caps what the child can make it report, and cuts long field names", async () => {
    // The child chooses both the method and the field name, so per-(method,
    // field) dedupe alone is a log flood and an unbounded set it controls.
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
    // One line says the rest are being dropped, and nothing follows it.
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
    // The 64th code point is two UTF-16 units; a cut by unit would keep only
    // the first of them.
    const field = `${"f".repeat(63)}\u{1F600}tail`;
    await host.handle(request({ params: { source: "nightly", [field]: 1 } }));
    expect(reports).toEqual([
      { kind: "field", method: "ave/host/hasRoutineBySource", field: `${"f".repeat(63)}\u{1F600}…` },
    ]);
  });

  it("reads an omitted params member as the empty object, and still refuses a non-object", async () => {
    // JSON-RPC 2.0 §4 lets a client leave `params` out, which is how a stock
    // client calls a member that takes no arguments.
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
    // The check §3.6 shows the in-process loopback does not perform: it passes
    // `response.result` across by reference, so a Map is received as a Map today.
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
        // The contract says nothing comes back; returning something means the
        // child's stub and the host's handler disagree about the member.
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

  it("preserves the class name the SDK contract tells plugins to match on", () => {
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
    // A plugin writing the literal string "aGk=" and a plugin writing the bytes
    // "hi" produce the same characters. Without the tag the file lands decoded
    // in one of those two cases and nothing reports it.
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
    // A truncating codec would return a shorter file and report success — the
    // caller cannot tell that from a file that really is that short.
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
