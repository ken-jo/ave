// Observed effects reach the dedicated non-HMAC sink without altering permission.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEffectShadowLog } from "../reviewer/risk-shadow-log.js";
import { AuditLogger, type AuditEntry } from "../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { auditPayload } from "../judge/__tests__/judge-request-fixture.js";

function collectingAudit(): { entries: AuditEntry[]; logger: AuditLogger } {
  const entries: AuditEntry[] = [];
  // Only `.logShadow` (the DEDICATED shadow channel) is exercised by the shadow path — a structural stand-in keeps the unit tests off the filesystem. A `log` stub is included to PROVE the shadow path never touches the canonical telemetry channel.
  const logger = {
    logShadow: (e: AuditEntry) => entries.push(e),
    log: () => {
      throw new Error("shadow path must use logShadow, not the canonical telemetry channel");
    },
  } as unknown as AuditLogger;
  return { entries, logger };
}

// Parse the structured payload the shadow path packs into `output`.
const payload = auditPayload;

describe("emitEffectShadowLog — effect shadow", () => {
  it("records a read-only invocation as hasMutatingEffect=false", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "ave-plugin-sampletool_read",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",

        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-eff-1",
          hasMutatingEffect: false,
          effects: [{ kind: "config.get", effect: "read", target: "k" }],
        },
      },
      logger,
    );
    expect(payload(entries[0])).toMatchObject({
      event: "effect-shadow",
      toolName: "ave-plugin-sampletool_read",
      source: "plugin",
      pluginId: "ave-plugin-sampletool",

      hostObservable: true,
      hasMutatingEffect: false,
      correlationId: "corr-eff-1",
    });
  });

  it("records hostObservable=false for an external MCP tool with an empty ledger (NOT a confirmed read)", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "remote_mcp_tool",
        source: "mcp",

        hostObservable: false,
        hostObservedEffect: {
          correlationId: "corr-eff-mcp",
          hasMutatingEffect: false,
          effects: [],
        },
      },
      logger,
    );
    const p = payload(entries[0]);
    // Empty ledger + hostObservable:false ⇒ a later read-recognition gate must NOT auto-relax this to read; it must fail closed.
    expect(p.hostObservable).toBe(false);
    expect(p.hasMutatingEffect).toBe(false);
    expect(p.effects).toEqual([]);
  });

  it("records a mutating invocation as hasMutatingEffect=true with the effects list", () => {
    const { entries, logger } = collectingAudit();
    emitEffectShadowLog(
      {
        toolName: "ave-plugin-sampletool_write",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",

        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-eff-2",
          hasMutatingEffect: true,
          effects: [
            { kind: "config.set", effect: "write", target: "k" },
            { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
          ],
        },
      },
      logger,
    );
    const p = payload(entries[0]);
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.correlationId).toBe("corr-eff-2");
    expect(p.effects).toEqual([
      { kind: "config.set", effect: "write", target: "k" },
      { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
    ]);
  });
});

describe("shadow log — dedicated shadow channel sink (temp AVE_HOME)", () => {
  let auditDir: string;
  afterEach(async () => {
    if (auditDir) await cleanupTmpDir(auditDir);
  });

  it("lands the effect record in the DEDICATED permission-shadow channel, NOT the telemetry channel", async () => {
    auditDir = mkdtempSync(join(tmpdir(), "ave-shadow-audit-"));
    const logger = new AuditLogger(auditDir);
    logger.log({ timestamp: new Date().toISOString(), sessionId: "s", type: "turn", input: "hi", output: "yo" });
    emitEffectShadowLog(
      {
        toolName: "ave-plugin-sampletool_write",
        source: "plugin",
        pluginId: "ave-plugin-sampletool",

        hostObservable: true,
        hostObservedEffect: {
          correlationId: "corr-sink",
          hasMutatingEffect: true,
          effects: [{ kind: "config.set", effect: "write", target: "k" }],
        },
      },
      logger,
    );
    await logger.flush();
    // The shadow record lands in `<date>.permission-shadow.jsonl`.
    const shadowFiles = readdirSync(auditDir).filter((f) => f.endsWith(".permission-shadow.jsonl"));
    expect(shadowFiles.length).toBe(1);
    const shadowLines = readFileSync(join(auditDir, shadowFiles[0]), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as AuditEntry);
    const effectRow = shadowLines.find((e) => (e.output ?? "").includes("effect-shadow"));
    expect(effectRow).toBeDefined();
    const p = payload(effectRow!);
    expect(p.event).toBe("effect-shadow");
    expect(p).not.toHaveProperty("declaredCategory");
    expect(p.hasMutatingEffect).toBe(true);
    expect(p.pluginId).toBe("ave-plugin-sampletool");
    expect(p.correlationId).toBe("corr-sink");

    // The canonical telemetry channel (`<date>.jsonl`, NO channel infix) holds ONLY the turn telemetry — no shadow pollution.
    const telemetryFiles = readdirSync(auditDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    expect(telemetryFiles.length).toBe(1);
    const telemetryText = readFileSync(join(auditDir, telemetryFiles[0]), "utf-8");
    expect(telemetryText).not.toContain("effect-shadow");
    expect(telemetryText).toContain("\"type\":\"turn\"");
  });
});
