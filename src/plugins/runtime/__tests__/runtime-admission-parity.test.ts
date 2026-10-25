/** Tool and card admission share one runtime predicate; assert expected verdicts as well as parity. */
import { describe, expect, it, beforeEach, vi } from "vitest";
import * as admission from "../runtime-admission.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestPluginRuntime as PluginRuntime } from "../../__tests__/test-helpers.js";
import { pluginRuntimeToolDelegate } from "../../../mcp/plugin-runtime-delegate.js";
import { manifestIntegrityState } from "../../../permissions/manifest-integrity.js";
import { sessionContext } from "../../../engine/session-context.js";

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PLUGIN_ID = "com.parity";
const TOOL = "parity_read";
const URI = `ui://${PLUGIN_ID}/card.html`;
const SESSION = "session-A";
const OTHER_SESSION = "session-B";

beforeEach(() => manifestIntegrityState.resetForTests());

/** Null means runtime admission succeeded. */
type Verdict = "inactive" | "integrity-disabled" | null;

function classify(message: string): Verdict {
  if (/is inactive/.test(message)) return "inactive";
  if (/disabled after a manifest integrity violation/.test(message)) return "integrity-disabled";
  // A later failure still proves this admission gate passed.
  return null;
}

function runtimeWithPlugin(): PluginRuntime {
  const rt = new PluginRuntime({ hostRoot: HOST_ROOT, manifestPaths: [] });
  const internals = rt as unknown as {
    plugins: Map<string, unknown>;
    knownInstallClaims: Map<string, string | null>;
  };
  internals.plugins.set(PLUGIN_ID, {
    manifest: { id: PLUGIN_ID, tools: [{ name: TOOL }], uiResources: [{ uri: URI }] },
    instance: { handlers: {}, readUiResource: () => "<p>card</p>" },
  });
  internals.knownInstallClaims.set(PLUGIN_ID, null);
  return rt;
}

async function toolsCallVerdict(rt: PluginRuntime): Promise<Verdict> {
  const delegate = pluginRuntimeToolDelegate(rt, PLUGIN_ID, new Set([URI]), "g1");
  const outcome = await delegate(TOOL, {});
  if (!outcome.isError) return null;
  return classify(outcome.content.map((c) => c.text ?? "").join("\n"));
}

async function readUiVerdict(rt: PluginRuntime): Promise<Verdict> {
  try {
    await rt.readUiResource(PLUGIN_ID, URI);
    return null;
  } catch (err) {
    return classify(err instanceof Error ? err.message : String(err));
  }
}

interface Row {
  readonly name: string;
  readonly enabled: boolean;
  readonly activatedFor?: string;
  readonly callingSession?: string;
  readonly integrityViolation?: boolean;
  readonly expected: Verdict;
}

const ROWS: readonly Row[] = [
  { name: "registry-enabled, no session context", enabled: true, expected: null },
  { name: "registry-disabled, no session context", enabled: false, expected: "inactive" },
  {
    name: "registry-disabled but session-activated for the CALLING session",
    enabled: false,
    activatedFor: SESSION,
    callingSession: SESSION,
    expected: null,
  },
  {
    name: "registry-disabled, activated for a DIFFERENT session",
    enabled: false,
    activatedFor: OTHER_SESSION,
    callingSession: SESSION,
    expected: "inactive",
  },
  {
    name: "registry-disabled, activated but NO ALS context (fail-closed)",
    enabled: false,
    activatedFor: SESSION,
    expected: "inactive",
  },
  {
    name: "registry-enabled but integrity-disabled (kill switch)",
    enabled: true,
    integrityViolation: true,
    expected: "integrity-disabled",
  },
  {
    name: "registry-enabled, session context present, integrity-disabled",
    enabled: true,
    callingSession: SESSION,
    integrityViolation: true,
    expected: "integrity-disabled",
  },
  {
    name: "registry-disabled AND integrity-disabled (inactive is reported first)",
    enabled: false,
    integrityViolation: true,
    expected: "inactive",
  },
];

async function stateFor(row: Row): Promise<PluginRuntime> {
  const rt = runtimeWithPlugin();
  if (!row.enabled) await rt.setPluginEnabled(PLUGIN_ID, false);
  if (row.activatedFor) rt.setSessionActivated(row.activatedFor, PLUGIN_ID);
  if (row.integrityViolation) {
    await manifestIntegrityState.recordViolation(PLUGIN_ID, "card_open", "writeFileSync");
  }
  return rt;
}

function underSession<T>(sessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return sessionId === undefined ? fn() : sessionContext.run({ sessionId }, fn);
}

describe("Gate 4 runtime admission — tools/call and readUiResource share one predicate", () => {
  for (const row of ROWS) {
    it(`${row.name} → ${row.expected ?? "admitted"} on BOTH arms`, async () => {
      // Ask both production paths against the same runtime state.
      const rt = await stateFor(row);
      const { toolsCall, readUi } = await underSession(row.callingSession, async () => ({
        toolsCall: await toolsCallVerdict(rt),
        readUi: await readUiVerdict(rt),
      }));

      expect({ arm: "tools/call", verdict: toolsCall }).toEqual({
        arm: "tools/call",
        verdict: readUi,
      });
      // Expected verdicts prevent two equally broken predicates from passing parity.
      expect(toolsCall).toBe(row.expected);
      expect(readUi).toBe(row.expected);
    });
  }

  it("BOTH arms route through the ONE shared predicate (not a private copy)", async () => {
    const rt = runtimeWithPlugin();
    await rt.setPluginEnabled(PLUGIN_ID, false);
    const spy = vi.spyOn(admission, "checkRuntimeAdmission");

    await toolsCallVerdict(rt);
    const afterToolsCall = spy.mock.calls.length;
    expect(spy).toHaveBeenCalledWith(rt, PLUGIN_ID);
    expect(afterToolsCall).toBeGreaterThan(0);

    await readUiVerdict(rt);
    expect(spy.mock.calls.length).toBeGreaterThan(afterToolsCall);
    spy.mockRestore();
  });
});
