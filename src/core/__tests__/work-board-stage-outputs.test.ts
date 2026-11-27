import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { deferred } from "../../__tests__/support/deferred.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { governedWorkflowOutput } from "../../boot/steps/workflow-output-invocation.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { makeConversationLoopSettings } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../engine/__tests__/support/subagent-loop-fixtures.js";
import { PARENT_ALL_TOOL_SCOPE, exactToolScope, SubAgentRunner } from "../../engine/subagent-runner.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { securitySettingsGestures } from "../../ipc/security-settings-gesture.js";
import { mintHostDecisionProof } from "../../main/workflow-template-decision.js";
import { mcpToolToTool } from "../../mcp/mcp-tool-adapter.js";
import { PluginMcpHost } from "../../mcp/plugin-mcp-host.js";
import type { PluginManifest } from "../../plugins/types.js";
import { treeDigest, type PluginInstallPlan } from "../../marketplace/resolve/plugin-ladder.js";
import { verifyInstallReceipt } from "../../plugins/plugin-install-receipt.js";
import {
  activateAndCommitPreparedPluginForTest, agentPluginsDocument, makeTestPluginPaths, TestPluginMarketplaceService,
} from "../../plugins/__tests__/test-helpers.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { approvalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, IPC_APPROVAL_SETTLED, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ScheduleAttachment, StageEnvelope, TemplateStage, WorkflowTemplateRecord } from "../../shared/workflow-template-types.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { workBoardDecisionKey } from "../../shared/work-board-decision-intent.js";
import { canonicalWorkflowJson } from "../../shared/workflow-template-output.js";
import type { RequestedOutputPage } from "../../permissions/requested-output-approval.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createStageRequestOutputTool } from "../../tools/stage-request-output.js";
import { stageOf } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../work-board/workflow/__tests__/stage-run-harness.js";
import { createHostGit } from "../../work-board/workflow/host-git.js";
import { createRequestedOutputHooks, requestedOutputHash, type RequestedOutputHooks } from "../../work-board/workflow/requested-outputs.js";

const DECLARATION = { kind: "send-message", owner: "server", ownerId: "reports", toolName: "send_report" } as const;
const ENVELOPE: StageEnvelope = {
  tools: [], writePaths: [], readRoots: [], commands: [], network: [], mcpReadOnlyTools: [],
  mcpGenerationTools: [], pluginGenerationTools: [], outputs: ["branch"], budget: { rounds: 5, minutes: 1, costUsd: 0 },
};

