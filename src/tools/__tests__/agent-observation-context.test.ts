import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentObservationFixture } from "../../__tests__/support/agent-observation.js";

import { checkpointFileMutation } from "../../memory/code-checkpoints.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import type { ObservationIdentity } from "../../shared/agent-observation.js";
import {
  currentAgentObservationIdentity,
  drainAgentObservationHome,
  observeAgentDocumentMutation,
  registerAgentObservationHome,
  runWithAgentObservationInvocation,
  runWithAgentObservationTurn,
  setAgentObservationSink,
  type AgentObservationSink,
  type ObservedFileEffect,
} from "../agent-observation-context.js";
import { MoveFileTool, WriteFileTool } from "../file-tools.js";

const TURN = { sessionId: "document-session", turnId: "document-turn" };
const INVOCATION = { sessionId: "document-session", toolUseId: "document-tool" };
const IDENTITY = { ...TURN, toolUseId: "document-tool" };
const admitted = agentObservationFixture(IDENTITY);

let directory: string;
let sink: AgentObservationSink;
let finishMutation: ReturnType<typeof vi.fn<(completed: boolean) => Promise<void>>>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ave-observation-context-"));
  finishMutation = vi.fn(async (_completed: boolean) => {});
  sink = {
    openJournal: vi.fn(() => ({ poll: vi.fn(), finish: vi.fn(async () => {}), dispose: vi.fn() })),
    beforeMutation: vi.fn(async () => finishMutation),
    finishInvocation: vi.fn(async () => {}),
    revokeInvocation: vi.fn(),
    finishTurn: vi.fn(),
  };
  setAgentObservationSink(sink);
});

afterEach(async () => {
  drainAgentObservationHome(directory);
  setAgentObservationSink(undefined);
  await rm(directory, { recursive: true, force: true });
});


