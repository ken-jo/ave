// Only keyboard input may invoke command files; builtins retain precedence over matching filenames.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { GenericMessage, ProviderConfig, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { BUILTIN_SLASH_COMMANDS } from "../commands.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";

const state = vi.hoisted(() => ({ requests: [] as StreamTurnParams[] }));

vi.mock("../../llm/provider-factory.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../llm/provider-factory.js")>(),
  createProvider: (config: ProviderConfig) => ({
    vendor: config.vendor,
    async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
      state.requests.push(params);
      yield { type: "text_delta", text: "done" };
      yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } };
    },
  }),
}));

const originalHome = process.env.AVE_HOME;
let root: string;
let project: string;

function makeLoop(): ConversationLoop {
  const llm = fakeLlmSettings({ model: "gpt-5.4" });
  const loop = new ConversationLoop({
    settingsService: { get: () => llm, getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setToolScope: vi.fn() },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    disableSessionPersistence: true,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  loop.initializeConversation("main", { projectRoot: project, projectName: "project" });
  return loop;
}

function lastUserText(): string {
  const messages = state.requests.at(-1)?.messages ?? [];
  const user = [...messages].reverse().find((message): message is Extract<GenericMessage, { role: "user" }> =>
    message.role === "user");
  const content = user?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

beforeEach(async () => {
  state.requests.length = 0;
  root = await mkdtemp(join(tmpdir(), "ave-custom-command-route-"));
  process.env.AVE_HOME = join(root, "home");
  project = join(root, "project");
  const commands = join(project, ".ave", "commands");
  await mkdir(commands, { recursive: true });
  await writeFile(join(commands, "review.md"), "---\ndescription: Review\n---\nReview pull request $ARGUMENTS carefully.");
  await writeFile(join(commands, "help.md"), "A file cannot take over a built-in.");
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalHome;
  await cleanupTmpDir(root);
});

describe("custom slash commands in a turn", () => {
  it("runs the command file with the typed arguments and shows what was typed", async () => {
    const loop = makeLoop();
    const result = await loop.runTurn("/review 42", undefined, undefined, { ...userKeyboardTurn() });
    expect(result.text).toBe("done");
    expect(result.route).toBe("llm");
    expect(lastUserText()).toContain("Review pull request 42 carefully.");
    const userRow = loop.history.getMessages().find((message) => message.role === "user");
    expect(userRow?.meta?.displayText).toBe("/review 42");
  });

  it("leaves built-in names to the built-in handler", async () => {
    const loop = makeLoop();
    const result = await loop.runTurn("/help", undefined, undefined, { ...userKeyboardTurn() });
    expect(result.route).toBe("command");
    expect(result.text).not.toContain("A file cannot take over a built-in.");
    expect(state.requests).toHaveLength(0);
  });

  it("still reports an unknown command when no file defines it", async () => {
    const result = await makeLoop().runTurn("/nothing-here", undefined, undefined, { ...userKeyboardTurn() });
    expect(result.route).toBe("command");
    expect(result.text).toContain("/nothing-here");
    expect(state.requests).toHaveLength(0);
  });

  it("does not expand a command file for input that did not come from the keyboard", async () => {
    await makeLoop().runTurn("/review 42", undefined, undefined, { inputOrigin: "agent-message" });
    expect(lastUserText()).not.toContain("Review pull request");
  });

  it("keeps the built-in list in step with the command switch", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../commands.ts", import.meta.url), "utf8");
    const handleCommandBody = source.slice(source.indexOf("export async function handleCommand("));
    const switchBody = handleCommandBody.slice(0, handleCommandBody.indexOf("default:"));
    const cases = [...switchBody.matchAll(/^ {6}case "([a-z-]+)":/gmu)].map((match) => match[1]);
    expect(new Set(cases)).toEqual(BUILTIN_SLASH_COMMANDS);
  });
});