it("a scheduled run ends at the gate with outputs pending and nothing sent", async () => {
  const send = vi.fn();
  const h = await stageRunHarness({ observeRunWork: true, workflow: {
    outputs: createRequestedOutputHooks(createHostGit(), { invoke: send }, process.cwd()),
    unattendedAllowed: () => ({ ok: true }),
    lane: { admit: async () => ({ ok: true }), sessionLinked: vi.fn(), sessionEnded: vi.fn(), onDenied: () => () => {} },
  } });
  await h.runThenEnd(async () => {
    const version = await h.confirm([stageOf("review", { envelope: ENVELOPE, requestedOutputs: [DECLARATION] })]);
    const pin = h.pinOf(version);
    const proof = mintHostDecisionProof("local-desktop");
    await expect(h.templates.attachSchedule({ scheduleId: "daily", ...pin }, proof, { kind: "all" })).rejects.toMatchObject({ code: "schedule-requires-read-only" });
    const attachment: ScheduleAttachment = { ...pin, scheduleId: "daily", approvedScope: { kind: "all" },
      id: "daily-fixture", who: "user", origin: "local-desktop", at: proof.decidedAt };
    const path = join(h.dir, "templates.json");
    const file = JSON.parse(readFileSync(path, "utf8")) as { templates: WorkflowTemplateRecord[] };
    file.templates[0].scheduleAttachments = [attachment];
    writeFileSync(path, JSON.stringify(file));
    const start = h.engine.startScheduledTemplate({ kind: "schedule-attachment", pin, attachmentId: attachment.id, firedAt: proof.decidedAt }, "Scheduled report");
    const [child] = await h.untilLive(1);
    const cwd = child.input.projectRoot ?? "";
    expect(child.input.unattendedStage).toMatchObject({ stageId: "review" });
    const { toolName, owner, ownerId } = DECLARATION;
    expect(await child.input.stageOutputTool?.execute({ toolName, owner, ownerId, args: { body: "Ready" }, summary: "Send report" },
      { cwd, metadata: {}, extraAllowedDirectories: [] })).toMatchObject({ isError: false });
    child.finish({ summary: "Report ready" });
    const run = await start;
    if (!run.ok) throw new Error(run.code);
    await expect(run.result).resolves.toMatchObject({ status: "awaiting_approval" });
    const stage = await h.stageRun(run.itemId, "review");
    expect(stage).toMatchObject({ requestedOutputs: [{ decl: DECLARATION }], gate: { status: "pending" } });
    expect(stage.outputExecutions).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

async function withRunner(body: (fixture: {
  runner: SubAgentRunner; registry: ToolRegistry; cwd: string; tools: string[][]; approval: Promise<ApprovalRequest>; gate: ApprovalGate;
  execute: ReturnType<typeof vi.fn>;
}) => Promise<void>) {
  const h = await stageRunHarness();
  const owner = makeMockWebContents();
  const gate = new ApprovalGate(owner as never);
  const approval = deferred<ApprovalRequest>();
  owner.send.mockImplementation((channel: string, request: ApprovalRequest) => {
    if (channel === IPC_APPROVAL_REQUEST) approval.resolve(request);
  });
  const execute = vi.fn(async () => ({ output: "Sent", isError: false }));
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: DECLARATION.toolName, source: "mcp", mcpServerId: DECLARATION.ownerId,
    description: "Send a report", category: "write", jsonSchema: { type: "object" }, execute }));
  const tools: string[][] = [];
  const { hasProviderSpy, refreshProviderSpy } = patchLoopProvider({ vendor: "claude", async *streamTurn({ messages, tools: schemas }) {
    tools.push((schemas ?? []).map(schema => schema.name));
    if (messages.some(message => message.role === "user" && message.content === "Send report") && !messages.some(message => message.role === "tool_result")) {
      yield { type: "tool_call", id: "delivery", name: DECLARATION.toolName, input: {} };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "Ready" };
    yield { type: "message_complete", stopReason: "end_turn" };
  } });
  const permissionManager = new PermissionManager(join(h.dir, "permissions.json"));
  permissionManager.setMode("strict");
  const runner = new SubAgentRunner({
    parentDeps: makeSubagentLoopDeps(registry, { approvalGate: gate, permissionManager, settingsService: makeConversationLoopSettings(false),
      auditLogger: new AuditLogger(), networkFetch: unusedNetworkFetch }),
    toolRegistry: registry, subAgentMemoryManager: new MemoryManager({ aveDir: join(h.dir, "children") }),
  });
  try { await body({ runner, registry, cwd: h.dir, tools, approval: approval.promise, gate, execute }); }
  finally {
    gate.disposeAll();
    hasProviderSpy.mockRestore();
    refreshProviderSpy.mockRestore();
    await h.cleanup();
  }
}

it("an undeclared outward call is denied in a scheduled run and raises a card in an attended one", () => withRunner(async ({ runner, cwd, tools, gate, approval, execute }) => {
  const input = { title: "Stage", instructions: "Send report", toolScope: PARENT_ALL_TOOL_SCOPE, projectRoot: cwd };
  await runner.spawn({ ...input, unattendedStage: { runKey: "run", stageId: "review" } });
  expect(tools.every(names => !names.includes(DECLARATION.toolName))).toBe(true);
  expect(gate.pendingCount).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  const attended = runner.spawn(input);
  const card = await approval;
  expect(card.toolName).toBe(DECLARATION.toolName);
  expect(execute).not.toHaveBeenCalled();
  gate.disposeAll();
  await attended;
}));

it("keeps the stage output tool out of descendant tool scopes", () => withRunner(async ({ runner, registry, cwd, tools }) => {
  const input = { title: "Stage", instructions: "Inspect result", toolScope: PARENT_ALL_TOOL_SCOPE, projectRoot: cwd };
  const tool = createStageRequestOutputTool([DECLARATION], async () => ({ ok: true, id: "delivery" }));
  registry.register(tool);
  await runner.spawn({ ...input, stageOutputTool: tool });
  await runner.spawn({ ...input, title: "Delegated child" });
  await runner.spawn({ ...input, title: "Scoped child", toolScope: exactToolScope([tool.name]) });
  expect(tools).toHaveLength(3);
  expect(tools[0]).toContain("stage_request_output");
  expect(tools.slice(1).every(names => !names.includes(tool.name))).toBe(true);
  expect(tools.every(names => !names.includes("git_push"))).toBe(true);
}));

async function installOutputPlugin(source: "git" | "folder", root: string, manifest: PluginManifest): Promise<PluginManifest> {
  const pluginsRoot = join(root, "plugins");
  const cacheRoot = join(pluginsRoot, ".cache");
  mkdirSync(pluginsRoot);
  writeFileSync(join(pluginsRoot, "registry.json"), JSON.stringify({ version: 1, plugins: [] }));
  const service = new TestPluginMarketplaceService(makeTestPluginPaths({ rootDir: root, cacheRoot }));
  const authority = { capabilities: [], requires: { minAppVersion: "0.12.0", hostProtocol: "5" } };
  const revision = source === "folder" ? `local-${"a".repeat(64)}` : "a".repeat(40);
  const plan: PluginInstallPlan = {
    sourceId: "sample", sourceOrigin: "custom", snapshotCommit: revision,
    versionCommit: source === "folder" ? revision : "b".repeat(40),
    packagePath: "plugins/reports", kind: "plugin", name: manifest.id, version: manifest.version,
    minAppVersion: authority.requires.minAppVersion, hostProtocol: authority.requires.hostProtocol, authority,
    artifact: { tree: "plugins/reports" },
  };
  const entry = "dist/entry.mjs";
  const document = agentPluginsDocument({ ...manifest, ...authority, entry });
  const files = [
    { path: "plugin.json", data: Buffer.from(JSON.stringify(document)), executable: false },
    { path: entry, data: Buffer.from("export default {};"), executable: false },
  ];
  const zip = new AdmZip();
  for (const file of files) zip.addFile(file.path, file.data, "", 0o644);
  const zipBuffer = zip.toBuffer();
  await service.installGitPlugin(plan, {
    stage: async () => ({
      plan, zipBuffer, unencrypted: false, notInstalled: [], manifestDocument: document,
      artifactSha256: source === "folder" ? treeDigest(files) : createHash("sha256").update(zipBuffer).digest("hex"),
      rung: source === "folder" ? "folder" : "archive",
      rungs: source === "folder" ? [{ rung: "folder", outcome: "used" }] : [
        { rung: "release", outcome: "skipped", reason: "NOT_DECLARED" }, { rung: "archive", outcome: "used" },
      ],
    }),
    activatePreparedArtifact: activateAndCommitPreparedPluginForTest,
  });
  const receipt = await verifyInstallReceipt(cacheRoot, manifest.id, join(pluginsRoot, manifest.id));
  expect(receipt).toMatchObject({ ok: true, receipt: { installSource: source } });
  const installed = await service.getInstalledConfigManifest(manifest.id);
  if (!installed) throw new Error("Missing installed plugin manifest");
  return installed.manifest;
}

const DEFAULT_WORKSPACE = process.cwd();
const PLUGIN_OUTPUT = { ...DECLARATION, owner: "plugin", kind: "upload" } as const;

async function withOutputExecutor(
  opts: { args: Record<string, unknown>; owner?: "plugin" | "server"; kind?: "upload" | "other"; rewrite?: true | Record<string, unknown>; install?: "git" | "folder" },
  body: (fixture: {
    h: Awaited<ReturnType<typeof stageRunHarness>>;
    hooks: RequestedOutputHooks;
    surface: WebContents;
    gate: ApprovalGate;
    audit: AuditLogger;
    shown: Promise<ApprovalRequest>;
    nextApproval: () => Promise<ApprovalRequest>;
    /** The run authority each output execution was handed. */
    authorities: AbortSignal[];
    settled: Promise<string>;
    events: string[];
    handler: ReturnType<typeof vi.fn>;
    executor: ToolExecutor;
    registry: ToolRegistry;
  }) => Promise<void>,
) {
  const decl = { ...PLUGIN_OUTPUT, owner: opts.owner ?? "plugin", kind: opts.kind ?? "upload" };
  let hooks: RequestedOutputHooks;
  const authorities: AbortSignal[] = [];
  const h = await stageRunHarness({ observeRunWork: true, workflow: { outputs: {
    accept: input => hooks.accept(input),
    execute: input => {
      authorities.push(input.authority);
      return hooks.execute(input);
    },
  } } });
  const owner = makeMockWebContents();
  const nativeEvents = new EventEmitter();
  const surface = Object.assign(nativeEvents, owner) as unknown as WebContents;
  let nextCard = deferred<ApprovalRequest>();
  const settled = deferred<string>();
  const events: string[] = [];
  owner.send.mockImplementation((channel: string, request: ApprovalRequest | { requestId: string }) => {
    if (channel === IPC_APPROVAL_REQUEST && "id" in request) {
      events.push("card shown");
      nextCard.resolve(request);
      nextCard = deferred<ApprovalRequest>();
    }
    if (channel === IPC_APPROVAL_SETTLED && "requestId" in request) settled.resolve(request.requestId);
  });
  const audit = new AuditLogger(join(h.dir, "audit"));
  const gate = new ApprovalGate(sessionId => approvalSurfaceRegistry.resolve(sessionId), undefined, undefined, audit);
  const registry = new ToolRegistry();
  const handler = vi.fn(async (_name: string, _input: Record<string, unknown>) => {
    events.push("handler");
    return { text: "Sent" };
  });
  const schema = { name: decl.toolName, description: "Send a report", inputSchema: { type: "object" as const, properties: {} } };
  const generationId = "report-generation";
  let plugin: PluginMcpHost | undefined;
  try {
    if (decl.owner === "server") {
      registry.register(mcpToolToTool(decl.ownerId, decl.toolName, schema, handler));
    } else {
      const manifest: PluginManifest = {
        id: decl.ownerId, name: "Reports", description: "Report delivery", version: "1.0.0", entry: "entry.mjs",
        tools: [{ ...schema, _meta: { ui: { visibility: ["model"] } } }],
      };
      const installed = opts.install ? await installOutputPlugin(opts.install, h.dir, manifest) : manifest;
      plugin = PluginMcpHost.loopback(installed, async (name, input) => {
        const result = await handler(name, input);
        return { content: [{ type: "text", text: result.text }] };
      }, undefined, generationId);
      const tools = await plugin.prepareTools();
      registry.reservePluginReplacement(decl.ownerId, tools, []).publish();
      plugin.publishPrepared(tools);
    }
    const manager = new PermissionManager(join(h.dir, "permissions.json"));
    manager.setMode("strict");
    const generationAccess = {
      acquireExact: async () => ({ generation: { state: { runtime: { instance: { handlers: {} } } } }, release: vi.fn() }),
      runWithLease: async (_lease: unknown, invoke: () => Promise<unknown>) => invoke(),
    };
    await audit.setupPermissionAuditChain("a".repeat(64));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, new ScriptHookManager(), audit,
      undefined, undefined, undefined, () => generationAccess as never, (_tool, sessionId) => ({
        ownerVersion: "1.0.0", generationId, appSessionId: sessionId ?? "test-session",
        accountScopeHash: "sample-account-scope", accountHash: "sample-account", appGrantRequired: false,
      }));
    if (opts.rewrite) executor.getHookRunner().registerPreHook("rewrite", () => ({
      action: "modify", updatedInput: opts.rewrite === true ? { ...opts.args, body: "Changed by hook" } : opts.rewrite,
    }));
    const dispatch = executor.executeAll.bind(executor);
    vi.spyOn(executor, "executeAll").mockImplementation((calls, options) => {
      const approve = options?.approvedInvocation;
      return approve ? dispatch(calls, { ...options, approvedInvocation: (candidate, input) => {
        events.push("approvedInvocation");
        return approve(candidate, input);
      } }) : dispatch(calls, options);
    });
    hooks = createRequestedOutputHooks(createHostGit(), governedWorkflowOutput(registry, executor, gate), DEFAULT_WORKSPACE);
    await body({ h, hooks, surface, gate, audit, shown: nextCard.promise, nextApproval: () => nextCard.promise, authorities,
      settled: settled.promise, events, handler, executor, registry });
  } finally {
    gate.disposeAll();
    await h.drainRunWork();
    await plugin?.dispose();
    await audit.close();
    await h.cleanup();
  }
}

