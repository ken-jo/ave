import { RULE_PROVENANCE } from "../../../permissions/decision-provenance.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDirs } from "../../../__tests__/test-helpers.js";
import {
  MemorySecretStore,
  type SecretStore,
} from "../../../lib/protected-secret-store.js";
import { writeUtf8FileAtomicSync } from "../../../lib/atomic-file.js";
import { canonicalStringify } from "../../../shared/canonical-json.js";
import {
  RATIONALE_CONTROL_CONTRACT_VERSION,
  beginRationaleHumanApprovalWait,
  approveRationaleHumanWait,
  retireRationaleHumanWait,
  InMemoryHostAnchorRoundCasStore,
  createActionIdentity,
  createRationaleRequiredControl,
  createRequestAnchor,
  createTriggeringBatchDisposition,
  type RationaleRequiredControl,
} from "../rationale-control.js";
import {
  DurableHostInvocationStartCasStore,
  type DurableHostInvocationStartCasStoreOptions,
} from "../rationale-invocation-journal.js";
import {
  createInvocationAuditEvent,
  transitionInvocationAudit,
  type HostInvocationStartCommit,
  type InvocationAuditRecord,
} from "../rationale-ticket-lifecycle.js";

const TEST_SECRET = "rationale-invocation-journal-test-secret-v1";
const CHECKPOINT_A = "invocation-execution-checkpoint-a";
const CHECKPOINT_B = "invocation-execution-checkpoint-b";
const JOURNAL_HEAD = "invocation-execution-head";
const checkpointStoresByPath = new Map<string, MemorySecretStore>();

class SwitchableSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  failNextWrite = false;
  failNextName: string | null = null;

  read(name: string, maxBytes = 1024 * 1024): string | null {
    const value = this.values.get(name);
    if (value === undefined) return null;
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      throw new Error("secret authority value exceeds read byte limit");
    }
    return value;
  }

  write(name: string, value: string): void {
    if (this.failNextWrite || this.failNextName === name) {
      this.failNextWrite = false;
      this.failNextName = null;
      throw new Error("checkpoint write unavailable");
    }
    this.values.set(name, value);
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

type JournalOptionsOverrides = Partial<
  Omit<DurableHostInvocationStartCasStoreOptions, "filePath">
>;

function journalOptions(
  filePath: string,
  overrides: JournalOptionsOverrides = {},
): DurableHostInvocationStartCasStoreOptions {
  let checkpointStore: SecretStore | undefined = overrides.checkpointStore;
  if (!checkpointStore) {
    let stored = checkpointStoresByPath.get(filePath);
    if (!stored) {
      stored = new MemorySecretStore();
      checkpointStoresByPath.set(filePath, stored);
    }
    checkpointStore = stored;
  }
  return {
    filePath,
    executionKey: TEST_SECRET,
    checkpointStore,
    ...overrides,
  };
}

function journalStore(
  filePath: string,
  overrides: JournalOptionsOverrides = {},
): DurableHostInvocationStartCasStore {
  return new DurableHostInvocationStartCasStore(
    journalOptions(filePath, overrides),
  );
}

function persistedSnapshot(filePath: string): {
  revision: number;
  entries: Record<string, Record<string, unknown>>;
} {
  return (JSON.parse(readFileSync(filePath, "utf8")) as {
    snapshot: {
      revision: number;
      entries: Record<string, Record<string, unknown>>;
    };
  }).snapshot;
}

const directory = useTempDirs("ave-invocation-journal-");

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

const controlsByInvocation = new Map<string, RationaleRequiredControl>();

function authorized(
  value: number,
  options: {
    now?: number;
    ttlMs?: number;
    sessionId?: string;
  } = {},
): InvocationAuditRecord {
  const now = options.now ?? 0;
  const sessionId = options.sessionId ?? `session-tool-${value}`;
  const toolUseId = `tool-${value}`;
  const anchor = createRequestAnchor({
    sessionId,
    turnId: `turn-${value}`,
    inputMessageId: `message-${value}`,
    inputOrigin: "user-keyboard",
    rawIntent: `perform operation ${value}`,
    now,
    ttlMs: options.ttlMs ?? 10_000,
  });
  if (!anchor) throw new Error("expected test request anchor");
  const finalInput = { command: `raw-secret-command-${value}` };
  const action = createActionIdentity({
    anchorId: anchor.anchorId,
    invocationTrustOrigin: "llm-tool-arg",
    rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    toolName: "bash",
    toolVersion: "1",
    source: "builtin",
    category: "shell",
    finalInput,
    canonicalTargets: [`workspace/target-${value}`],
    requestedEffects: ["execute-command"],
    affectedResources: [`workspace/target-${value}`],
    requiredAuthority: "shell",
    policyEpoch: "policy-1",
    registryGeneration: "registry-1",
    sandboxGeneration: "sandbox-1",
    sandboxExecutionPlan: { cwd: "workspace", filesystem: "workspace-only" },
  });
  const batch = createTriggeringBatchDisposition({
    batchId: `batch-${value}`,
    originalToolUseIds: [toolUseId],
    triggeringToolUseId: toolUseId,
    completedToolUseIds: [],
  });
  const anchorCas = new InMemoryHostAnchorRoundCasStore();
  const reservation = anchorCas.tryReserve({
    anchor,
    action,
    triggeringBatchDisposition: batch,
    round: 1,
    now,
  });
  if (!reservation) throw new Error("expected test anchor reservation");
  const control = createRationaleRequiredControl({
    anchor,
    action,
    triggeringBatchDisposition: batch,
    anchorRoundReservation: reservation,
    hostAnchorRoundCas: anchorCas,
    sealedAction: {
      toolUseId,
      toolName: "bash",
      originalInput: finalInput,
      finalInput,
    },
    eligibilityContext: {
      headless: false,
      forceModal: false,
      approvalReasonPrefix: null,
    },
    permission: {
      decision: "ask", provenance: RULE_PROVENANCE,
      reason: "Automatic review requires human approval.",
      reasonCode: "reviewer-human-required",
      reviewer: {
        route: "foreground-auto",
        verdict: { level: "high", reason: "bounded command" },
        outcome: "fresh",
      },
    },
    now,
  });
  const record: InvocationAuditRecord = {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    invocationDigest: control.invocationDigest,
    toolUseId,
    authorizationReceiptId: uuid(30_000 + value),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
  };
  controlsByInvocation.set(record.invocationDigest, control);
  return record;
}

function controlFor(record: InvocationAuditRecord): RationaleRequiredControl {
  const control = controlsByInvocation.get(record.invocationDigest);
  if (!control) throw new Error("missing test rationale control");
  return control;
}

function terminal(
  commit: HostInvocationStartCommit,
  event: "complete" | "fail" | "crash-recovery" = "complete",
): InvocationAuditRecord {
  return transitionInvocationAudit(
    commit.startedInvocationAudit,
    createInvocationAuditEvent(commit.startedInvocationAudit, event),
  );
}

afterEach(() => {
  controlsByInvocation.clear();
  checkpointStoresByPath.clear();
});

describe("DurableHostInvocationStartCasStore", () => {
  it("grants exactly one concurrent start across store instances", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const first = journalStore(filePath);
    const second = journalStore(filePath);
    const record = authorized(1, { sessionId: "session-one" });

    const results = await Promise.all([
      first.commitStart({
        sessionId: "session-one",
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,
        now: 100,
      }),
      second.commitStart({
        sessionId: "session-one",
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,
        now: 100,
      }),
    ]);

    expect(results.filter((value) => value !== null)).toHaveLength(1);

    const persisted = readFileSync(filePath, "utf8");
    expect(persisted).not.toContain("raw-secret-command");
    const snapshot = persistedSnapshot(filePath);
    expect(snapshot.entries[record.invocationDigest]?.sessionId).toBe("session-one");
    expect(Object.keys(snapshot.entries[record.invocationDigest] ?? {}).sort()).toEqual([
      "authorizationExpiresAt",
      "authorized",
      "controlDigest",
      "lease",
      "sessionId",
      "started",
      "terminal",
      "updatedAt",
    ]);
    if (platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("recovers an active invocation as unknown and retires its exact start", async () => {
    const filePath = join(directory(), "invocations.json");
    const record = authorized(2, { sessionId: "original-session" });
    const input = {
      sessionId: "original-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0 as const,
      now: 200,
    };
    expect(await journalStore(filePath).commitStart(input)).not.toBeNull();

    const restarted = journalStore(filePath);
    await expect(restarted.recoverAfterCrash({ now: 300 })).resolves.toEqual({ recovered: 1 });
    expect(persistedSnapshot(filePath).entries[record.invocationDigest]).toMatchObject({
      sessionId: "original-session",
      terminal: { state: "unknown-after-crash" },
    });
    await expect(restarted.commitStart({ ...input, now: 301 })).resolves.toBeNull();
  });

  it("preserves a completed invocation across recovery", async () => {
    const filePath = join(directory(), "invocations.json");
    const record = authorized(3, { sessionId: "terminal-session" });
    const store = journalStore(filePath, { now: () => 400 });
    const commit = await store.commitStart({
      sessionId: "terminal-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      now: 400,
    });
    if (!commit) throw new Error("expected committed start");
    await expect(store.commitTerminal({ lease: commit.lease, terminal: terminal(commit) })).resolves.toBe(true);
    await expect(journalStore(filePath).recoverAfterCrash({ now: 500 })).resolves.toEqual({ recovered: 0 });
    expect(persistedSnapshot(filePath).entries[record.invocationDigest]).toMatchObject({
      terminal: { state: "completed" },
    });
  });

  it("fails closed on corruption without replacing the journal", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    writeFileSync(filePath, "{not-json", "utf8");
    const store = journalStore(filePath);

    await expect(store.recoverAfterCrash({

      now: 600,
    })).rejects.toThrow(/corrupt/);
    expect(readFileSync(filePath, "utf8")).toBe("{not-json");
  });

  it("rejects unsigned and HMAC-tampered journal replacements", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath);
    await store.recoverAfterCrash({ now: 10 });
    const signedGenesis = readFileSync(filePath, "utf8");

    writeFileSync(filePath, canonicalStringify({
      schemaVersion: 1,
      revision: 0,
      entries: {},
    }) + "\n", "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/envelope/);

    writeFileSync(filePath, signedGenesis, "utf8");
    const record = authorized(20, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      now: 100,
    })).resolves.not.toBeNull();
    const signedActive = readFileSync(filePath, "utf8");
    const cleared = JSON.parse(signedActive) as {
      snapshot: { entries: Record<string, unknown> };
    };
    cleared.snapshot.entries = {};
    writeFileSync(filePath, canonicalStringify(cleared) + "\n", "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({

      now: 101,
    })).rejects.toThrow(/HMAC mismatch/);

  });

  it("fails closed when either the journal or its checkpoint authority is missing", async () => {
    const root = directory();
    const journalMissingPath = join(root, "journal-missing.json");
    await journalStore(journalMissingPath).recoverAfterCrash({

      now: 10,
    });
    unlinkSync(journalMissingPath);
    await expect(journalStore(journalMissingPath).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/missing behind its checkpoint/);

    const checkpointMissingPath = join(root, "checkpoint-missing.json");
    await journalStore(checkpointMissingPath).recoverAfterCrash({

      now: 10,
    });
    await expect(journalStore(checkpointMissingPath, {
      checkpointStore: new MemorySecretStore(),
    }).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/checkpoint is absent/);
  });

  it("fails closed when the sealed head is deleted", async () => {
    const root = directory();
    const filePath = join(root, "head-missing.json");
    const checkpointStore = new SwitchableSecretStore();
    await journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 10,
    });
    checkpointStore.delete(JOURNAL_HEAD);

    await expect(journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/head is absent/);
  });

  it("rejects a tampered checkpoint even when the journal is intact", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    await journalStore(filePath).recoverAfterCrash({

      now: 10,
    });
    const checkpointStore = checkpointStoresByPath.get(filePath);
    if (!checkpointStore) throw new Error("expected journal seal store");
    const raw = checkpointStore.read(CHECKPOINT_A);
    if (raw === null) throw new Error("expected journal checkpoint");
    const tampered = JSON.parse(raw) as { journalMac: string };
    tampered.journalMac = "0".repeat(64);
    checkpointStore.write(CHECKPOINT_A, canonicalStringify(tampered));

    await expect(journalStore(filePath).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/checkpoint seal mismatch/);
  });

  it("bounds checkpoint and head authority before JSON parsing", async () => {
    const root = directory();
    const filePath = join(root, "bounded-authority.json");
    const checkpointStore = new SwitchableSecretStore();
    await journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 10,
    });
    const checkpoint = checkpointStore.read(CHECKPOINT_A);
    const head = checkpointStore.read(JOURNAL_HEAD);
    if (checkpoint === null || head === null) {
      throw new Error("expected initialized journal authority");
    }

    checkpointStore.write(CHECKPOINT_A, "x".repeat(4 * 1024 + 1));
    await expect(journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/read byte limit/);

    checkpointStore.write(CHECKPOINT_A, checkpoint);
    checkpointStore.write(JOURNAL_HEAD, "x".repeat(4 * 1024 + 1));
    await expect(journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 12,
    })).rejects.toThrow(/read byte limit/);
  });

  it("detects rollback to an earlier valid signed journal", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath);
    const record = authorized(21, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      now: 100,
    })).resolves.not.toBeNull();
    const earlierSignedJournal = readFileSync(filePath, "utf8");

    await store.recoverAfterCrash({

      now: 200,
    });
    writeFileSync(filePath, earlierSignedJournal, "utf8");
    await expect(journalStore(filePath).recoverAfterCrash({

      now: 201,
    })).rejects.toThrow(/rollback detected/);
  });

  it("detects genesis rollback after the newest checkpoint slot is deleted", async () => {
    const root = directory();
    const filePath = join(root, "slot-deletion-rollback.json");
    const checkpointStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { checkpointStore });
    await store.recoverAfterCrash({ now: 10 });
    const genesisJournal = readFileSync(filePath, "utf8");

    const record = authorized(23, { now: 100, ttlMs: 10_000 });
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      now: 100,
    })).resolves.not.toBeNull();
    expect(checkpointStore.read(CHECKPOINT_B)).not.toBeNull();

    checkpointStore.delete(CHECKPOINT_B);
    writeFileSync(filePath, genesisJournal, "utf8");
    await expect(journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 101,
    })).rejects.toThrow(/head is ahead of available checkpoint/);
  });

  it("repairs a one-revision crash-ahead journal without replaying the start", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const checkpointStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { checkpointStore });
    await store.recoverAfterCrash({ now: 10 });

    const record = authorized(22, { now: 100, ttlMs: 10_000 });
    checkpointStore.failNextWrite = true;
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow("checkpoint write unavailable");

    const restarted = journalStore(filePath, { checkpointStore });
    await expect(restarted.recoverAfterCrash({
      now: 200,
    })).resolves.toEqual({ recovered: 1 });
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 201,
    })).resolves.toBeNull();
  });

  it("repairs a committed checkpoint when the following head write fails", async () => {
    const root = directory();
    const filePath = join(root, "head-write-crash.json");
    const checkpointStore = new SwitchableSecretStore();
    const store = journalStore(filePath, { checkpointStore });
    await store.recoverAfterCrash({ now: 10 });
    const genesisHead = checkpointStore.read(JOURNAL_HEAD);

    const record = authorized(24, { now: 100, ttlMs: 10_000 });
    checkpointStore.failNextName = JOURNAL_HEAD;
    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow("checkpoint write unavailable");
    expect(checkpointStore.read(CHECKPOINT_B)).not.toBeNull();
    expect(checkpointStore.read(JOURNAL_HEAD)).toBe(genesisHead);

    const restarted = journalStore(filePath, { checkpointStore });
    await expect(restarted.recoverAfterCrash({
      now: 200,
    })).resolves.toEqual({ recovered: 1 });
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 201,
    })).resolves.toBeNull();
  });

  it("does not advance authority after repeated committed atomic-write faults", async () => {
    const root = directory();
    const filePath = join(root, "committed-atomic-fault.json");
    const checkpointStore = new SwitchableSecretStore();
    await journalStore(filePath, { checkpointStore }).recoverAfterCrash({

      now: 10,
    });
    const genesisCheckpoint = checkpointStore.read(CHECKPOINT_A);
    const genesisHead = checkpointStore.read(JOURNAL_HEAD);
    let remainingFaults = 2;
    const committedFaultWriter: typeof writeUtf8FileAtomicSync = (
      path,
      content,
      mode,
    ) => {
      writeUtf8FileAtomicSync(path, content, mode);
      if (remainingFaults > 0) {
        remainingFaults -= 1;
        const phase = remainingFaults === 1 ? "initial" : "retry";
        throw Object.assign(new Error(`${phase} parent directory sync unavailable`), {
          committed: true as const,
        });
      }
    };
    const store = journalStore(filePath, {
      checkpointStore,
      writeFileAtomic: committedFaultWriter,
    });
    const record = authorized(25, { now: 100, ttlMs: 10_000 });

    await expect(store.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow("retry parent directory sync unavailable");
    expect(remainingFaults).toBe(0);
    expect(checkpointStore.read(CHECKPOINT_A)).toBe(genesisCheckpoint);
    expect(checkpointStore.read(CHECKPOINT_B)).toBeNull();
    expect(checkpointStore.read(JOURNAL_HEAD)).toBe(genesisHead);

    const restarted = journalStore(filePath, { checkpointStore });
    await expect(restarted.recoverAfterCrash({
      now: 200,
    })).resolves.toEqual({ recovered: 1 });
    await expect(restarted.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 201,
    })).resolves.toBeNull();
  });

  it("rejects oversized and truncated authenticated journal files", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    const store = journalStore(filePath, { maxBytes: 1_024 });
    await store.recoverAfterCrash({ now: 10 });
    const valid = readFileSync(filePath, "utf8");

    writeFileSync(filePath, "x".repeat(1_025), "utf8");
    await expect(journalStore(filePath, { maxBytes: 1_024 }).recoverAfterCrash({

      now: 11,
    })).rejects.toThrow(/invocation journal exceeds read byte limit/);

    writeFileSync(filePath, valid.slice(0, -2), "utf8");
    await expect(journalStore(filePath, { maxBytes: 1_024 }).recoverAfterCrash({

      now: 12,
    })).rejects.toThrow(/corrupt|canonical/);
  });

  // Windows junctions avoid file-symlink privilege and exercise lstat/fstat refusal without O_NOFOLLOW.
  // POSIX tests retain both file and directory links.
  it.each(platform === "win32" ? ["directory link"] : ["file symlink", "directory link"])(
    "rejects a final-component %s replacement",
    async (linkKind) => {
      const root = directory();
      const filePath = join(root, "invocations.json");
      await journalStore(filePath).recoverAfterCrash({

        now: 10,
      });
      if (linkKind === "file symlink") {
        const targetPath = join(root, "replacement.json");
        writeFileSync(targetPath, readFileSync(filePath));
        unlinkSync(filePath);
        symlinkSync(targetPath, filePath);
        await expect(journalStore(filePath).recoverAfterCrash({

          now: 11,
        })).rejects.toThrow(/not a regular file|ELOOP/);
        return;
      }
      unlinkSync(filePath);
      const targetDir = join(root, "replacement");
      mkdirSync(targetDir);
      symlinkSync(targetDir, filePath, "junction");
      await expect(journalStore(filePath).recoverAfterCrash({

        now: 11,
      })).rejects.toThrow(/invocation journal path is not a stable regular file|ELOOP/);
      expect(readdirSync(targetDir)).toEqual([]);
    },
  );

  it("requires the exact unexpired control before creating a journal", async () => {
    const root = directory();
    const record = authorized(7, {
      sessionId: "bound-session",
      now: 100,
      ttlMs: 50,
    });
    const other = authorized(8, {
      sessionId: "other-session",
      now: 100,
      ttlMs: 50,
    });
    const mismatchedPath = join(root, "mismatched.json");
    const mismatched = journalStore(mismatchedPath);

    await expect(mismatched.commitStart({
      sessionId: "bound-session",
      control: controlFor(other),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
    expect(existsSync(mismatchedPath)).toBe(false);

    const expiredPath = join(root, "expired.json");
    const expired = journalStore(expiredPath);
    await expect(expired.commitStart({
      sessionId: "bound-session",
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 150,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
    expect(existsSync(expiredPath)).toBe(false);
  });

  it("reserves terminal headroom and preserves the last authenticated state on size failure", async () => {
    expect(() => journalStore(join(directory(), "too-large.json"), {
      maxBytes: (16 * 1024 * 1024) + 1,
    })).toThrow(/options are invalid/);

    const baselineRoot = directory();
    const baselinePath = join(baselineRoot, "invocations.json");
    const baselineRecord = authorized(9);
    const baselineStore = journalStore(baselinePath);
    const baselineCommit = await baselineStore.commitStart({
      sessionId: controlFor(baselineRecord).anchor.sessionId,
      control: controlFor(baselineRecord),
      authorized: baselineRecord,
      expectedInvocationVersion: 0,

      now: 100,
    });
    if (!baselineCommit) throw new Error("expected baseline invocation start");
    const baselineBytes = Buffer.byteLength(readFileSync(baselinePath, "utf8"), "utf8");

    const headroomRoot = directory();
    const headroomPath = join(headroomRoot, "invocations.json");
    const headroomRecord = authorized(10);
    const headroomStore = journalStore(headroomPath, {
      maxBytes: baselineBytes + 2_047,
    });
    await expect(headroomStore.commitStart({
      sessionId: controlFor(headroomRecord).anchor.sessionId,
      control: controlFor(headroomRecord),
      authorized: headroomRecord,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow(/size limit/);
    expect(existsSync(headroomPath)).toBe(true);
    expect(persistedSnapshot(headroomPath)).toMatchObject({
      revision: 0,
      entries: {},
    });

    const before = readFileSync(baselinePath, "utf8");
    const cappedStore = journalStore(baselinePath, {
      maxBytes: Buffer.byteLength(before, "utf8") + 100,
    });
    const secondRecord = authorized(11);
    await expect(cappedStore.commitStart({
      sessionId: controlFor(secondRecord).anchor.sessionId,
      control: controlFor(secondRecord),
      authorized: secondRecord,
      expectedInvocationVersion: 0,

      now: 100,
    })).rejects.toThrow(/size limit/);
    expect(readFileSync(baselinePath, "utf8")).toBe(before);

    expect(await baselineStore.commitTerminal({
      lease: baselineCommit.lease,
      terminal: terminal(baselineCommit),

    })).toBe(true);
  });

  it("admits a start only when its reserved headroom can persist the terminal transition", async () => {
    const sizingRoot = directory();
    const sizingPath = join(sizingRoot, "invocations.json");
    const record = authorized(13, { now: 100, ttlMs: 10_000 });
    const sizingStore = journalStore(sizingPath, {
      now: () => 101,
    });
    await expect(sizingStore.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,
      now: 100,
    })).resolves.not.toBeNull();
    const pendingStartBytes = Buffer.byteLength(readFileSync(sizingPath, "utf8"), "utf8");

    const liveRoot = directory();
    const livePath = join(liveRoot, "invocations.json");
    const liveStore = journalStore(livePath, {
      maxBytes: pendingStartBytes + 2_048,
      now: () => 101,
    });
    const commit = await liveStore.commitStart({
      sessionId: controlFor(record).anchor.sessionId,
      control: controlFor(record),
      authorized: record,
      expectedInvocationVersion: 0,

      now: 100,
    });
    if (!commit) throw new Error("expected headroom-admitted start");
    expect(await liveStore.commitTerminal({
      lease: commit.lease,
      terminal: terminal(commit),

    })).toBe(true);
  });

  it("compacts an expired terminal under byte pressure below the entry cap", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    let now = 100;
    const generousStore = journalStore(filePath, {
      maxEntries: 10,
      now: () => now,
    });
    const expired = authorized(14, { now: 100, ttlMs: 50 });
    const survivor = authorized(15, { now: 100, ttlMs: 1_000 });

    const expiredCommit = await generousStore.commitStart({
      sessionId: controlFor(expired).anchor.sessionId,
      control: controlFor(expired),
      authorized: expired,
      expectedInvocationVersion: 0,

      now,
    });
    if (!expiredCommit) throw new Error("expected expired candidate start");
    now = 101;
    expect(await generousStore.commitTerminal({
      lease: expiredCommit.lease,
      terminal: terminal(expiredCommit),

    })).toBe(true);

    now = 120;
    const survivorCommit = await generousStore.commitStart({
      sessionId: controlFor(survivor).anchor.sessionId,
      control: controlFor(survivor),
      authorized: survivor,
      expectedInvocationVersion: 0,

      now,
    });
    if (!survivorCommit) throw new Error("expected survivor start");
    const beforeBytes = Buffer.byteLength(readFileSync(filePath, "utf8"), "utf8");

    now = 200;
    const candidate = authorized(16, { now, ttlMs: 1_000 });
    const cappedStore = journalStore(filePath, {
      maxEntries: 10,
      maxBytes: beforeBytes + 4_096,
      now: () => now,
    });
    const candidateCommit = await cappedStore.commitStart({
      sessionId: controlFor(candidate).anchor.sessionId,
      control: controlFor(candidate),
      authorized: candidate,
      expectedInvocationVersion: 0,

      now,
    });
    if (!candidateCommit) throw new Error("expected byte-pressure start");

    const snapshot = persistedSnapshot(filePath);
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(snapshot.entries[expired.invocationDigest]).toBeUndefined();
    expect(snapshot.entries[survivor.invocationDigest]).toBeDefined();
    expect(snapshot.entries[candidate.invocationDigest]).toBeDefined();
    expect(await cappedStore.commitTerminal({
      lease: candidateCommit.lease,
      terminal: terminal(candidateCommit),

    })).toBe(true);
  });

  it("retains terminal executions through expiry and blocks replay after restart", async () => {
    const root = directory();
    const filePath = join(root, "invocations.json");
    let now = 700;
    const store = journalStore(filePath, {
      maxEntries: 2,
      now: () => now,
    });

    const complete = async (record: InvocationAuditRecord): Promise<void> => {
      const commit = await store.commitStart({
        sessionId: controlFor(record).anchor.sessionId,
        control: controlFor(record),
        authorized: record,
        expectedInvocationVersion: 0,

        now,
      });
      if (!commit) throw new Error("expected committed start");
      now += 1;
      expect(await store.commitTerminal({
        lease: commit.lease,
        terminal: terminal(commit),

      })).toBe(true);
      now += 1;
    };

    const first = authorized(4, { now: 700, ttlMs: 100 });
    const second = authorized(5, { now: 700, ttlMs: 100 });
    const blockedCandidate = authorized(6, { now: 700, ttlMs: 100 });
    const third = authorized(12, {
      now: 900,
      ttlMs: 1_000,
      sessionId: "session-third",
    });
    await complete(first);
    await complete(second);

    const restarted = journalStore(filePath, {
      maxEntries: 2,
      now: () => now,
    });
    expect(await restarted.commitStart({
      sessionId: controlFor(first).anchor.sessionId,
      control: controlFor(first),
      authorized: first,
      expectedInvocationVersion: 0,

      now,
    })).toBeNull();
    await expect(restarted.commitStart({
      sessionId: controlFor(blockedCandidate).anchor.sessionId,
      control: controlFor(blockedCandidate),
      authorized: blockedCandidate,
      expectedInvocationVersion: 0,

      now,
    })).rejects.toThrow(/no safely compactable/);

    now = 900;
    const thirdCommit = await store.commitStart({
      sessionId: "session-third",
      control: controlFor(third),
      authorized: third,
      expectedInvocationVersion: 0,

      now,
    });
    expect(thirdCommit).not.toBeNull();

    const snapshot = persistedSnapshot(filePath);
    expect(Object.keys(snapshot.entries)).toHaveLength(2);
    expect(snapshot.entries[first.invocationDigest]).toBeUndefined();
    await expect(journalStore(filePath).commitStart({
      sessionId: controlFor(first).anchor.sessionId,
      control: controlFor(first),
      authorized: first,
      expectedInvocationVersion: 0,

      now: now + 1,
    })).rejects.toThrow(/invalid invocation-start CAS expectation/);
  });
});


it("does not restore an expired model authorization from a human-approved journal entry after restart", async () => {
  const filePath = join(directory(), "human-wait-journal.json");
  const record = authorized(140, { now: 0, ttlMs: 1000 });
  const control = controlFor(record);
  const lease = beginRationaleHumanApprovalWait(control, 100);
  try {
    approveRationaleHumanWait(control, lease, 2000);
    const commit = await journalStore(filePath).commitStart({ sessionId: control.anchor.sessionId,
      control, authorized: record, expectedInvocationVersion: 0, now: 2000 });
    expect(commit).not.toBeNull();
    expect(readFileSync(filePath, "utf8")).toContain('"authorizationExpiresAt":null');
    retireRationaleHumanWait(control, lease);
    const restarted = journalStore(filePath);
    await expect(restarted.recoverAfterCrash({ now: 2100 }))
      .resolves.toEqual({ recovered: 1 });
    await expect(restarted.commitStart({ sessionId: control.anchor.sessionId, control,
      authorized: record, expectedInvocationVersion: 0, now: 2200 }))
      .rejects.toThrow("invalid invocation-start CAS expectation");
  } finally { retireRationaleHumanWait(control, lease); }
});
