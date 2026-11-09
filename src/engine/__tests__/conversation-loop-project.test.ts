import { describe, expect, it, vi } from "vitest";
import { ConversationLoop } from "../conversation-loop.js";
import {
  makeConversationLoopDeps,
  makeConversationLoopMemoryManager,
} from "./conversation-loop-test-helpers.js";
import type { ConversationLoopDeps } from "../conversation-loop.js";
import type { LLMProvider } from "../llm/types.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";
import { SubAgentRunner } from "../subagent-runner.js";
import { deferred } from "../../__tests__/support/deferred.js";

function makeProjectLoop(defaultRoot: string) {
  const setProjectContext = vi.fn();
  const systemPromptBuilder = {
    build: () => "system",
    setProjectContext,
  } as unknown as ConversationLoopDeps["systemPromptBuilder"];
  const loop = new ConversationLoop(makeConversationLoopDeps({
    systemPromptBuilder,
    isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
  }));
  return { loop, setProjectContext };
}

function makeRevocableProjectLoop(defaultRoot: string, authorizedRoots: Set<string>) {
  const setProjectContext = vi.fn();
  const broadcastPermissionConfigChanged = vi.fn();
  const systemPromptBuilder = {
    build: () => "system",
    setProjectContext,
  } as unknown as ConversationLoopDeps["systemPromptBuilder"];
  const loop = new ConversationLoop(makeConversationLoopDeps({
    systemPromptBuilder,
    broadcastPermissionConfigChanged,
    getDefaultProject: () => ({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    }),
    isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
    authorizeProject: (projectRoot, projectName) => {
      if (projectRoot === defaultRoot) {
        return { projectRoot, projectName: projectName ?? "workspace", isDefault: true };
      }
      return authorizedRoots.has(projectRoot)
        ? { projectRoot, projectName: projectName ?? "project", isDefault: false }
        : null;
    },
  }));
  return { loop, broadcastPermissionConfigChanged };
}