type OutputExecutorFixture = Parameters<Parameters<typeof withOutputExecutor>[1]>[0];

function answerOutput({ gate, events, surface }: OutputExecutorFixture, card: ApprovalRequest, choice: "allow-once" | "deny-once" = "allow-once") {
  events.push("card answered");
  gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice, nonce: card.nonce, hmac: card.hmac }, surface);
}

function outputPhonePage(id: string, authority: RequestedOutputPage["authority"] = { refreshCurrent: async () => true, isCurrent: () => true }): RequestedOutputPage {
  return { id, login: "owner@example.test", authority, canViewProject: () => true };
}

it.each(["desktop", "phone"] as const)("lets the %s win a shared output card once across paired pages", winningSurface => withOutputExecutor({
  args: plainArgs,
}, async fixture => {
  const { gate, handler, audit } = fixture;
  const releaseIdentity = deferred<boolean>();
  const phone = outputPhonePage("first-page", { isCurrent: () => true, refreshCurrent: () => releaseIdentity.promise });
  const other = outputPhonePage("second-page");
  gate.listRequestedOutputCards(phone);
  gate.listRequestedOutputCards(other);
  const exactArgs = { ...plainArgs, body: `<img src="external">\n${"내용".repeat(500)}` };
  const { card, decision } = await openOutputGate(fixture, 1, [], exactArgs);
  const [first] = gate.listRequestedOutputCards(phone);
  const [second] = gate.listRequestedOutputCards(other);
  if (!first || !second || !("handle" in first) || !("handle" in second)) throw new Error("Both paired pages must receive the request");
  expect(first.content).toEqual(card.requestedOutputCard);
  expect(second.content).toEqual(first.content);
  expect(first.content.argsText).toContain("내용".repeat(500));
  expect(first.handle).not.toBe(second.handle);
  expect(gate.listRequestedOutputCards(phone)).toEqual([first]);
  await expect(gate.answerRequestedOutputCard(first.handle, "allow-once", other)).resolves.toBe("requested-output-card-unavailable");
  const answer = gate.answerRequestedOutputCard(first.handle, "allow-once", phone);
  if (winningSurface === "desktop") {
    answerOutput(fixture, card, "deny-once");
    releaseIdentity.resolve(true);
    await expect(answer).resolves.toBe("approval-already-resolved");
  } else {
    releaseIdentity.resolve(true);
    await expect(answer).resolves.toBe("accepted");
    answerOutput(fixture, card, "deny-once");
  }
  await expect(decision).resolves.toMatchObject({ ok: true });
  expect(handler).toHaveBeenCalledTimes(winningSurface === "phone" ? 1 : 0);
  if (winningSurface === "phone") expect(handler).toHaveBeenCalledWith(PLUGIN_OUTPUT.toolName, exactArgs);
  expect(gate.listRequestedOutputCards(other)).toEqual([{ requestId: card.id, resolvedBy: winningSurface === "phone" ? "tailnet-surface" : "desk" }]);
  await expect(gate.answerRequestedOutputCard(second.handle, "allow-once", other)).resolves.toBe("approval-already-resolved");
  await audit.flush();
  const entries = (await audit.search({ limit: 100 })).entries.filter(row => row.output?.startsWith(`[approval:decided] ${card.id}`));
  expect(entries).toHaveLength(1);
  expect(entries[0].output).toContain(`answeredBy=${winningSurface === "phone" ? "tailnet-surface" : "desk"}`);
  expect(entries[0].output).not.toContain(exactArgs.body);
}));

