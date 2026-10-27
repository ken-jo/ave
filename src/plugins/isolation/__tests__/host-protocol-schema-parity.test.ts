/** Published protocol schemas must match served contracts and remain reproducible across platform line endings. */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as Ajv2020Module from "ajv/dist/2020.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  hostApiMethodOf,
  type HostApiPath,
} from "../host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../plugin-instance-wire.js";
import { hostProtocolCapabilities } from "../host-api-dispatcher.js";
import { createBoundHostApiDispatchTable } from "../bound-host-api-table.js";
import { createValidationHost } from "../../validate/validation-host.js";
import { goldenFiles } from "./host-protocol-golden-files.js";
import { removeLinkOnly } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ts } from "ts-json-schema-generator";
import {
  HOST_PROTOCOL_SCHEMA_LABEL,
  generateHostProtocolSchema,
} from "../../../../scripts/lib/plugin-host-protocol-schema.js";

import type { AuthRedirectOpenResult } from "../../public-contract.js";
import type { HostAuthRedirectOpenResult } from "../../../../schemas/plugin-host-protocol/4/protocol-client.js";

type JsonSchema = Record<string, unknown>;
type Frame = Record<string, unknown>;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(join(REPO_ROOT, "schemas/plugin-host-protocol/4/protocol.schema.json"), "utf-8"),
) as {
  $id: string;
  $defs: {
    methods: Record<string, { params: JsonSchema; result: JsonSchema; errors: JsonSchema; events?: JsonSchema }>;
    notifications: Record<string, { params: JsonSchema }>;
    error: JsonSchema;
    errorCodes: { enum: string[] };
    capabilities: { items: { enum: string[] } };
    types: Record<string, JsonSchema>;
  };
};
const GOLDEN_ROOT = fileURLToPath(new URL("./fixtures/host-protocol/4/", import.meta.url));

const Ajv2020 = (Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module;
// Configured the way the plugin guide tells a consumer to: strict, with union
// types allowed because a field of more than one type is a type array. A
// method entry holds its schemas under `params`, `result`, `errors` and
// `events` (§6.1), which are not JSON Schema keywords, so each is compiled on
// its own below, with the named types beside it, as a consumer would.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (Ajv2020 as any)({ strict: true, allowUnionTypes: true, allErrors: true });

const compiled = new Map<string, (value: unknown) => boolean>();

function violations(where: string, schema: JsonSchema, value: unknown): string[] {
  let validate = compiled.get(where);
  if (!validate) {
    validate = ajv.compile({ ...schema, $defs: { types: SCHEMA.$defs.types } }) as (value: unknown) => boolean;
    compiled.set(where, validate);
  }
  if (validate(value)) return [];
  const errors = (validate as unknown as { errors: Array<{ instancePath: string; message: string }> }).errors;
  return errors.map((error) => `${where}${error.instancePath}: ${error.message}`);
}

function enumValues(schema: unknown): unknown[] {
  if (Array.isArray(schema)) return schema.flatMap(enumValues);
  if (!schema || typeof schema !== "object") return [];
  const own = Array.isArray((schema as JsonSchema).enum) ? ((schema as JsonSchema).enum as unknown[]) : [];
  return [...own, ...Object.values(schema).flatMap(enumValues)];
}

const DISPATCHABLE = (Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]).filter(
  (path) => HOSTAPI_PATH_CONTRACTS[path].result !== "child-local",
);