describe("ConversationLoop project identity", () => {
  it("treats the app-managed workspace root as the default project without persisting a scope flag", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const { loop, setProjectContext } = makeProjectLoop(defaultRoot);

    await loop.newConversation("main", {
      projectRoot: defaultRoot,
      projectName: "workspace",
    });

    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    });
    expect(loop.getSessionProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
    });
    expect(loop.getSessionMemoryProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
      includeUnscoped: true,
    });
    // Default project binding is ambient; explicit project selection must remain distinguishable.
    expect(loop.getSessionProjectIsDefault()).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
  });

  it("does not include legacy unscoped memory for explicit non-default projects", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const { loop, setProjectContext } = makeProjectLoop(defaultRoot);

    await loop.newConversation("main", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });

    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(loop.getSessionMemoryProjectContext()).toEqual({
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    expect(loop.getSessionProjectIsDefault()).toBe(false);
    expect(loop.getSessionExecutionCwd()).toBe("C:\\workspace\\alpha");
  });

  it("rebinds a resumed session without project metadata to the default workspace", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const memoryManager = makeConversationLoopMemoryManager([
      { role: "user", content: "hello" },
    ], "67b72cc9-5409-43e4-8eab-c69e635362b9");
    vi.mocked(memoryManager.sessions.loadSessionMetadata).mockReturnValue({
      sessionKind: "main",
    } as ReturnType<typeof memoryManager.sessions.loadSessionMetadata>);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager,
      getDefaultProject: () => ({
        projectRoot: defaultRoot,
        projectName: "workspace",
        isDefault: true,
      }),
      isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
    }));

    expect(await loop.loadSession("67b72cc9-5409-43e4-8eab-c69e635362b9")).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(defaultRoot);
  });

  it("re-authorizes stored project roots on session resume before granting tool directories", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const deniedRoot = "C:\\private\\denied";
    const setProjectContext = vi.fn();
    const systemPromptBuilder = {
      build: () => "system",
      setProjectContext,
    } as unknown as ConversationLoopDeps["systemPromptBuilder"];
    const memoryManager = makeConversationLoopMemoryManager([
      { role: "user", content: "hello" },
    ], "d50f8c3f-2fe2-4183-8ed0-1e1e442767b1");
    vi.mocked(memoryManager.sessions.loadSessionMetadata).mockReturnValue({
      sessionKind: "main",
      projectRoot: deniedRoot,
      projectName: "denied",
    } as ReturnType<typeof memoryManager.sessions.loadSessionMetadata>);
    const loop = new ConversationLoop(makeConversationLoopDeps({
      memoryManager,
      systemPromptBuilder,
      isDefaultProjectRoot: (projectRoot) => projectRoot === defaultRoot,
      getDefaultProject: () => ({
        projectRoot: defaultRoot,
        projectName: "workspace",
        isDefault: true,
      }),
      authorizeProject: (projectRoot, projectName) =>
        projectRoot === defaultRoot
          ? {
              projectRoot: defaultRoot,
              projectName: projectName ?? "workspace",
              isDefault: true,
            }
          : null,
    }));

    expect(await loop.loadSession("d50f8c3f-2fe2-4183-8ed0-1e1e442767b1")).toBe(true);
    expect(loop.getSessionProjectContext()).toEqual({
      projectRoot: defaultRoot,
      projectName: "workspace",
    });
    expect(loop.getTurnAdditionalDirectories()).toContain(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).not.toContain(deniedRoot);
    expect(setProjectContext).toHaveBeenLastCalledWith({
      projectRoot: defaultRoot,
      projectName: "workspace",
      isDefault: true,
    });
  });

  it("revokes removed-root directories and rebinds the active project to default", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const authorizedRoots = new Set([removedRoot]);
    const { loop, broadcastPermissionConfigChanged } = makeRevocableProjectLoop(
      defaultRoot,
      authorizedRoots,
    );
    await loop.newConversation("main", { projectRoot: removedRoot, projectName: "alpha" });
    loop.addSessionAdditionalDirectory(`${removedRoot}\\docs`);
    loop.addSessionAdditionalDirectory("D:\\shared");
    loop.addTurnAdditionalDirectory(`${removedRoot}\\scratch`);
    loop.addTurnAdditionalDirectory("D:\\turn");
    authorizedRoots.delete(removedRoot);
    broadcastPermissionConfigChanged.mockClear();

    const result = loop.revokeWorkspaceRoot(removedRoot);

    expect(result.projectRebound).toBe(true);
    expect(loop.getSessionExecutionCwd()).toBe(defaultRoot);
    expect(loop.getTurnAdditionalDirectories()).toEqual(
      expect.arrayContaining([defaultRoot, "D:\\shared", "D:\\turn"]),
    );
    expect(loop.getTurnAdditionalDirectories().some((path) => path.startsWith(removedRoot))).toBe(false);
    expect(broadcastPermissionConfigChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps an independently authorized child project when its former parent is removed", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const parentRoot = "C:\\workspace";
    const childRoot = `${parentRoot}\\child`;
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([childRoot]));
    await loop.newConversation("main", { projectRoot: childRoot, projectName: "child" });
    loop.addSessionAdditionalDirectory(`${childRoot}\\session-scope`);
    loop.addTurnAdditionalDirectory(`${childRoot}\\turn-scope`);
    const controller = new AbortController();
    loop.currentAbortController = controller;

    const result = loop.revokeWorkspaceRoot(parentRoot, { preserveRoots: [childRoot] });

    expect(result.projectRebound).toBe(false);
    expect(loop.getSessionExecutionCwd()).toBe(childRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(childRoot);
    expect(loop.getTurnAdditionalDirectories()).toContain(`${childRoot}\\session-scope`);
    expect(loop.getTurnAdditionalDirectories()).toContain(`${childRoot}\\turn-scope`);
    expect(controller.signal.aborted).toBe(false);
  });

  it("does not revoke a segment-prefix sibling", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\app";
    const siblingRoot = "C:\\workspace\\app-old";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([siblingRoot]));
    await loop.newConversation("main", { projectRoot: siblingRoot, projectName: "app-old" });

    const result = loop.revokeWorkspaceRoot(removedRoot);

    expect(result).toEqual({
      sessionDirectoriesRemoved: 0,
      turnDirectoriesRemoved: 0,
      projectRebound: false,
    });
    expect(loop.getSessionExecutionCwd()).toBe(siblingRoot);
  });

  it("does not mistake a nested project's root for membership in its parent project", async () => {
    const parentRoot = "/workspace/alpha";
    const childRoot = `${parentRoot}/child`;
    const { loop } = makeRevocableProjectLoop("/workspace/default", new Set([childRoot]));
    await loop.newConversation("main", { projectRoot: childRoot });
    const controller = new AbortController();
    loop.currentAbortController = controller;
    expect(loop.countTurnsAbortedByWorkspaceRootRemoval(parentRoot)).toBe(0);
    loop.revokeWorkspaceRoot(parentRoot);
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts an affected active turn with the workspace-removal reason", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const authorizedRoots = new Set([removedRoot]);
    const { loop } = makeRevocableProjectLoop(defaultRoot, authorizedRoots);
    await loop.newConversation("main", { projectRoot: removedRoot, projectName: "alpha" });
    const controller = new AbortController();
    loop.currentAbortController = controller;
    authorizedRoots.delete(removedRoot);

    loop.revokeWorkspaceRoot(removedRoot);

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect((controller.signal.reason as Error).message).toBe("workspace-removal");
  });

  it("does not abort an unrelated active turn", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const unrelatedRoot = "D:\\workspace\\beta";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([unrelatedRoot]));
    await loop.newConversation("main", { projectRoot: unrelatedRoot, projectName: "beta" });
    const controller = new AbortController();
    loop.currentAbortController = controller;

    loop.revokeWorkspaceRoot(removedRoot);

    expect(controller.signal.aborted).toBe(false);
  });

  it("keeps an unrelated project turn running when the removed root was in global scope", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const unrelatedRoot = "D:\\workspace\\beta";
    const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([unrelatedRoot]));
    await loop.newConversation("main", { projectRoot: unrelatedRoot, projectName: "beta" });
    const controller = new AbortController();
    loop.currentAbortController = controller;

    // Carry the pre-persist snapshot because the settings list has already shrunk.
    loop.revokeWorkspaceRoot(removedRoot, { globalScopeWasAuthorized: true });

    expect(controller.signal.aborted).toBe(false);
  });

  it("answers whether a removal would stop its turn by the same test the removal aborts by, and never for an idle loop", async () => {
    const defaultRoot = "C:\\Users\\example\\.ave\\workspace";
    const removedRoot = "C:\\workspace\\alpha";
    const unrelatedRoot = "D:\\workspace\\beta";
    const cases = [
      { projectRoot: removedRoot, options: {}, aborts: true },
      { projectRoot: unrelatedRoot, options: {}, aborts: false },
      { projectRoot: unrelatedRoot, options: { globalScopeWasAuthorized: true }, aborts: false },
    ];
    for (const { projectRoot, options, aborts } of cases) {
      const { loop } = makeRevocableProjectLoop(defaultRoot, new Set([projectRoot]));
      await loop.newConversation("main", { projectRoot, projectName: "p" });
      expect(loop.wouldWorkspaceRootRemovalAbortTurn(removedRoot, options)).toBe(false);
      const controller = new AbortController();
      loop.currentAbortController = controller;
      expect(loop.wouldWorkspaceRootRemovalAbortTurn(removedRoot, options)).toBe(aborts);
      loop.revokeWorkspaceRoot(removedRoot, options);
      expect(controller.signal.aborted).toBe(aborts);
    }
  });

  it.each(["main", "subagent"] as const)("aborts project A's %s streaming turn while project B continues to completion", async (kind) => {
    const defaultRoot = "/workspace/default";
    const removedRoot = "/workspace/alpha";
    const otherRoot = "/workspace/beta";
    const authorizedRoots = new Set([removedRoot, otherRoot]);
    const running = [removedRoot, otherRoot].map((projectRoot) => {
      const { loop } = makeRevocableProjectLoop(defaultRoot, authorizedRoots);
      loop.initializeConversation(kind, { projectRoot });
      // Even a turn with explicit access to A still belongs to B.
      loop.addSessionAdditionalDirectory(removedRoot);
      loop.addTurnAdditionalDirectory(`${removedRoot}/scratch`);
      loop.deps.additionalDirectories = [removedRoot];
      loop.deps.getAdditionalDirectories = () => [...authorizedRoots];
      const started = deferred<void>();
      const finish = deferred<void>();
      const provider: LLMProvider = {
        vendor: "openai",
        async *streamTurn({ abortSignal }) {
          started.resolve();
          yield { type: "text_delta", text: "started " };
          const abort = () => finish.resolve();
          abortSignal?.addEventListener("abort", abort, { once: true });
          try {
            if (!abortSignal?.aborted) await finish.promise;
            abortSignal?.throwIfAborted();
            yield { type: "text_delta", text: "finished" };
            yield { type: "message_complete", stopReason: "end_turn" };
          } finally {
            abortSignal?.removeEventListener("abort", abort);
          }
        },
      };
      (loop as { provider: LLMProvider | null }).provider = provider;
      const turn = loop.runTurn("keep working", undefined, undefined, userKeyboardTurn());
      return { loop, started, finish, turn };
    });
    const [a, b] = running;
    const runner = new SubAgentRunner({} as never);
    const children = (runner as unknown as { activeChildren: Map<string, unknown> }).activeChildren;
    for (const { loop } of running) {
      children.set(loop.sessionId, { childSessionId: loop.sessionId, loop });
    }
    try {
      await Promise.all(running.map(({ started }) => started.promise));
      const options = { globalScopeWasAuthorized: true };
      const previewCount = kind === "subagent"
        ? runner.countTurnsAbortedByWorkspaceRootRemoval(removedRoot, options)
        : running.reduce((count, { loop }) => count + loop.countTurnsAbortedByWorkspaceRootRemoval(removedRoot, options), 0);
      authorizedRoots.delete(removedRoot);
      if (kind === "subagent") runner.revokeWorkspaceRoot(removedRoot, options);
      else for (const { loop } of running) loop.revokeWorkspaceRoot(removedRoot, options);
      expect((await a.turn).stopReason).toBe("interrupted");
      expect(b.loop.hasActiveTurn()).toBe(true);
      expect(b.loop.currentAbortController?.signal.aborted).toBe(false);
      expect(previewCount).toBe(1);
      expect(b.loop.getTurnAdditionalDirectories()).not.toContain(removedRoot);
      expect(b.loop.getTurnAdditionalDirectories()).not.toContain(`${removedRoot}/scratch`);
      b.finish.resolve();
      expect(await b.turn).toMatchObject({ text: "started finished", stopReason: "end_turn" });
    } finally {
      for (const { loop, finish } of running) {
        loop.abortCurrentTurn();
        finish.resolve();
      }
      await Promise.all(running.map(({ turn }) => turn));
    }
  });

  it("allows an idle unbound loop to revoke directory grants without inventing a project", () => {
    const { loop } = makeProjectLoop("/workspace/default");
    loop.addTurnAdditionalDirectory("/workspace/alpha/scratch");
    expect(loop.countTurnsAbortedByWorkspaceRootRemoval("/workspace/alpha")).toBe(0);
    expect(loop.revokeWorkspaceRoot("/workspace/alpha").turnDirectoriesRemoved).toBe(1);
  });

  it.each(["initialization", "refresh"] as const)("cancels project work admitted while provider %s is pending", async (phase) => {
    const root = "/workspace/alpha";
    const authorizedRoots = new Set([root]);
    const { loop } = makeRevocableProjectLoop("/workspace/default", authorizedRoots);
    loop.initializeConversation("main", { projectRoot: root });
    const ready = deferred<void>();
    const streamTurn = vi.fn(async function* () {
      yield { type: "text_delta" as const, text: "must not execute" };
      yield { type: "message_complete" as const, stopReason: "end_turn" as const };
    });
    const provider: LLMProvider = { vendor: "openai", streamTurn };
    loop.provider = phase === "initialization" ? provider : null;
    const waiting = phase === "initialization"
      ? vi.spyOn(loop, "whenProviderReady").mockImplementation(() => ready.promise)
      : vi.spyOn(loop, "refreshProvider").mockImplementation(async () => { await ready.promise; loop.provider = provider; });
    const pending = vi.spyOn(loop, "providerPending", "get").mockReturnValue(phase === "initialization");
    const turn = loop.runTurn("admitted in alpha", undefined, undefined, userKeyboardTurn());
    try {
      expect(waiting).toHaveBeenCalledOnce();
      const count = loop.countTurnsAbortedByWorkspaceRootRemoval(root);
      authorizedRoots.delete(root);
      loop.revokeWorkspaceRoot(root);
      ready.resolve();
      expect((await turn).stopReason).toBe("interrupted");
      expect(streamTurn).not.toHaveBeenCalled();
      expect(count).toBe(1);
      expect(loop.hasActiveTurn()).toBe(false);
      expect((await loop.runTurn("old queued work", undefined, undefined, { inputOrigin: "queue-auto" })).stopReason)
        .toBe("interrupted");
      expect(streamTurn).not.toHaveBeenCalled();
      await loop.newConversation("main");
      loop.provider = provider;
      expect((await loop.runTurn("fresh work", undefined, undefined, userKeyboardTurn())).stopReason)
        .toBe("end_turn");
      expect(streamTurn).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      await turn;
      pending.mockRestore();
      waiting.mockRestore();
    }
  });

  it.each(["main", "routine"] as const)("leaves a legitimately unbound %s turn running during project removal", async (kind) => {
    const { loop } = makeProjectLoop("/workspace/default");
    loop.initializeConversation(kind);
    loop.provider = {
      vendor: "openai",
      async *streamTurn() {
        expect(loop.sessionProjectRoot).toBeNull();
        expect(loop.countTurnsAbortedByWorkspaceRootRemoval("/workspace/alpha")).toBe(0);
        loop.revokeWorkspaceRoot("/workspace/alpha");
        expect(loop.currentAbortController?.signal.aborted).toBe(false);
        yield { type: "text_delta", text: "unbound work completed" };
        yield { type: "message_complete", stopReason: "end_turn" };
      },
    };
    expect(await loop.runTurn("work", undefined, undefined, userKeyboardTurn()))
      .toMatchObject({ text: "unbound work completed", stopReason: "end_turn" });
  });

  it("rejects a project name without a root as an inconsistent binding", () => {
    const { loop } = makeProjectLoop("/workspace/default");
    loop.sessionProjectName = "alpha";
    loop.currentAbortController = new AbortController();
    expect(() => loop.countTurnsAbortedByWorkspaceRootRemoval("/workspace/alpha"))
      .toThrow("Active turn project binding is inconsistent");
  });

  it.each(["", "   ", "relative", "/bad\0root"])("rejects an active turn with an unresolved project root %s before revoking scope", (projectRoot) => {
    const { loop } = makeProjectLoop("/workspace/default");
    loop.sessionProjectRoot = projectRoot;
    loop.addTurnAdditionalDirectory("/workspace/alpha/scratch");
    const controller = new AbortController();
    loop.currentAbortController = controller;
    const options = { globalScopeWasAuthorized: true };
    expect(() => loop.countTurnsAbortedByWorkspaceRootRemoval("/workspace/alpha", options))
      .toThrow("Active turn project root cannot be resolved");
    expect(() => loop.revokeWorkspaceRoot("/workspace/alpha", options))
      .toThrow("Active turn project root cannot be resolved");
    expect(controller.signal.aborted).toBe(false);
    expect(loop.getTurnAdditionalDirectories()).toContain("/workspace/alpha/scratch");
  });
});