it("refuses handler entry when the winning phone loses authority after Allow once", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { gate, handler } = fixture;
  const refreshCurrent = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  const page = outputPhonePage("winning-page", { isCurrent: () => true, refreshCurrent });
  gate.listRequestedOutputCards(page);
  const { decision } = await openOutputGate(fixture);
  const [offered] = gate.listRequestedOutputCards(page);
  if (!offered || !("handle" in offered)) throw new Error("Missing phone offer");
  await expect(gate.answerRequestedOutputCard(offered.handle, "allow-once", page)).resolves.toBe("accepted");
  await expect(decision).resolves.toMatchObject({ ok: true });
  expect(refreshCurrent).toHaveBeenCalledTimes(2);
  expect(handler).not.toHaveBeenCalled();
}));

it("refuses unrenderable hook output on both approval surfaces before it reaches a card", () => withOutputExecutor({
  args: plainArgs, rewrite: { ...plainArgs, body: "Hidden\u200btext" },
}, async fixture => {
  const { gate, h, handler, hooks, surface } = fixture;
  const page = outputPhonePage("display-page");
  gate.listRequestedOutputCards(page);
  const run = { itemId: 1, runId: "delivery", runKey: "delivery" };
  const { toolName, owner, ownerId } = PLUGIN_OUTPUT;
  const request = await hooks.accept({ stage: stageOf("review", { requestedOutputs: [PLUGIN_OUTPUT] }), workspaceRoot: h.dir,
    run, raw: { toolName, owner, ownerId, args: plainArgs, summary: "Deliver" } });
  if (!request.ok) throw new Error(request.code);
  const signal = new AbortController().signal;
  await expect(hooks.execute({ run, stageId: "review", output: request.output, approvalSurface: surface,
    binding: { itemId: run.itemId, runId: run.runId, stageId: "review", attempt: 1, resultHash: "result", outputHash: "outputs" },
    workspace: { root: h.dir }, canExecute: () => true, signal, authority: signal }))
    .resolves.toMatchObject({ status: "failed", detail: "output-args-not-displayable" });
  expect(gate.listRequestedOutputCards(page)).toEqual([]);
  expect(fixture.events).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
}));

