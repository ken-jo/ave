import { refuseNamespaceFileCreation } from "../../__tests__/support/feature-namespace.js";
// Exercises the real pinned transport and loopback receiver; DNS, TLS termination, storage, approvals, and LLM work are simulated. Certificate
// validation is not exercised; runtime gate wiring is covered separately.
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import type { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "../../boot.js";
import { A2ARemoteClient, type A2ARemoteExecuteInput } from "../../api/a2a-remote-client.js";
import {
  A2A_EXACT_SEND_REPLAY_URI,
  A2A_SPECIFICATION_URI,
  a2aRemoteLineageDigestSha256,
  type A2ARemoteLineage,
  type A2ARemoteMutationApprover,
  type A2ARemoteTransport,
  type A2ARouteControlPlaneClient,
  type A2ARouteSnapshot,
} from "../../api/a2a-remote-contracts.js";
import { A2ARemoteDurableStore } from "../../api/a2a-remote-store.js";
import { createA2AStrictTransport } from "../../api/a2a-remote-transport.js";
import type { A2ASubAgentLifecycleRunner } from "../../api/a2a-subagent-handler.js";
import type {
  A2AWireHostBinding,
  A2AWireResumeBinding,
  A2AWireRunSnapshot,
  A2AWireSpawnCallbacks,
  SubAgentSpawnCallbacks,
  SubAgentSpawnResult,
} from "../../engine/subagent-runner.js";
import { A2AJsonRpcMethod, type A2AJsonObject } from "../../shared/a2a-wire.js";
import { A2ARole, A2ATaskState } from "../../shared/a2a.js";
import type { LoadedAgentProfile } from "../agent-profile-store.js";
import { deriveA2ALoopbackHandlerId } from "../a2a-loopback-runtime.js";
import {
  maybeStartRemoteA2AReceiverServer,
  resetRemoteA2AReceiverServerForTests,
  stopRemoteA2AReceiverServer,
} from "../a2a-remote-receiver-server.js";
import { A2A_REMOTE_RECEIVER_SECRET_KEY, createA2ARemoteRuntime } from "../a2a-remote-runtime.js";

const DIGEST = "a".repeat(64);
const SPEC_DIGEST = "c".repeat(64);
const RECEIVER_ORIGIN = "https://receiver-a2a-383a1d70.com/";
const RECEIVER_BEARER = "in-app-receiver-bearer-0123456789abcdef";
const PROFILE_PATH = "/workspace/receiver/agents/remote-peer.md";
const HANDLER_ID = deriveA2ALoopbackHandlerId(PROFILE_PATH);
const INTERFACE_URL = `${RECEIVER_ORIGIN}a2a/${HANDLER_ID}`;
// Any globally routable answer: the terminator, not this address, is dialled.
const PINNED_PUBLIC_ADDRESS = "1.1.1.1";
const CALLER_PROJECT = "/workspace/caller";
const TEXT = "text/plain";

const lineage: A2ARemoteLineage = {
  targetAgentId: 1,
  interfaceUrl: INTERFACE_URL,
  agentCardDigestSha256: DIGEST,
  trustKeyId: 2,
  credentialBindingId: 3,
  callerGenerationId: "outbound-generation-1",
  routePolicyVersion: 4,
  routePolicyDigestSha256: DIGEST,
  extensionSpecDigestSha256: SPEC_DIGEST,
};

function snapshot(credentialRevisionId: number): A2ARouteSnapshot {
  return {
    ...lineage,
    snapshotId: `snapshot-${credentialRevisionId}`,
    credentialRevisionId,
    credentialVersion: 1,
    credentialProvider: "os-keychain",
    credentialExternalVersion: `v${credentialRevisionId}`,
    advertisedInterfaceId: 6,
    interfaceHealthObservationId: 7,
    healthObservedAt: "2026-07-16T00:00:00.000Z",
    healthExpiresAt: "2099-01-01T00:00:00.000Z",
    servedSpecObservationId: 8,
    a2aSpecificationUri: A2A_SPECIFICATION_URI,
    issuedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    extensionUri: A2A_EXACT_SEND_REPLAY_URI,
    authenticationScheme: "Bearer",
    protocolBinding: "JSONRPC",
    protocolVersion: "1.0",
  };
}

// Name-keyed in-memory feature namespace; survives "restarts" by reuse.
function memoryNamespace() {
  const files = new Map<string, unknown>();
  return {
    files,
    handle: {
      dir: "memory",
      childDir: async (name: string) => name,
      createFile: refuseNamespaceFileCreation,
      readJson: async <T>(name: string, fallback: T): Promise<T> =>
        structuredClone((files.has(name) ? files.get(name) : fallback) as T),
      writeJson: async <T>(name: string, value: T): Promise<void> => {
        files.set(name, structuredClone(value));
      },
    },
  };
}

const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret" as const,
  encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
  decryptString: (value: Buffer) => {
    const text = value.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not sealed by this host");
    return text.slice("sealed:".length);
  },
};