describe("agent document observation context", () => {
  it("does not derive observation authority from file-tool metadata", async () => {
    const path = join(directory, "notes.txt");
    const result = await new WriteFileTool().execute({ path, content: "user content" }, {
      cwd: directory,
      extraAllowedDirectories: [],
      metadata: { ...IDENTITY, actor: "agent" },
    });
    expect(result.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("user content");
    expect(sink.beforeMutation).not.toHaveBeenCalled();
    expect(currentAgentObservationIdentity()).toBeUndefined();
  });

  it("does not admit a tool invocation outside a model turn", async () => {
    await runWithAgentObservationInvocation(INVOCATION, async () => {
      expect(currentAgentObservationIdentity()).toBeUndefined();
      await observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "data" }], async () => {});
      registerAgentObservationHome(directory);
    }, directory);
    expect(sink.openJournal).not.toHaveBeenCalled();
    expect(sink.beforeMutation).not.toHaveBeenCalled();
    expect(sink.finishInvocation).not.toHaveBeenCalled();
  });

  it("binds a matching authorized invocation to its model turn", async () => {
    const result = await admitted(async () => {
      expect(currentAgentObservationIdentity()).toEqual({
        sessionId: "document-session", turnId: "document-turn", toolUseId: "document-tool",
      });
      expect(Object.isFrozen(currentAgentObservationIdentity())).toBe(true);
      return "observed";
    });
    expect(result).toBe("observed");
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "document-session", turnId: "document-turn", toolUseId: "document-tool",
    });
    expect(sink.finishTurn).toHaveBeenCalledExactlyOnceWith("document-session", "document-turn");
    expect(currentAgentObservationIdentity()).toBeUndefined();
  });

  it.each(["ui", "mcp-app"] as const)("excludes the %s origin inside a model turn", async (origin) => {
    await runWithAgentObservationTurn(TURN, () => runWithInvocationOrigin(origin, undefined, () =>
      runWithAgentObservationInvocation(INVOCATION, async () => {
        expect(currentAgentObservationIdentity()).toBeUndefined();
        registerAgentObservationHome(directory);
        await observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "user" }], async () => {});
      }, directory),
    ));
    expect(sink.openJournal).not.toHaveBeenCalled();
    expect(sink.beforeMutation).not.toHaveBeenCalled();
    expect(sink.finishInvocation).not.toHaveBeenCalled();
  });

  it.each(["ui", "mcp-app"] as const)("does not inherit outer agent authority in a nested %s call", async (origin) => {
    await admitted(async () => {
      await runWithInvocationOrigin(origin, undefined, () => runWithAgentObservationInvocation(INVOCATION, async () => {
        expect(currentAgentObservationIdentity()).toBeUndefined();
        await observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "user" }], async () => {});
      }));
      expect(currentAgentObservationIdentity()).toEqual(IDENTITY);
    });
    expect(sink.beforeMutation).not.toHaveBeenCalled();
    expect(sink.finishInvocation).toHaveBeenCalledTimes(1);
  });

  it("does not carry an outer identity across a mismatched session", async () => {
    await admitted(async () => {
      await runWithAgentObservationInvocation({ sessionId: "other-session", toolUseId: "other-tool" }, async () => {
        expect(currentAgentObservationIdentity()).toBeUndefined();
        await observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "other" }], async () => {});
      });
      expect(currentAgentObservationIdentity()).toEqual(IDENTITY);
    });
    expect(sink.beforeMutation).not.toHaveBeenCalled();
    expect(sink.finishInvocation).toHaveBeenCalledTimes(1);
  });

  it("rejects direct user-origin mutation callbacks inside an outer agent invocation", async () => {
    await admitted(() => runWithInvocationOrigin("ui", undefined, async () => {
      expect(currentAgentObservationIdentity()).toBeUndefined();
      registerAgentObservationHome(directory);
      await observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "user" }], async () => {});
    }));
    expect(sink.openJournal).not.toHaveBeenCalled();
    expect(sink.beforeMutation).not.toHaveBeenCalled();
  });

  it("restores the parent identity after a matching nested invocation", async () => {
    await admitted(async () => {
      await runWithAgentObservationInvocation({ sessionId: "document-session", toolUseId: "nested-tool" }, async () => {
        expect(currentAgentObservationIdentity()).toEqual({
          sessionId: "document-session", turnId: "document-turn", toolUseId: "nested-tool",
        });
      });
      expect(currentAgentObservationIdentity()).toEqual(IDENTITY);
    });
    expect(sink.finishInvocation).toHaveBeenNthCalledWith(1, {
      sessionId: "document-session", turnId: "document-turn", toolUseId: "nested-tool",
    });
    expect(sink.finishInvocation).toHaveBeenNthCalledWith(2, IDENTITY);
  });

  it("settles invocation and turn callbacks after the operation rejects", async () => {
    await expect(admitted(async () => { throw new Error("operation refused"); })).rejects.toThrow("operation refused");
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.finishTurn).toHaveBeenCalledExactlyOnceWith("document-session", "document-turn");
    expect(currentAgentObservationIdentity()).toBeUndefined();
  });

  it("registers a prepared HOME only during admitted execution", async () => {
    registerAgentObservationHome(directory);
    expect(sink.openJournal).not.toHaveBeenCalled();
    await runWithAgentObservationTurn(TURN, () => runWithAgentObservationInvocation(INVOCATION, async () => {
      expect(sink.openJournal).toHaveBeenCalledExactlyOnceWith(IDENTITY, directory);
      registerAgentObservationHome(directory);
      expect(sink.openJournal).toHaveBeenCalledTimes(1);
    }, directory));
  });

  it("settles invocation callbacks when opening its prepared journal fails", async () => {
    const run = vi.fn(async () => {});
    sink.openJournal = vi.fn(() => { throw new Error("journal refused"); });
    await expect(runWithAgentObservationTurn(TURN, () =>
      runWithAgentObservationInvocation(INVOCATION, run, directory),
    )).rejects.toThrow("journal refused");
    expect(run).not.toHaveBeenCalled();
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.finishTurn).toHaveBeenCalledExactlyOnceWith("document-session", "document-turn");
  });

  it("revokes a settled invocation identity retained by detached asynchronous work", async () => {
    let resume!: () => void;
    let later!: Promise<ObservationIdentity | undefined>;
    await runWithAgentObservationTurn(TURN, async () => {
      await runWithAgentObservationInvocation(INVOCATION, async () => {
        later = new Promise<void>((resolve) => { resume = resolve; })
          .then(() => currentAgentObservationIdentity());
      });
      resume();
      expect(await later).toBeUndefined();
    });
  });

  it("revokes a settled turn identity retained by an unfinished child operation", async () => {
    let resume!: () => void;
    let later!: Promise<ObservationIdentity | undefined>;
    await runWithAgentObservationTurn(TURN, async () => {
      later = runWithAgentObservationInvocation(INVOCATION, async () => {
        await new Promise<void>((resolve) => { resume = resolve; });
        return currentAgentObservationIdentity();
      });
    });
    resume();
    expect(await later).toBeUndefined();
  });

  it("revokes an unfinished invocation's journal lease before ending its turn", async () => {
    let resume!: () => void;
    let later!: Promise<void>;
    await runWithAgentObservationTurn(TURN, async () => {
      later = runWithAgentObservationInvocation(INVOCATION, async () => {
        await new Promise<void>((resolve) => { resume = resolve; });
        expect(currentAgentObservationIdentity()).toBeUndefined();
      }, directory);
      expect(sink.openJournal).toHaveBeenCalledExactlyOnceWith(IDENTITY, directory);
    });
    expect(sink.revokeInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.finishInvocation).not.toHaveBeenCalled();
    expect(vi.mocked(sink.revokeInvocation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(sink.finishTurn).mock.invocationCallOrder[0]);
    resume();
    await later;
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.revokeInvocation).toHaveBeenCalledTimes(1);
  });

  it("revokes the active journal lease immediately on invocation cancellation", async () => {
    const controller = new AbortController();
    await runWithAgentObservationTurn(TURN, () => runWithAgentObservationInvocation(INVOCATION, async () => {
      expect(currentAgentObservationIdentity()).toEqual(IDENTITY);
      controller.abort();
      expect(currentAgentObservationIdentity()).toBeUndefined();
      expect(sink.revokeInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
      expect(sink.finishInvocation).not.toHaveBeenCalled();
    }, directory, controller.signal));
    expect(sink.openJournal).toHaveBeenCalledExactlyOnceWith(IDENTITY, directory);
    expect(sink.revokeInvocation).toHaveBeenCalledTimes(1);
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
  });

  it("refuses already cancelled invocation observation before opening a journal", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {});
    controller.abort();
    await expect(runWithAgentObservationTurn(TURN, () =>
      runWithAgentObservationInvocation(INVOCATION, run, directory, controller.signal),
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    expect(sink.openJournal).not.toHaveBeenCalled();
    expect(sink.revokeInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(sink.finishTurn).toHaveBeenCalledExactlyOnceWith("document-session", "document-turn");
  });

  it("observes exact mutation effects even when there is no checkpoint ledger turn", async () => {
    const path = join(directory, "book.xlsx");
    await writeFile(path, "before");
    const order: string[] = [];
    sink.beforeMutation = vi.fn(async (identity: ObservationIdentity, effects: readonly ObservedFileEffect[]) => {
      expect(identity).toEqual(IDENTITY);
      expect(effects).toEqual([{ path, content: "after" }]);
      expect(await readFile(path, "utf8")).toBe("before");
      order.push("before");
      return async (completed: boolean) => {
        expect(completed).toBe(true);
        expect(await readFile(path, "utf8")).toBe("after");
        order.push("settled");
      };
    });
    await admitted(() => checkpointFileMutation([{ path, content: "after" }], async () => {
      order.push("mutation");
      await writeFile(path, "after");
    }));
    expect(order).toEqual(["before", "mutation", "settled"]);
    expect(sink.beforeMutation).toHaveBeenCalledTimes(1);
  });

  it("settles a failed native mutation without recording it as completed", async () => {
    await expect(admitted(() => checkpointFileMutation([{ path: join(directory, "book.xlsx"), content: "after" }], async () => {
      throw new Error("write refused");
    }))).rejects.toThrow("write refused");
    expect(finishMutation).toHaveBeenCalledExactlyOnceWith(false);
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
  });

  it("does not attribute a refused native move with an unchanged destination", async () => {
    const source = join(directory, "source.txt");
    const destination = join(directory, "destination.txt");
    await writeFile(source, "unchanged");
    await writeFile(destination, "unchanged");
    const result = await admitted(() => new MoveFileTool().execute({
      sourcePath: source, destinationPath: destination, overwrite: false,
    }, { cwd: directory, extraAllowedDirectories: [], metadata: { ...IDENTITY } }));
    expect(result.isError).toBe(true);
    expect(await readFile(source, "utf8")).toBe("unchanged");
    expect(await readFile(destination, "utf8")).toBe("unchanged");
    expect(sink.beforeMutation).toHaveBeenCalledExactlyOnceWith(IDENTITY, [
      { path: source, content: null }, { path: destination, copyFrom: source },
    ]);
    expect(finishMutation).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not confirm a native mutation whose invocation was revoked before completion", async () => {
    const path = join(directory, "book.xlsx");
    const controller = new AbortController();
    await writeFile(path, "before");
    await runWithAgentObservationTurn(TURN, () => runWithAgentObservationInvocation(INVOCATION, () =>
      checkpointFileMutation([{ path, content: "after" }], async () => {
        controller.abort();
        await writeFile(path, "after");
      }), undefined, controller.signal,
    ));
    expect(await readFile(path, "utf8")).toBe("after");
    expect(sink.beforeMutation).toHaveBeenCalledExactlyOnceWith(IDENTITY, [{ path, content: "after" }]);
    expect(sink.revokeInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
    expect(finishMutation).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not execute a mutation after its observation admission fails", async () => {
    const run = vi.fn(async () => {});
    sink.beforeMutation = vi.fn(async () => { throw new Error("observation refused"); });
    await expect(admitted(() => observeAgentDocumentMutation([{ path: join(directory, "book.xlsx"), content: "after" }], run)))
      .rejects.toThrow("observation refused");
    expect(run).not.toHaveBeenCalled();
    expect(sink.finishInvocation).toHaveBeenCalledExactlyOnceWith(IDENTITY);
  });
});