const OUTPUT_SOURCE_PATHS = [
  "../../work-board/workflow/requested-outputs.ts",
  "../../work-board/workflow/requested-output-retry.ts",
  "../../boot/steps/workflow-output-invocation.ts",
];

it("keeps requested output modules outside filesystem and operand binding", () => {
  const forbidden = /["'](?:node:(?:fs(?:\/promises)?|os)|[^"'\n]*\/(?:atomic-file|workspace-seed|owned-fs|asrt-sandbox|path-extraction|plugin-mcp-host|plugin-install-receipt)(?:\.js)?)["']/u;
  for (const path of OUTPUT_SOURCE_PATHS) {
    expect(readFileSync(new URL(path, import.meta.url), "utf8"), path).not.toMatch(forbidden);
  }
});

type OutputCase = NonNullable<Parameters<typeof withOutputExecutor>[0]>;
const plainArgs = { body: "Ready", path: "reports/latest.txt", fields: { count: 42, locale: "한글", amounts: [0.125, -3] } };
const longArgs = { body: `${"Review ".repeat(90)}end`, path: "/example/report.txt" };
const cases: ReadonlyArray<[string, OutputCase]> = [
  ["upload", { args: plainArgs, kind: "upload" }],
  ["other", { args: plainArgs, kind: "other" }],
  ["long MCP input", { args: longArgs, owner: "server" }],
  ["a plugin from a git install", { args: plainArgs, install: "git" }],
  ["a plugin from a folder install", { args: plainArgs, install: "folder" }],
];
it.each(cases)("shows and executes identical args for %s after the ordinary approval", (_name, opts) => withOutputExecutor(opts, async fixture => {
  const { hooks, h, handler, shown, events, executor } = fixture;
  const decl = { ...PLUGIN_OUTPUT, owner: opts.owner ?? "plugin", kind: opts.kind ?? "upload" };
  const run = { itemId: 1, runId: "delivery", runKey: "delivery", ...(opts.owner === "server" && { projectRoot: h.dir }) };
  const request = await hooks.accept({ stage: stageOf("review", { requestedOutputs: [decl] }), workspaceRoot: h.dir, run,
    raw: { toolName: decl.toolName, owner: decl.owner, ownerId: decl.ownerId, args: opts.args, summary: "Deliver" } });
  if (!request.ok) throw new Error(request.code);

  const fsFrames: string[] = [];
  const recordOutputFrames = <Args extends unknown[], Result>(operation: (...args: Args) => Result) => (...args: Args): Result => {
    const frames = new Error().stack ?? "";
    if (OUTPUT_SOURCE_PATHS.some(path => frames.includes(path.slice(5)))) fsFrames.push(frames);
    return operation(...args);
  };
  const observeRealpath = recordOutputFrames(fsPromises.realpath) as typeof fsPromises.realpath;
  const observeMkdtemp = recordOutputFrames(fsPromises.mkdtemp) as typeof fsPromises.mkdtemp;
  const observeReadFile = recordOutputFrames(fs.readFileSync) as typeof fs.readFileSync;
  const realpath = vi.spyOn(fsPromises, "realpath").mockImplementation(observeRealpath);
  const mkdtemp = vi.spyOn(fsPromises, "mkdtemp").mockImplementation(observeMkdtemp);
  const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(observeReadFile);
  try {
    const pending = hooks.execute({ run, stageId: "review", output: request.output, approvalSurface: fixture.surface,
      binding: { itemId: run.itemId, runId: run.runId, stageId: "review", attempt: 1, resultHash: "result", outputHash: "outputs" },
      workspace: { root: h.dir }, canExecute: () => true, signal: new AbortController().signal, authority: new AbortController().signal });
    const card = await Promise.race([shown, pending.then(() => undefined)]);
    expect(card).toBeDefined();
    if (!card) throw new Error("The tool did not ask for approval");
    expect(canonicalWorkflowJson(card.args)).toBe(request.output.args);
    expect(events).toEqual(["card shown"]);
    expect(handler).not.toHaveBeenCalled();
    expect(executor.executeAll).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ executionCwd: run.projectRoot ?? DEFAULT_WORKSPACE }));
    answerOutput(fixture, card);
    await expect(pending).resolves.toMatchObject({ status: "done" });
    expect(handler).toHaveBeenCalledExactlyOnceWith(decl.toolName, opts.args);
    expect(canonicalWorkflowJson(handler.mock.calls[0][1])).toBe(request.output.args);
    expect(events).toEqual(["card shown", "card answered", "approvedInvocation", "handler"]);
    expect(fsFrames).toEqual([]);
  } finally {
    readFile.mockRestore();
    mkdtemp.mockRestore();
    realpath.mockRestore();
  }
}));