describe("the schema names what the host serves, and nothing else", () => {
  it("requires host-issued state in the schema, public SDK and generated client", () => {
    const result = { handle: "redirect-1", redirectUri: "http://localhost:43110", state: "host-state" } satisfies AuthRedirectOpenResult & HostAuthRedirectOpenResult;
    const schema = SCHEMA.$defs.methods["ave/host/authRedirect/open"]!.result;
    expect(violations("auth-open", schema, result)).toEqual([]);
    for (const state of [undefined, null, 42]) {
      expect(violations("auth-open", schema, { ...result, state })).not.toEqual([]);
    }
    expect(violations("auth-open", schema, { handle: result.handle, redirectUri: result.redirectUri })).not.toEqual([]);
  });

  it("is a valid 2020-12 schema whose references all resolve", () => {
    expect(ajv.validateSchema(SCHEMA), JSON.stringify(ajv.errors)).toBe(true);
    for (const [method, entry] of Object.entries(SCHEMA.$defs.methods)) {
      for (const part of ["params", "result", "errors", "events"] as const) {
        const schema = entry[part];
        if (schema === undefined) continue;
        expect(() => violations(`${method}.${part}`, schema, null), `${method}.${part}`).not.toThrow();
      }
    }
    for (const [method, entry] of Object.entries(SCHEMA.$defs.notifications)) {
      expect(() => violations(`${method}.params`, entry.params, null), method).not.toThrow();
    }
  });

  it("carries the app version it was generated from in its $id", () => {
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      version: string;
    };
    expect(SCHEMA.$id).toBe(
      `https://ave.agent-connector.ai/schemas/plugin-host-protocol/4/v${version}/protocol.schema.json`,
    );
  });

  it("has one method entry per dispatchable path and per instance method, and no other", () => {
    expect(DISPATCHABLE).toHaveLength(46);
    expect(Object.keys(SCHEMA.$defs.methods).sort()).toEqual(
      [...DISPATCHABLE.map((path) => hostApiMethodOf(path)), ...Object.values(PLUGIN_INSTANCE_METHODS)].sort(),
    );
  });

  it("names what every registration and handle pushes, and nothing else does", () => {
    const outlivesReply = DISPATCHABLE.filter((path) =>
      HOSTAPI_PATH_CONTRACTS[path].arguments === "handler-registration"
      || HOSTAPI_PATH_CONTRACTS[path].result === "handle"
      || HOSTAPI_PATH_CONTRACTS[path].result === "handle-or-denied");
    expect(outlivesReply.length).toBeGreaterThan(0);
    expect(
      Object.entries(SCHEMA.$defs.methods).filter(([, entry]) => entry.events).map(([method]) => method).sort(),
    ).toEqual(outlivesReply.map((path) => hostApiMethodOf(path)).sort());
  });

  it("has one notification entry per notification kind, and no other", () => {
    expect(Object.keys(SCHEMA.$defs.notifications).sort()).toEqual(
      Object.values(HOST_PROTOCOL_NOTIFICATIONS).sort(),
    );
  });

  it("publishes the closed error set, and names no code outside it", () => {
    expect(SCHEMA.$defs.errorCodes.enum).toEqual([...HOST_API_WIRE_ERROR_CODES]);
    const closed = new Set<unknown>(HOST_API_WIRE_ERROR_CODES);
    const named = [
      ...Object.values(SCHEMA.$defs.methods).flatMap((entry) => enumValues(entry.errors)),
      ...enumValues(SCHEMA.$defs.error),
    ];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((code) => !closed.has(code))).toEqual([]);
    for (const path of DISPATCHABLE) {
      const errors = SCHEMA.$defs.methods[hostApiMethodOf(path)]!.errors;
      // All host-thrown classes may appear on any method; version mismatch belongs only to construct.
      expect(enumValues(errors), path).toEqual(
        HOST_API_WIRE_ERROR_CODES.filter((code) => code !== "protocol-version-mismatch"),
      );
      for (const code of HOSTAPI_PATH_CONTRACTS[path].errors) {
        expect(String(errors.description), path).toContain(code);
      }
    }
  });

  it("requires a bounded retry delay for rate-limited replies", () => {
    const base = {
      code: -32000,
      message: "Host API rate limit exceeded.",
      data: { code: "rate-limited", name: "HostApiBoundaryError" },
    };
    expect(violations("rate-limited-valid", SCHEMA.$defs.error, {
      ...base, data: { ...base.data, retryAfterMs: 100 },
    })).toEqual([]);
    for (const retryAfterMs of [undefined, -1, 5001, 0.5]) {
      expect(violations("rate-limited-invalid", SCHEMA.$defs.error, {
        ...base, data: { ...base.data, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
      }), String(retryAfterMs)).not.toEqual([]);
    }
  });

  it("advertises what construct advertises for a host with every optional member bound", () => {
    const table = createBoundHostApiDispatchTable(createValidationHost().api, { read: [], write: [] });
    expect(SCHEMA.$defs.capabilities.items.enum).toEqual(hostProtocolCapabilities(table));
  });
});