function spawnResult(childSessionId: string, input: Partial<SubAgentSpawnResult> = {}): SubAgentSpawnResult {
  return {
    summary: "Remote peer completed.",
    toolCallCount: 0,
    turnCount: 1,
    childSessionId,
    entries: [],
    ok: true,
    ...input,
  };
}

// The receiving agent's work, at the runner boundary. Prompts select the lifecycle: complete, ask a question (INPUT_REQUIRED), or keep working until canceled.
class LifecycleRunner implements A2ASubAgentLifecycleRunner {
  readonly counts = { spawns: 0, resumes: 0, cancels: 0 };
  readonly prompts: string[] = [];
  private readonly snapshots = new Map<string, A2AWireRunSnapshot>();
  private readonly pending = new Map<string, (value: SubAgentSpawnResult) => void>();

  constructor(private readonly createChildSessionId: () => string = randomUUID) {}

  private set(childSessionId: string, taskState: A2AWireRunSnapshot["taskState"], extra: Partial<A2AWireRunSnapshot> = {}): void {
    this.snapshots.set(childSessionId, { childSessionId, title: "Remote peer", taskState, ...extra });
  }

  async spawnFromA2AWire(
    request: { messageText: unknown },
    _binding: A2AWireHostBinding,
    callbacks: A2AWireSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    this.counts.spawns += 1;
    const prompt = String(request.messageText);
    this.prompts.push(prompt);
    const childSessionId = this.createChildSessionId();
    this.set(childSessionId, A2ATaskState.WORKING);
    await callbacks.onDurablyLinked({ childSessionId });
    if (prompt.startsWith("complete:")) {
      this.set(childSessionId, A2ATaskState.COMPLETED, { summary: "Remote peer completed." });
      return spawnResult(childSessionId);
    }
    if (prompt.startsWith("ask:")) {
      const suspension = { reason: "question" as const, prompt: "Which branch?", resumeId: childSessionId };
      this.set(childSessionId, A2ATaskState.INPUT_REQUIRED, { suspension });
      return spawnResult(childSessionId, { summary: "Which branch?", suspension });
    }
    if (prompt.startsWith("work:")) {
      return await new Promise<SubAgentSpawnResult>((resolve) => this.pending.set(childSessionId, resolve));
    }
    throw new Error("unexpected remote prompt");
  }

  async resumeFromA2AWire(
    request: { resumeId: unknown; messageText: unknown },
    _binding: A2AWireResumeBinding,
    _callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    this.counts.resumes += 1;
    this.prompts.push(String(request.messageText));
    const childSessionId = String(request.resumeId);
    this.set(childSessionId, A2ATaskState.COMPLETED, { summary: "Answered." });
    return spawnResult(childSessionId, { summary: "Answered." });
  }

  getA2AWireRunSnapshot(childSessionId: string): A2AWireRunSnapshot | null {
    const value = this.snapshots.get(childSessionId);
    return value ? structuredClone(value) : null;
  }

  async cancelA2AWireRun(childSessionId: string) {
    this.counts.cancels += 1;
    this.set(childSessionId, A2ATaskState.CANCELED);
    const resolve = this.pending.get(childSessionId);
    this.pending.delete(childSessionId);
    resolve?.(spawnResult(childSessionId, { ok: false, error: "canceled", stopReason: "interrupted" }));
    return { ok: true as const, run: this.getA2AWireRunSnapshot(childSessionId)! };
  }
}