async function openOutputGate(fixture: OutputExecutorFixture, count = 1, later: TemplateStage[] = [], args = plainArgs) {
  const { h, surface } = fixture;
  const version = await h.confirm([stageOf("review", { requestedOutputs: [PLUGIN_OUTPUT] }), ...later]);
  const itemId = await h.addItem(version);
  const started = h.start(itemId, h.local(version));
  const [child] = await h.untilLive(1);
  const { toolName, owner, ownerId } = PLUGIN_OUTPUT;
  for (let n = 0; n < count; n++) {
    await expect(child.input.stageOutputTool?.execute({ toolName, owner, ownerId, args, summary: "Deliver" },
      { cwd: child.input.projectRoot ?? "", metadata: {}, extraAllowedDirectories: [] })).resolves.toMatchObject({ isError: false });
  }
  child.finish({ summary: "Ready" });
  await expect(started).resolves.toMatchObject({ status: "awaiting_approval" });
  const item = await h.item(itemId);
  const stage = item.stageRuns.find(run => run.stageId === "review");
  if (!stage) throw new Error("Missing review stage");
  const outputHash = requestedOutputHash(stage);
  if (!item.runId || !stage.resultHash || !outputHash) throw new Error("Missing gate binding");
  const binding = { runId: item.runId, stageId: "review", attempt: stage.attempt, resultHash: stage.resultHash,
    outputHash, decision: "approve" } as const;
  securitySettingsGestures.observe(surface);
  (surface as unknown as EventEmitter).emit("before-mouse-event", {}, { type: "mouseUp" });
  const proof = securitySettingsGestures.consume(surface, { channel: WORK_BOARD.decideStage, payload: workBoardDecisionKey(WORK_BOARD.decideStage, itemId, binding) });
  if (!proof) throw new Error("Missing approval gesture");
  const decision = h.engine.decideStageGate(itemId, binding, { kind: "local-desktop", receipt: { surface, proof } });
  const card = await Promise.race([fixture.shown, decision.then(() => undefined)]);
  if (!card) throw new Error("The output did not reach its approval card");
  expect(fixture.handler).not.toHaveBeenCalled();
  return { itemId, card, decision, binding };
}

it("a hook that rewrites the input ends the output failed and the handler never runs", () => withOutputExecutor({
  args: plainArgs, rewrite: true,
}, async fixture => {
  const { itemId, card, decision } = await openOutputGate(fixture);
  expect(card.args).toMatchObject({ body: "Changed by hook" });
  answerOutput(fixture, card);
  await expect(decision).resolves.toMatchObject({ ok: true });
  expect((await fixture.h.stageRun(itemId, "review")).outputExecutions)
    .toMatchObject([{ status: "failed", detail: "output-execution-not-dispatched" }]);
  expect(fixture.handler).not.toHaveBeenCalled();
}));