function frameViolations(where: string, frame: Frame, request?: Frame): string[] {
  const method = typeof frame.method === "string" ? frame.method : undefined;
  if (method !== undefined && "id" in frame) {
    const entry = SCHEMA.$defs.methods[method];
    return entry ? violations(`${where} ${method}.params`, entry.params, frame.params) : [];
  }
  if (method !== undefined) {
    const entry = SCHEMA.$defs.notifications[method];
    if (!entry) return [`${where}: '${method}' is not a notification the schema names`];
    return violations(`${where} ${method}.params`, entry.params, frame.params);
  }
  const requested = typeof request?.method === "string" ? request.method : undefined;
  const entry = requested ? SCHEMA.$defs.methods[requested] : undefined;
  if ("error" in frame) {
    return violations(`${where} ${requested}.errors`, entry?.errors ?? SCHEMA.$defs.error, frame.error);
  }
  return entry ? violations(`${where} ${requested}.result`, entry.result, frame.result) : [];
}

describe("every golden frame is valid under the schema", () => {
  it("holds for each method's request and reply", () => {
    const files = goldenFiles(join(GOLDEN_ROOT, "methods")).filter((file) => !file.startsWith("errors/"));
    expect(files.length).toBe(DISPATCHABLE.length + Object.keys(PLUGIN_INSTANCE_METHODS).length);
    const failures = files.flatMap((file) => {
      const { request, response } = JSON.parse(readFileSync(join(GOLDEN_ROOT, "methods", file), "utf-8")) as {
        request: Frame;
        response: Frame;
      };
      return [...frameViolations(file, request), ...frameViolations(file, response, request)];
    });
    expect(failures).toEqual([]);
  });

  it("holds for each error code's reply", () => {
    const files = goldenFiles(join(GOLDEN_ROOT, "methods", "errors"));
    expect(files).toHaveLength(HOST_API_WIRE_ERROR_CODES.length);
    const failures = files.flatMap((file) => {
      const { request, response } = JSON.parse(
        readFileSync(join(GOLDEN_ROOT, "methods", "errors", file), "utf-8"),
      ) as { request: Frame; response: Frame };
      return frameViolations(file, response, request);
    });
    expect(failures).toEqual([]);
  });

  it("holds for each notification kind", () => {
    const files = goldenFiles(join(GOLDEN_ROOT, "notifications"));
    expect(files).toHaveLength(Object.keys(HOST_PROTOCOL_NOTIFICATIONS).length);
    const failures = files.flatMap((file) => {
      const { frame } = JSON.parse(readFileSync(join(GOLDEN_ROOT, "notifications", file), "utf-8")) as {
        frame: Frame;
      };
      return frameViolations(file, frame);
    });
    expect(failures).toEqual([]);
  });

  it("holds for every ave frame of each installed plugin's conversation", () => {
    const transcripts = goldenFiles(join(GOLDEN_ROOT, "plugins")).filter((file) => file.endsWith(".jsonl"));
    expect(transcripts).toHaveLength(6);
    let checked = 0;
    const failures = transcripts.flatMap((file) => {
      const lines = readFileSync(join(GOLDEN_ROOT, "plugins", file), "utf-8").trim().split("\n");
      const recorded = lines.map((line) => JSON.parse(line) as { from: string; frame: Frame });
      // Match replies to the opposite direction request IDs; each side allocates IDs independently.
      const requests = new Map<string, Frame>();
      return recorded.flatMap(({ from, frame }) => {
        if (typeof frame.method === "string" && "id" in frame) requests.set(`${from}:${String(frame.id)}`, frame);
        const request = "method" in frame
          ? undefined
          : requests.get(`${from === "host" ? "child" : "host"}:${String(frame.id)}`);
        const method = String(frame.method ?? request?.method ?? "");
        if (!method.startsWith("ave/") && !method.startsWith("notifications/")) return [];
        checked += 1;
        return frameViolations(file, frame, request);
      });
    });
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it("holds for every subscription payload, against the events of the method that opened it", () => {
    const transcripts = goldenFiles(join(GOLDEN_ROOT, "plugins")).filter((file) => file.endsWith(".jsonl"));
    const covered = new Set<string>();
    const failures = transcripts.flatMap((file) => {
      const lines = readFileSync(join(GOLDEN_ROOT, "plugins", file), "utf-8").trim().split("\n");
      const recorded = lines.map((line) => JSON.parse(line) as { from: string; frame: Frame });
      // Collect handle IDs separately: subscription events can arrive before registration replies.
      const requests = new Map<string, string>();
      const openedBy = new Map<string, string>();
      for (const { from, frame } of recorded) {
        if (from === "child" && typeof frame.method === "string" && "id" in frame) {
          requests.set(String(frame.id), frame.method);
        }
        if (from === "host" && !("method" in frame)) {
          const method = requests.get(String(frame.id));
          const handleId = (frame.result as { handleId?: unknown } | undefined)?.handleId;
          if (method && SCHEMA.$defs.methods[method]?.events && typeof handleId === "string") {
            openedBy.set(handleId, method);
          }
        }
      }
      return recorded.flatMap(({ frame }): string[] => {
        if (frame.method !== "notifications/ave/subscription") return [];
        const params = frame.params as { subscriptionId: string; payload: unknown };
        const method = openedBy.get(params.subscriptionId);
        if (!method) return [`${file}: subscription '${params.subscriptionId}' was not opened by a method with events`];
        covered.add(method);
        return violations(`${method}.events`, SCHEMA.$defs.methods[method]!.events!, params.payload)
          .map((failure) => `${file} ${failure}`);
      });
    });
    expect(failures).toEqual([]);
    expect([...covered].sort()).toEqual(
      Object.entries(SCHEMA.$defs.methods)
        .filter(([, entry]) => entry.events && !("not" in entry.events))
        .map(([method]) => method)
        .sort(),
    );
  });
});

describe("the manifest construct carries is exactly one of entry and process", () => {
  const MANIFEST = { $ref: "#/$defs/types/PluginManifest" };
  const base = {
    id: "exclusive",
    name: "Exclusive",
    version: "1.0.0",
    description: "declares one way to produce its process",
    tools: [],
    requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
  };
  const process = { command: "./bin/plugin", args: ["--stdio"], env: { PLUGIN_LOG_LEVEL: "info" } };

  it("validates the process-launch construct golden, request and reply", () => {
    const { request, response } = JSON.parse(
      readFileSync(join(GOLDEN_ROOT, "launches", "process", "construct.json"), "utf-8"),
    ) as { request: Frame; response: Frame };
    expect(request.method).toBe(PLUGIN_INSTANCE_METHODS.construct);
    expect((request.params as { manifest: Frame }).manifest).toHaveProperty("process");
    expect([...frameViolations("process-launch", request), ...frameViolations("process-launch", response, request)])
      .toEqual([]);
  });

  it("validates a manifest with only entry, and one with only process", () => {
    expect(violations("manifest", MANIFEST, { ...base, entry: "dist/index.js" })).toEqual([]);
    expect(violations("manifest", MANIFEST, { ...base, process })).toEqual([]);
  });

  it("refuses a manifest with both, and one with neither", () => {
    expect(violations("manifest", MANIFEST, { ...base, entry: "dist/index.js", process })).toEqual(
      expect.arrayContaining(["manifest/entry: boolean schema is false", "manifest/process: boolean schema is false"]),
    );
    expect(violations("manifest", MANIFEST, base)).toEqual(
      expect.arrayContaining([
        "manifest: must have required property 'entry'",
        "manifest: must have required property 'process'",
      ]),
    );
  });
});

describe("the generator writes the same bytes on every checkout", () => {
  it("reads CRLF sources to exactly what it reads LF sources to, and to the committed file", () => {
    const committed = readFileSync(
      join(REPO_ROOT, "schemas/plugin-host-protocol/4/protocol.schema.json"),
      "utf-8",
    );
    const fromLf = generateHostProtocolSchema().text;
    expect(fromLf).toBe(committed);

    // Generators must normalize source line endings so CRLF produces the same LF blobs.
    const sourceRoot = join(REPO_ROOT, "src").replaceAll("\\", "/");
    const readFile = ts.sys.readFile.bind(ts.sys);
    const crlfSources = new Set<string>();
    const reading = vi.spyOn(ts.sys, "readFile").mockImplementation((path, encoding) => {
      const text = readFile(path, encoding);
      if (text === undefined || !path.replaceAll("\\", "/").startsWith(sourceRoot)) return text;
      crlfSources.add(relative(REPO_ROOT, path).replaceAll("\\", "/"));
      return text.replace(/\r?\n/g, "\r\n");
    });
    let fromCrlf: string;
    try {
      fromCrlf = generateHostProtocolSchema().text;
    } finally {
      reading.mockRestore();
    }
    expect([...crlfSources]).toEqual(expect.arrayContaining([
      "src/plugins/public-contract.ts",
      "src/plugins/isolation/host-api-wire.ts",
      "src/plugins/isolation/plugin-instance-wire.ts",
    ]));
    expect(fromCrlf).toBe(fromLf);
  }, 120_000);
});

describe("the command line always reports an outcome", () => {
  const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
  const runCli = (scriptsDir: string, args: readonly string[]) =>
    spawnSync(
      nodeCommand,
      ["--import", "tsx", join(scriptsDir, "generate-plugin-host-protocol-schema.ts"), ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

  it("checks, and says so, when started through a path spelled unlike its real one", () => {
    // Use a symlink or Windows junction to exercise alternate repository spellings.
    const dir = mkdtempSync(join(tmpdir(), "schema-cli-"));
    const linked = join(dir, "scripts");
    try {
      symlinkSync(join(REPO_ROOT, "scripts"), linked, "junction");
      const result = runCli(linked, ["--check"]);
      expect(result.stdout).toBe(
        `${HOST_PROTOCOL_SCHEMA_LABEL} schemas/plugin-host-protocol/4/protocol.schema.json matches its sources\n`,
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      // Unlink scripts/ first and remove only its empty parent; never recurse through the link.
      removeLinkOnly(linked);
      rmdirSync(dir);
      expect(existsSync(join(REPO_ROOT, "scripts", "generate-plugin-host-protocol-schema.ts"))).toBe(true);
      expect(existsSync(join(REPO_ROOT, "scripts", "lib", "plugin-host-protocol-schema.ts"))).toBe(true);
    }
  }, 120_000);

  it("removes a link without ever reaching into a real directory", () => {
    // Cleanup must refuse a real nonempty directory.
    const dir = mkdtempSync(join(tmpdir(), "schema-cli-real-"));
    const kept = join(dir, "kept.txt");
    writeFileSync(kept, "kept", "utf-8");
    try {
      expect(() => removeLinkOnly(dir)).toThrow();
      expect(existsSync(kept)).toBe(true);
    } finally {
      unlinkSync(kept);
      rmdirSync(dir);
    }
  });

  it("refuses an argument it does not know, in one line and with a failing status", () => {
    const result = runCli(join(REPO_ROOT, "scripts"), ["--chek"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${HOST_PROTOCOL_SCHEMA_LABEL} unexpected arguments '--chek'; the only option is --check\n`,
    );
    expect(result.status).toBe(1);
  }, 120_000);
});
