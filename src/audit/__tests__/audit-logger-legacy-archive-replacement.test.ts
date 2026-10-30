/** Inject a pathname swap after verification drains to prove archival publishes the verified bytes. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { join } from "node:path";

// Wrap both reader forms so the swap injection remains active across implementation changes.
let afterVerification: (() => void) | null = null;
vi.mock("../jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jsonl-reader.js")>();
  const runHook = (): void => {
    const hook = afterVerification;
    afterVerification = null;
    hook?.();
  };
  return {
    ...actual,
    iterateJsonlLines: async function* (...args: Parameters<typeof actual.iterateJsonlLines>) {
      yield* actual.iterateJsonlLines(...args);
      runHook();
    },
    iterateJsonlLinesFromFd: async function* (
      ...args: Parameters<typeof actual.iterateJsonlLinesFromFd>
    ) {
      yield* actual.iterateJsonlLinesFromFd(...args);
      runHook();
    },
  };
});

import { AuditLogger } from "../audit-logger.js";
import { computeLineHmac, GENESIS_MARKER, MemorySecretStore } from "../hmac-chain.js";

const SECRET = "ff".repeat(32);
const LEGACY_LINE = JSON.stringify({
  decision: "allow",
  auditId: "legacy-tail",
  ts: "2026-05-09T00:00:00.000Z",
  trustOrigin: "user-keyboard",
  prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
});
const ATTACKER_LINE = JSON.stringify({
  decision: "allow",
  auditId: "attacker-substituted",
  ts: "2026-05-09T00:00:00.000Z",
  trustOrigin: "user-keyboard",
  prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
});

let testHome: string;
let auditDir: string;
let loggers: AuditLogger[];

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ave-legacy-archive-"));
  auditDir = join(testHome, ".ave", "audit");
  mkdirSync(auditDir, { recursive: true });
  loggers = [];
  vi.stubEnv("AVE_HOME", join(testHome, ".ave"));
});

afterEach(async () => {
  afterVerification = null;
  await Promise.all(loggers.map((logger) => logger.close()));
  if (existsSync(testHome)) {
    await cleanupTmpDir(testHome);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createAuditLogger(): AuditLogger {
  const logger = new AuditLogger();
  loggers.push(logger);
  return logger;
}

function legacyArchives(): string[] {
  return readdirSync(auditDir).filter((name) =>
    name.includes("permission-audit.legacy-unverified-"),
  );
}

describe("legacy audit archival under pathname replacement", () => {
  it("archives the verified bytes, not whatever replaced the pathname", async () => {
    const logger = createAuditLogger();
    const activeFile = logger.getPermissionAuditLogFile();
    writeFileSync(activeFile, `${LEGACY_LINE}\n`, "utf-8");

    let replaced = false;
    afterVerification = () => {
      // Attempt the swap while the verified descriptor is open; Windows refusal itself preserves the guarantee.
      const substitute = join(auditDir, "substitute.jsonl");
      writeFileSync(substitute, `${ATTACKER_LINE}\n`, "utf-8");
      try {
        renameSync(substitute, activeFile);
        replaced = true;
      } catch {
        rmSync(substitute, { force: true });
      }
    };

    const outcome = await logger
      .setupPermissionAuditChain(SECRET, new MemorySecretStore())
      .then(() => "resolved" as const, () => "rejected" as const);
    expect(afterVerification).toBeNull(); // the swap really ran in the window

    // Forensic archives must contain only bytes read by verification.
    const archives = legacyArchives();
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(auditDir, archives[0]), "utf-8")).toBe(`${LEGACY_LINE}\n`);

    if (outcome === "resolved") {
      expect(replaced).toBe(false);
      expect(readFileSync(activeFile, "utf-8")).toBe("");
      expect(logger.isPermissionAuditChainReady()).toBe(true);
    } else {
      expect(replaced).toBe(true);
      expect(logger.isPermissionAuditChainReady()).toBe(false);
    }
  });

  it("starts a fresh genesis epoch when the pathname is left alone", async () => {
    const logger = createAuditLogger();
    const activeFile = logger.getPermissionAuditLogFile();
    writeFileSync(activeFile, `${LEGACY_LINE}\n`, "utf-8");

    await logger.setupPermissionAuditChain(SECRET, new MemorySecretStore());

    const archives = legacyArchives();
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(auditDir, archives[0]), "utf-8")).toBe(`${LEGACY_LINE}\n`);
    expect(readFileSync(activeFile, "utf-8")).toBe("");

    const appended = await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "fresh-epoch",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      } as Parameters<AuditLogger["appendPermissionAuditEntry"]>[0]);
    expect(appended.prevHash).toBe(computeLineHmac(SECRET, GENESIS_MARKER));
  });
});