it("a changed tool registration prevents dispatch after the card is answered", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { itemId, card, decision } = await openOutputGate(fixture);
  const original = fixture.registry.findByName(PLUGIN_OUTPUT.toolName);
  if (!original) throw new Error("Missing registered tool");
  fixture.registry.reservePluginReplacement(PLUGIN_OUTPUT.ownerId, [{ ...original }], []).publish();
  answerOutput(fixture, card);
  await expect(decision).resolves.toMatchObject({ ok: true });
  expect((await fixture.h.stageRun(itemId, "review")).outputExecutions).toMatchObject([{ status: "failed" }]);
  expect(fixture.handler).not.toHaveBeenCalled();
}));

it.each(["Stop", "row removal"] as const)("%s cancels an unanswered output card", action => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { h, settled, gate, handler } = fixture;
  const { itemId, card, decision, binding: { runId } } = await openOutputGate(fixture, 2);
  expect(gate.pendingCount).toBe(1);
  const writes = vi.spyOn(h.board, "updateRun");
  try {
    if (action === "Stop") {
      expect(h.engine.cancelRun(itemId)).toEqual({ ok: true });
      expect(h.board.runAuthority(itemId, runId).aborted).toBe(true);
    } else {
      await expect(h.board.remove(itemId)).resolves.toMatchObject({ status: "deleted" });
    }
    await expect(settled).resolves.toBe(card.id);
    expect(gate.pendingCount).toBe(0);
    await expect(decision).resolves.toMatchObject({ ok: true });
    expect(handler).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["card shown"]);
    if (action === "Stop") {
      await h.until(itemId, row => row.runStatus === "cancelled");
      expect(h.workspaceCalls.filter(call => call.startsWith("integrate:"))).toEqual([]);
      expect((await h.stageRun(itemId, "review")).outputExecutions)
        .toMatchObject([
          { status: "failed", detail: "output-execution-interrupted" },
          { status: "failed", detail: "output-execution-interrupted" },
        ]);
    } else {
      await h.waitForProgress(event => event.itemId === itemId && event.phase === "cancelled", "row removal settled");
      expect(writes).not.toHaveBeenCalled();
    }
  } finally {
    writes.mockRestore();
  }
}));

it("refuses Allow after deletion commits while both removal subscribers are pending", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { h, gate, handler } = fixture;
  const { itemId, card, decision, binding } = await openOutputGate(fixture);
  const release = deferred<void>();
  const classify = h.board.runClasses.bind(h.board);
  const readIntents = h.board.deleteIntentsOnDisk.bind(h.board);
  const classes = vi.spyOn(h.board, "runClasses").mockImplementation(async (...args) => {
    await release.promise;
    return classify(...args);
  });
  const intents = vi.spyOn(h.board, "deleteIntentsOnDisk").mockImplementation(async () => {
    await release.promise;
    return readIntents();
  });
  try {
    await expect(h.board.remove(itemId)).resolves.toMatchObject({ status: "deleted" });
    expect(classes).toHaveBeenCalled();
    expect(intents).toHaveBeenCalled();
    // Revoked inside the deleting commit, while neither subscriber has seen the delete; the output holds that same signal.
    expect(h.board.runAuthority(itemId, binding.runId).aborted).toBe(true);
    expect(fixture.authorities).toEqual([h.board.runAuthority(itemId, binding.runId)]);
    expect(gate.pendingCount).toBe(0);
    answerOutput(fixture, card);
    await expect(decision).resolves.toMatchObject({ ok: true });
    expect(fixture.events).toEqual(["card shown", "card answered"]);
    expect(handler).not.toHaveBeenCalled();
    expect(h.workspaceCalls.filter(call => call.startsWith("integrate:"))).toEqual([]);
  } finally {
    release.resolve();
    classes.mockRestore();
    intents.mockRestore();
  }
}));

/** Retry the output `outputId` of the gated stage with a fresh gesture, up to its approval card. */
async function openRetryCard(fixture: OutputExecutorFixture, itemId: number, binding: Awaited<ReturnType<typeof openOutputGate>>["binding"], outputId: string) {
  const { h, surface } = fixture;
  const { runId, stageId, attempt, outputHash } = binding;
  const input = { runId, stageId, attempt, outputHash, outputId };
  (surface as unknown as EventEmitter).emit("before-mouse-event", {}, { type: "mouseUp" });
  const proof = securitySettingsGestures.consume(surface, { channel: WORK_BOARD.retryOutput, payload: workBoardDecisionKey(WORK_BOARD.retryOutput, itemId, input) });
  if (!proof) throw new Error("Missing retry gesture");
  const shown = fixture.nextApproval();
  const retry = h.engine.retryOutput(itemId, input, { surface, proof });
  const retryCard = await Promise.race([shown, retry.then(() => undefined)]);
  if (!retryCard) throw new Error("The retry did not reach its approval card");
  return { retry, retryCard };
}

