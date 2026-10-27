/** Validation grants only the base envelope, never saved user approvals; delegated workers face the same bound. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Validation must not read user permission settings. */
const settingsReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../permissions/permission-settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/permission-settings-store.js")>();
  return {
    ...actual,
    readPermissionSettings: (...args: Parameters<typeof actual.readPermissionSettings>) => {
      settingsReads.count += 1;
      return actual.readPermissionSettings(...args);
    },
  };
});

import { PassThrough, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "../../types.js";
import { StdioFrameDecoder } from "../../../mcp/stdio-framing.js";
import { FRAME_BYTES_MAX } from "../../isolation/host-api-wire.js";
import { PLUGIN_INSTANCE_METHODS } from "../../isolation/plugin-instance-wire.js";
import type { ChildLink } from "../../isolation/plugin-child-transport.js";
import {
  resolvePluginSocketDir,
  resolvePluginWorkerRunRoot,
} from "../../plugin-storage-layout.js";
import { createValidationHost } from "../validation-host.js";
import { openValidationSession } from "../validation-session.js";

type Frame = Record<string, unknown>;

const PLUGIN_ID = "validationprobe";

const GRANTED_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Validation Probe",
  version: "1.0.0",
  entry: "plugin.mjs",
  requires: { hostProtocol: "4" },
  description: "declares a grant the validator must not apply",
  tools: [],
  sandbox: {
    write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }],
  },
  configSchema: { properties: { workspace: { type: "string" } } },
};

let root: string;
let previousAveHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "validation-session-"));
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = join(root, ".ave");
  settingsReads.count = 0;
});

afterEach(() => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(root, { recursive: true, force: true });
});

function scriptedChild(): { link: ChildLink; sent: Frame[]; send: (frame: Frame) => void } {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const sent: Frame[] = [];
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  const send = (frame: Frame): void => void childToHost.write(`${JSON.stringify(frame)}\n`);
  hostToChild.on("data", (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      sent.push(frame);
      if (frame.method === PLUGIN_INSTANCE_METHODS.construct) {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            implementedToolNames: [],
            servesUiResources: false,
            lifecycleHooks: [],
            pluginProtocol: { requires: [] },
          },
        });
      }
    }
  });
  return {
    link: {
      input: childToHost,
      output: hostToChild,
      terminate: () => undefined,
      onGone: () => undefined,
      onFault: () => undefined,
    },
    sent,
    send,
  };
}

describe("the validation session's authority", () => {
  it("is the base envelope, even where the user's settings approve the declared directory", async () => {
    const approved = join(root, "approved-workspace");
    mkdirSync(approved, { recursive: true });
    mkdirSync(process.env.AVE_HOME!, { recursive: true });
    writeFileSync(
      join(process.env.AVE_HOME!, "settings.json"),
      JSON.stringify({ permissions: { additionalDirectories: [approved] } }, null, 2),
      "utf-8",
    );
    const pluginRoot = join(root, "plugin");
    const pluginDataDir = join(pluginRoot, "data");
    // The configured key is valid so an accidental saved-grant read would actually widen admission.
    const host = createValidationHost({
      "config.get": (key: string) => (key === "workspace" ? approved : undefined),
    });
    const child = scriptedChild();
    const session = await openValidationSession({
      manifest: GRANTED_MANIFEST,
      host,
      link: child.link,
      entryPath: join(pluginRoot, "plugin.mjs"),
      pluginRoot,
      pluginDataDir,
    });
    try {
      const socketDir = resolvePluginSocketDir(pluginDataDir);
      expect(session.confinement).toEqual({
        read: [pluginRoot, pluginDataDir, socketDir, resolvePluginWorkerRunRoot(pluginDataDir)],
        write: [pluginDataDir, socketDir],
      });
      expect(settingsReads.count).toBe(0);

      child.send({
        jsonrpc: "2.0",
        id: "into-approved",
        method: "ave/host/spawnWorker",
        params: { spec: { workerId: "into-approved", command: "/usr/bin/true", allowWritePaths: [approved] } },
      });
      await vi.waitFor(() => expect(child.sent.find((frame) => frame.id === "into-approved")).toBeDefined());
      expect(child.sent.find((frame) => frame.id === "into-approved")).toMatchObject({
        error: { data: { code: "effect-boundary-denied" } },
      });
    } finally {
      await session.teardown("case over");
    }
  });

  it("refuses an undeclared protocol before any frame is written", async () => {
    const written: unknown[] = [];
    const link: ChildLink = {
      input: new PassThrough(),
      output: new Writable({
        write(chunk, _encoding, callback) {
          written.push(chunk);
          callback(new Error("a frame was written to a child the host refused"));
        },
      }),
      terminate: () => undefined,
      onGone: () => undefined,
      onFault: () => undefined,
    };
    await expect(
      openValidationSession({
        manifest: { ...GRANTED_MANIFEST, requires: undefined },
        host: createValidationHost(),
        link,
        entryPath: join(root, "plugin.mjs"),
        pluginRoot: join(root, "plugin"),
        pluginDataDir: join(root, "plugin", "data"),
      }),
    ).rejects.toThrow(/does not declare a host protocol/);
    expect(written).toEqual([]);
  });
});