interface ObservedRequest {
  hostname: string;
  // What the transport's one pinned lookup handed the socket.
  pinned: { address: string; family: number } | null;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

// Simulate TLS termination by forwarding the pinned request to loopback and treating socket connect as the handshake.
function trustedTunnel(port: () => number, observed: ObservedRequest[]): typeof httpsRequest {
  const forward = (options: RequestOptions, callback?: (response: IncomingMessage) => void) => {
    let pinned: ObservedRequest["pinned"] = null;
    (options.lookup as unknown as (
      host: string,
      opts: object,
      done: (error: Error | null, address: string, family: number) => void,
    ) => void)(String(options.hostname), {}, (error, address, family) => {
      if (!error) pinned = { address, family };
    });
    const request = httpRequest({
      host: "127.0.0.1",
      port: port(),
      method: options.method,
      path: options.path,
      headers: options.headers,
      agent: false,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    }, callback);
    const end = request.end.bind(request) as (chunk?: unknown) => typeof request;
    (request as unknown as { end: (chunk?: unknown) => typeof request }).end = (chunk?: unknown) => {
      observed.push({
        hostname: String(options.hostname),
        pinned,
        path: String(options.path),
        headers: Object.fromEntries(
          Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
        ),
        body: Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.alloc(0),
      });
      return end(chunk);
    };
    request.once("socket", (socket) => socket.once("connect", () => socket.emit("secureConnect")));
    return request;
  };
  return forward as unknown as typeof httpsRequest;
}

interface Receiver {
  port: number;
  runner: LifecycleRunner;
  approvals: string[];
  // The receiver's redacted audit lines; a happy path drops nothing.
  audits: string[];
  dispose(): Promise<void>;
}

function dropped(receiver: Receiver): string[] {
  return receiver.audits.filter((line) => line.includes(":dropped:"));
}

async function startReceiver(state: {
  remote: ReturnType<typeof memoryNamespace>;
  tasks: ReturnType<typeof memoryNamespace>;
  runner: LifecycleRunner;
}): Promise<Receiver> {
  const approvals: string[] = [];
  const audits: string[] = [];
  const config = {
    routeControlBaseUrl: "",
    receiverPublicOrigin: RECEIVER_ORIGIN,
    outboundCallerGenerationId: "",
    receiverCallerGenerationId: "receiver-generation-1",
    extensionSpecDigestSha256: SPEC_DIGEST,
    targets: [],
    receiverMaxKeysPerGeneration: 16,
  };
  const settingsService = {
    get: (key: string) => key === "a2aRemote" ? config : key === "features" ? { a2aRemoteReceiver: true } : undefined,
    getEncryptedSecret: (key: string) => key === A2A_REMOTE_RECEIVER_SECRET_KEY ? RECEIVER_BEARER : null,
  };
  const agentActionApprover = async (request: { toolName: string }) => {
    approvals.push(request.toolName);
    return { decisionId: `receiver-approval-${approvals.length}`, decidedAt: new Date().toISOString() };
  };
  const remote = createA2ARemoteRuntime({
    settings: settingsService as never,
    agentActionApprover: agentActionApprover as never,
    projectRoot: "/workspace/receiver",
    gates: { outboundRouting: false, receiverProfile: true },
    encryption,
    namespace: state.remote.handle,
  });
  if (!remote) throw new Error("receiver runtime was not created");
  const profile: LoadedAgentProfile = {
    name: "remote-peer",
    description: "Receives delegated work from a peer Ave host.",
    sourceTools: [],
    triggers: [],
    body: "Complete only the delegated request.",
    filePath: PROFILE_PATH,
  };
  const services = {
    settingsService,
    a2aRemoteRuntime: remote,
    conversationLoop: {
      getSessionProjectContext: () => ({ projectRoot: "/workspace/receiver" }),
      getSessionExecutionCwd: () => "/workspace/receiver",
    },
    agentProfileStore: { list: async () => [profile] },
    getSubAgentRunner: () => state.runner,
    auditLogger: { log: (entry: { input: string }) => { audits.push(entry.input); } },
  } as unknown as AppServices;
  const started = await maybeStartRemoteA2AReceiverServer({
    services,
    dependencies: { openNamespace: () => state.tasks.handle },
  });
  if (!started) throw new Error("receiver listener did not start");
  return {
    port: started.port,
    runner: state.runner,
    approvals,
    audits,
    dispose: async () => {
      await stopRemoteA2AReceiverServer();
      resetRemoteA2AReceiverServerForTests();
      remote.dispose();
    },
  };
}

interface Caller {
  client: A2ARemoteClient;
  approvals: string[];
  resolves: number[];
  zeroized: { count: number };
  authorize: ReturnType<typeof vi.fn>;
}

function caller(options: {
  namespace: ReturnType<typeof memoryNamespace>;
  transport: A2ARemoteTransport;
  bearer?: string;
  controlPlane?: (intendedCredentialRevisionId: number) => A2ARouteSnapshot;
}): Caller {
  const approvals: string[] = [];
  const resolves: number[] = [];
  const zeroized = { count: 0 };
  // The production authorizer shape (a2a-remote-runtime.ts) minus the depth check, so the client's own depth-0 hard stop is what the D8 case proves.
  const authorize = vi.fn((input: { projectRoot: string; targetAgentId: number; interfaceUrl: string }) =>
    input.projectRoot === CALLER_PROJECT && input.targetAgentId === 1 && input.interfaceUrl === INTERFACE_URL);
  const approver: A2ARemoteMutationApprover = {
    approve: async (input) => {
      approvals.push(input.operation);
      return {
        decisionId: `caller-approval-${approvals.length}`,
        decidedAt: new Date().toISOString(),
        intendedCredentialRevisionId: input.intendedCredentialRevisionId,
        lineageDigestSha256: a2aRemoteLineageDigestSha256(input.lineage),
        semanticDigestSha256: input.semanticDigestSha256,
      };
    },
  };
  const controlPlane: A2ARouteControlPlaneClient = {
    resolve: async (request) => {
      resolves.push(request.intendedCredentialRevisionId);
      return (options.controlPlane ?? snapshot)(request.intendedCredentialRevisionId);
    },
  };
  const client = new A2ARemoteClient({
    enabled: true,
    authorizer: { authorize },
    approver,
    store: new A2ARemoteDurableStore({ namespace: options.namespace.handle, encryption }),
    secretResolver: {
      prepare: async () => {
        const bytes = Buffer.from(options.bearer ?? RECEIVER_BEARER, "utf8");
        return {
          take: () => bytes.toString("utf8"),
          zeroize: () => { bytes.fill(0); zeroized.count += 1; },
        };
      },
    },
    controlPlane,
    transport: options.transport,
  });
  return { client, approvals, resolves, zeroized, authorize };
}

const authorization = {
  ownerId: "caller-owner",
  projectRoot: CALLER_PROJECT,
  profileId: "caller-profile",
  origin: "renderer-user-keyboard",
  depth: 0,
  targetAgentId: 1,
  interfaceUrl: INTERFACE_URL,
};

function sendParams(messageId: string, text: string, extra: { taskId?: string; contextId?: string; returnImmediately?: boolean } = {}): A2AJsonObject {
  return {
    message: {
      messageId,
      role: A2ARole.USER,
      parts: [{ text }],
      ...(extra.taskId ? { taskId: extra.taskId } : {}),
      ...(extra.contextId ? { contextId: extra.contextId } : {}),
    },
    configuration: {
      acceptedOutputModes: [TEXT],
      historyLength: 16,
      returnImmediately: extra.returnImmediately ?? false,
    },
  };
}

function initialSend(operationId: string, text: string, extra: { returnImmediately?: boolean; id?: number } = {}): A2ARemoteExecuteInput {
  const messageId = `${operationId}-message`;
  return {
    operationId,
    attemptId: `${operationId}-attempt-1`,
    operation: "initial-send",
    targetLabel: "Remote peer",
    authorization,
    lineage,
    intendedCredentialRevisionId: 11,
    request: {
      id: extra.id ?? 1,
      method: A2AJsonRpcMethod.SEND_MESSAGE,
      params: sendParams(messageId, text, { returnImmediately: extra.returnImmediately }),
    },
    messageId,
  };
}

function taskOf(result: Awaited<ReturnType<A2ARemoteClient["execute"]>>) {
  if (!result.ok) {
    throw new Error(`remote operation failed: ${result.outcome} at ${result.record?.stage ?? "no record"}`);
  }
  const value = result.result as { task?: { id: string; contextId: string; status: { state: string } } };
  if (!value.task) throw new Error("SendMessage did not return the task branch");
  return value.task;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function world(options: {
  bearer?: string;
  controlPlane?: (revision: number) => A2ARouteSnapshot;
  dnsAnswer?: { address: string; family: 4 | 6 };
  createChildSessionId?: () => string;
} = {}) {
  const { dnsAnswer = { address: PINNED_PUBLIC_ADDRESS, family: 4 }, createChildSessionId, ...callerOptions } = options;
  const receiverState = { remote: memoryNamespace(), tasks: memoryNamespace(), runner: new LifecycleRunner(createChildSessionId) };
  let receiver = await startReceiver(receiverState);
  cleanups.push(async () => { await receiver.dispose(); });
  const observed: ObservedRequest[] = [];
  const strict = createA2AStrictTransport({
    lookup: async () => [dnsAnswer],
    request: trustedTunnel(() => receiver.port, observed),
  });
  const network = { dropNextResponse: false };
  const transport: A2ARemoteTransport = {
    invoke: async (input) => {
      const response = await strict.invoke(input);
      if (network.dropNextResponse) {
        network.dropNextResponse = false;
        throw new Error("response lost after the receiver committed it");
      }
      return response;
    },
  };
  const callerNamespace = memoryNamespace();
  const outbound = caller({ namespace: callerNamespace, transport, ...callerOptions });
  return {
    receiverState,
    get receiver() { return receiver; },
    restartReceiver: async () => {
      await receiver.dispose();
      receiver = await startReceiver(receiverState);
    },
    observed,
    network,
    callerNamespace,
    transport,
    outbound,
  };
}

describe("A2A agent-to-agent messaging between two in-app Ave hosts", () => {
  it("delivers an agent message without external conformance metadata", async () => {
    const w = await world();
    const sent = await w.outbound.client.execute(initialSend("no-evidence", "complete: verify in-app messaging"));
    const task = taskOf(sent);
    expect(task.status.state).toBe(A2ATaskState.COMPLETED);
    expect(sent.ok && sent.record.stage).toBe("settled");
    expect(w.observed).toHaveLength(1);
    expect(w.receiver.runner.prompts).toEqual(["complete: verify in-app messaging"]);
    expect(w.receiver.runner.counts).toEqual({ spawns: 1, resumes: 0, cancels: 0 });
  });

  it("delivers SendMessage to the remote agent over the strict transport and reads it back prompt-free", async () => {
    const w = await world();
    const sent = await w.outbound.client.execute(initialSend("deliver", "complete: summarize the branch"));
    const task = taskOf(sent);
    expect(task.status.state).toBe(A2ATaskState.COMPLETED);
    expect(w.receiver.runner.prompts).toEqual(["complete: summarize the branch"]);
    expect(w.receiver.runner.counts).toEqual({ spawns: 1, resumes: 0, cancels: 0 });
    expect(w.receiver.approvals).toHaveLength(1);
    expect(w.outbound.approvals).toEqual(["initial-send"]);
    expect(sent.ok && sent.record.stage).toBe("settled");

    // One request, addressed to the snapshot's interface, carrying the protocol version, the data-plane bearer and the exact-replay activation.
    expect(w.observed).toHaveLength(1);
    expect(w.observed[0]).toMatchObject({
      hostname: "receiver-a2a-383a1d70.com",
      path: `/a2a/${HANDLER_ID}`,
      headers: {
        "a2a-version": "1.0",
        authorization: `Bearer ${RECEIVER_BEARER}`,
        "a2a-extensions": A2A_EXACT_SEND_REPLAY_URI,
      },
    });

    const read = await w.outbound.client.execute({
      operationId: "deliver-get",
      attemptId: "deliver-get-attempt-1",
      operation: "get",
      authorization: { ...authorization, taskId: task.id, contextId: task.contextId },
      lineage,
      intendedCredentialRevisionId: 11,
      request: { id: 2, method: A2AJsonRpcMethod.GET_TASK, params: { id: task.id, historyLength: 0 } },
    });
    expect(read.ok).toBe(true);
    expect(read.ok && (read.result as { status: { state: string } }).status.state).toBe(A2ATaskState.COMPLETED);
    // Prompt-free: no new approval on either host, no extension activation.
    expect(w.outbound.approvals).toEqual(["initial-send"]);
    expect(w.receiver.approvals).toHaveLength(1);
    expect(w.observed[1]!.headers).not.toHaveProperty("a2a-extensions");
    // Both sockets were pinned to the one DNS answer the transport vetted.
    expect(w.observed.map((request) => request.pinned)).toEqual([
      { address: PINNED_PUBLIC_ADDRESS, family: 4 },
      { address: PINNED_PUBLIC_ADDRESS, family: 4 },
    ]);
    expect(dropped(w.receiver)).toEqual([]);
  });

  it.each(["random UUIDs", "phone-pattern UUIDs"])("answers an INPUT_REQUIRED question by continuation and cancels a working task with %s", async (identityKind) => {
    const childSessionIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-010123456789",
      "bbbbbbbb-bbbb-4bbb-8bbb-010987654321",
    ];
    let childSessionIndex = 0;
    const w = await world(identityKind === "phone-pattern UUIDs"
      ? { createChildSessionId: () => childSessionIds[childSessionIndex++]! }
      : {});
    const asked = taskOf(await w.outbound.client.execute(initialSend("ask", "ask: which branch should I use? Call 010-1234-5678.")));
    expect(asked.status.state).toBe(A2ATaskState.INPUT_REQUIRED);
    expect(w.receiver.runner.prompts).toEqual(["ask: which branch should I use? Call 010-****-****."]);

    const read = await w.outbound.client.execute({
      operationId: "ask-get",
      attemptId: "ask-get-attempt-1",
      operation: "get",
      authorization: { ...authorization, taskId: asked.id, contextId: asked.contextId },
      lineage,
      intendedCredentialRevisionId: 11,
      request: { id: 2, method: A2AJsonRpcMethod.GET_TASK, params: { id: asked.id, historyLength: 0 } },
    });
    expect(read.ok).toBe(true);
    expect(read.ok && (read.result as { status: { state: string } }).status.state)
      .toBe(A2ATaskState.INPUT_REQUIRED);

    const answered = await w.outbound.client.execute({
      operationId: "ask-continue",
      attemptId: "ask-continue-attempt-1",
      operation: "continue",
      targetLabel: "Remote peer",
      authorization: { ...authorization, taskId: asked.id, contextId: asked.contextId },
      lineage,
      intendedCredentialRevisionId: 11,
      request: {
        id: 3,
        method: A2AJsonRpcMethod.SEND_MESSAGE,
        params: sendParams("ask-answer", "use main", { taskId: asked.id, contextId: asked.contextId }),
      },
    });
    const continued = taskOf(answered);
    expect(continued.id).toBe(asked.id);
    expect(continued.contextId).toBe(asked.contextId);
    expect(continued.status.state).toBe(A2ATaskState.COMPLETED);
    expect(w.receiver.runner.counts.resumes).toBe(1);
    expect(w.receiver.runner.prompts).toContain("use main");

    const working = taskOf(await w.outbound.client.execute(
      initialSend("work", "work: keep going until told to stop", { returnImmediately: true }),
    ));
    expect(working.status.state).toBe(A2ATaskState.WORKING);
    const canceled = await w.outbound.client.execute({
      operationId: "work-cancel",
      attemptId: "work-cancel-attempt-1",
      operation: "cancel",
      targetLabel: "Remote peer",
      authorization: { ...authorization, taskId: working.id, contextId: working.contextId },
      lineage,
      intendedCredentialRevisionId: 11,
      request: { id: 4, method: A2AJsonRpcMethod.CANCEL_TASK, params: { id: working.id } },
    });
    expect(canceled.ok).toBe(true);
    expect(canceled.ok && (canceled.result as { status: { state: string } }).status.state)
      .toBe(A2ATaskState.CANCELED);

    expect(w.receiver.runner.counts).toEqual({ spawns: 2, resumes: 1, cancels: 1 });
    // Every mutation was approved once on each host; nothing else was.
    expect(w.outbound.approvals).toEqual(["initial-send", "continue", "initial-send", "cancel"]);
    expect(w.receiver.approvals).toHaveLength(4);
    // Only the two initial sends activated exact replay.
    expect(w.observed.map((entry) => entry.headers["a2a-extensions"] ?? null)).toEqual([
      A2A_EXACT_SEND_REPLAY_URI, null, null, A2A_EXACT_SEND_REPLAY_URI, null,
    ]);
    expect(dropped(w.receiver)).toEqual([]);
  });

  it("replays a lost response byte-for-byte across caller and receiver restart and executes once", async () => {
    const w = await world();
    w.network.dropNextResponse = true;
    const lost = await w.outbound.client.execute(initialSend("lost", "complete: write the report", { id: 41 }));
    expect(lost).toMatchObject({ ok: false, outcome: "unknown-manual-reconciliation-required" });
    expect(w.receiver.runner.counts.spawns).toBe(1);
    const approvalsBeforeRestart = w.receiver.approvals;
    expect(approvalsBeforeRestart).toHaveLength(1);

    // Both hosts restart from their durable state.
    await w.restartReceiver();
    const restarted = caller({ namespace: w.callerNamespace, transport: w.transport });
    const replayed = await restarted.client.execute({
      operationId: "lost",
      attemptId: "lost-attempt-2",
      operation: "replay",
      authorization,
      lineage,
      intendedCredentialRevisionId: 11,
      predecessorCredentialRevisionId: 11,
      // A replay never serializes the caller's new request: these must not leave.
      request: { id: 999, method: A2AJsonRpcMethod.SEND_MESSAGE, params: sendParams("lost-message", "must-not-be-sent") },
      messageId: "lost-message",
    });
    const task = taskOf(replayed);
    expect(task.status.state).toBe(A2ATaskState.COMPLETED);

    expect(w.observed).toHaveLength(2);
    expect(w.observed[1]!.body.equals(w.observed[0]!.body)).toBe(true);
    expect(w.observed[1]!.body.toString("utf8")).not.toContain("must-not-be-sent");
    expect(w.observed[1]!.headers["a2a-extensions"]).toBe(A2A_EXACT_SEND_REPLAY_URI);
    // Executed once: no second spawn, no second approval on either host.
    expect(w.receiverState.runner.counts.spawns).toBe(1);
    expect(approvalsBeforeRestart).toHaveLength(1);
    expect(w.receiver.approvals).toEqual([]);
    expect(restarted.approvals).toEqual([]);
  });

  it("refuses a caller with the wrong bearer before any approval or agent work", async () => {
    const w = await world({ bearer: "not-the-receiver-bearer-0123456789ab" });
    const refused = await w.outbound.client.execute(initialSend("intruder", "complete: exfiltrate"));
    expect(refused).toMatchObject({ ok: false, outcome: "authentication-failed" });
    expect(w.observed).toHaveLength(1);
    expect(w.receiver.runner.counts).toEqual({ spawns: 0, resumes: 0, cancels: 0 });
    expect(w.receiver.approvals).toEqual([]);
  });

  it("opens no socket when the control plane rotates the credential away from the approved revision", async () => {
    const w = await world({ controlPlane: (intended) => snapshot(intended + 1) });
    const result = await w.outbound.client.execute(initialSend("rotated", "complete: anything"));
    expect(result).toMatchObject({ ok: false, outcome: "not-sent" });
    expect(!result.ok && result.record?.stage).toBe("NOT_SENT");
    expect(w.outbound.resolves).toEqual([11]);
    expect(w.outbound.zeroized.count).toBe(1);
    expect(w.observed).toEqual([]);
    expect(w.receiver.runner.counts.spawns).toBe(0);
  });

  it("never dials a route whose DNS answer rebinds to a loopback address", async () => {
    // Reject loopback DNS before opening a socket; journal the failed attempt as outcome-unknown because rejection cannot prove nothing was sent.
    const w = await world({ dnsAnswer: { address: "127.0.0.1", family: 4 } });
    const result = await w.outbound.client.execute(initialSend("rebound", "complete: anything"));
    expect(result).toMatchObject({ ok: false, outcome: "unknown-manual-reconciliation-required" });
    expect(!result.ok && result.record?.stage).toBe("outcome-unknown");
    expect(w.observed).toEqual([]);
    expect(w.receiver.runner.counts.spawns).toBe(0);
    expect(w.receiver.approvals).toEqual([]);
  });

  it("refuses remote task creation from a depth-1 child before authorization, approval, route or socket", async () => {
    const w = await world();
    const result = await w.outbound.client.execute({
      ...initialSend("child", "complete: recurse"),
      authorization: { ...authorization, depth: 1 },
    });
    expect(result).toEqual({ ok: false, outcome: "not-sent" });
    expect(w.outbound.authorize).not.toHaveBeenCalled();
    expect(w.outbound.approvals).toEqual([]);
    expect(w.outbound.resolves).toEqual([]);
    expect(w.observed).toEqual([]);
    expect(w.receiver.runner.counts.spawns).toBe(0);
  });
});