it("refuses Allow on a detached retry after its completed run's row is deleted", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { h, gate, handler } = fixture;
  const { itemId, card, decision, binding } = await openOutputGate(fixture);
  answerOutput(fixture, card, "deny-once");
  await expect(decision).resolves.toMatchObject({ ok: true });
  await h.until(itemId, row => row.runStatus === "completed");
  const [outcome] = (await h.stageRun(itemId, binding.stageId)).outputExecutions ?? [];
  expect(outcome).toMatchObject({ status: "denied" });
  const { retry, retryCard } = await openRetryCard(fixture, itemId, binding, outcome.id);
  await expect(h.board.remove(itemId)).resolves.toMatchObject({ status: "deleted" });
  expect(gate.pendingCount).toBe(0);
  answerOutput(fixture, retryCard);
  await expect(retry).resolves.toEqual({ ok: false, reason: "run_mismatch" });
  expect(handler).not.toHaveBeenCalled();
}));

it("keeps a retry opened during an active run revoked after Stop settles that run", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { h, gate, handler } = fixture;
  const { itemId, card, decision, binding } = await openOutputGate(fixture, 1, [stageOf("build", { inputs: ["review"] })]);
  answerOutput(fixture, card, "deny-once");
  await expect(decision).resolves.toMatchObject({ ok: true });
  await h.untilStage(itemId, "build", "running");
  const [outcome] = (await h.stageRun(itemId, binding.stageId)).outputExecutions ?? [];
  expect(outcome).toMatchObject({ status: "denied" });
  const { retry, retryCard } = await openRetryCard(fixture, itemId, binding, outcome.id);
  expect(h.engine.cancelRun(itemId)).toEqual({ ok: true });
  await h.until(itemId, row => row.runStatus === "cancelled");
  await h.drainRunWork();
  expect(gate.pendingCount).toBe(0);
  answerOutput(fixture, retryCard);
  await retry;
  expect(fixture.events.at(-1)).toBe("card answered");
  expect(handler).not.toHaveBeenCalled();
  expect((await h.stageRun(itemId, binding.stageId)).outputExecutions).toMatchObject([{ status: "failed" }]);
  // The retry holds the run's own authority, which Stop revoked and the run's settlement left revoked.
  expect(fixture.authorities.at(-1)).toBe(h.board.runAuthority(itemId, binding.runId));
  expect(fixture.authorities.at(-1)?.aborted).toBe(true);
  const fresh = await openRetryCard(fixture, itemId, binding, outcome.id);
  answerOutput(fixture, fresh.retryCard);
  await expect(fresh.retry).resolves.toEqual({ ok: true });
  expect(handler).toHaveBeenCalledOnce();
}));

it("a failed delete invalidates an open retry and permits a fresh approval on the retained settled run", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const { h, handler } = fixture;
  const { itemId, card, decision, binding } = await openOutputGate(fixture);
  answerOutput(fixture, card, "deny-once");
  await expect(decision).resolves.toMatchObject({ ok: true });
  await h.until(itemId, row => row.runStatus === "completed");
  const [outcome] = (await h.stageRun(itemId, binding.stageId)).outputExecutions ?? [];
  const open = await openRetryCard(fixture, itemId, binding, outcome.id);
  const rename = fsPromises.rename.bind(fsPromises);
  const renames = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (to === h.boardPath) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return rename(from, to);
  });
  try {
    await expect(h.board.remove(itemId)).rejects.toThrow("no space left on device");
  } finally {
    renames.mockRestore();
  }
  answerOutput(fixture, open.retryCard);
  await open.retry;
  expect(handler).not.toHaveBeenCalled();
  const fresh = await openRetryCard(fixture, itemId, binding, outcome.id);
  answerOutput(fixture, fresh.retryCard);
  await expect(fresh.retry).resolves.toEqual({ ok: true });
  expect(handler).toHaveBeenCalledOnce();
}));

it("refuses tool execution without an approval surface", () => withOutputExecutor({ args: plainArgs }, async fixture => {
  const run = { itemId: 1, runId: "delivery", runKey: "delivery" };
  const { toolName, owner, ownerId } = PLUGIN_OUTPUT;
  const request = await fixture.hooks.accept({ stage: stageOf("review", { requestedOutputs: [PLUGIN_OUTPUT] }),
    workspaceRoot: fixture.h.dir, run, raw: { toolName, owner, ownerId, args: plainArgs, summary: "Deliver" } });
  if (!request.ok) throw new Error(request.code);
  await expect(fixture.hooks.execute({ run, stageId: "review", output: request.output, approvalSurface: null,
    workspace: { root: fixture.h.dir }, canExecute: () => true, signal: new AbortController().signal, authority: new AbortController().signal }))
    .resolves.toMatchObject({ status: "denied", detail: "user-gesture-required" });
  expect(fixture.handler).not.toHaveBeenCalled();
}));

it.each([
  "output-not-declared", "remote-not-configured", "too-many", "args-too-large", "needs-human-gate",
  "output-remote-local-unsupported", "output-args-not-displayable", "output-execution-failed",
  "output-execution-interrupted", "workspace-unavailable", "user-gesture-required", "requested-output-card-unavailable",
  "push-url-unverified", "push-url-changed", "push-ref-changed", "push-authentication", "push-non-fast-forward", "push-failed",
] as const)("localizes the requested output reason %s in both catalogs", code => {
  expect(en[`reasonCodes.${code}`]).toBeTruthy();
  expect(ko[`reasonCodes.${code}`]).toBeTruthy();
});
