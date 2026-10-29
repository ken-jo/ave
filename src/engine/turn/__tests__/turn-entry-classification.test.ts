// Every place that starts or steers a conversation turn, classified by who it speaks for. A turn is the user's own (and may carry the
// host-terminal capability) only when main minted a verified keyboard intent from a payload whose gesture token preload consumed; every
// other entry defaults to a non-user origin. The inventory is derived from the source, so a new entry point that nobody classified
// fails here instead of silently inheriting an origin.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { mintUserKeyboardIntent, spendUserKeyboardIntent } from "../../../shared/chat-origin.js";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** What a source line can do to a turn. A call is counted per file, so a second entry in a classified file needs classifying too. */
const ENTRY_PATTERNS = {
  runTurn: /\.runTurn\(/g,
  runStreamedTurn: /\brunStreamedTurn\(/g,
  queueUserGuidance: /\.queueUserGuidance\(/g,
  queueGuidance: /\.queueGuidance\(/g,
  queueGuidanceWithDisposition: /\.queueGuidanceWithDisposition\(/g,
  mintUserKeyboardIntent: /\bmintUserKeyboardIntent\(/g,
  userKeyboardLiteral: /inputOrigin: "user-keyboard"/g,
} as const;
type EntryKind = keyof typeof ENTRY_PATTERNS;

interface Classified {
  sites: Partial<Record<EntryKind, number>>;
  /** Who the entry speaks for, and how a user origin (if any) is earned. */
  classification: string;
}

const CLASSIFIED: Record<string, Classified> = {
  "ipc/handlers/chat.ts": {
    sites: { runStreamedTurn: 1, mintUserKeyboardIntent: 1 },
    classification: "chat.send (desktop composer, ESC queue, ⌘⏎ inject, send-now, slash commands typed there) and the conversation command "
      + "port: user only when the payload says user-keyboard with userActivation true (preload consumed the gesture token); command-port actors "
      + "(tailnet/platform bridge/surface) get their own non-user origin; queue-auto drains stay queue-auto",
  },
  "ipc/domains/chat.ts": {
    sites: { runStreamedTurn: 3, queueUserGuidance: 1, queueGuidance: 1, mintUserKeyboardIntent: 3, userKeyboardLiteral: 1 },
    classification: "chat.guide: user guidance only with a consumed gesture, otherwise other-principal guidance; edit-resend, continue "
      + "(incl. resume-interrupted and branch auto-continue) and retry-effort: refused without a consumed gesture, else a user turn carrying the "
      + "minted intent (a staged envelope replays under its staged origin); session-goal revival and the parent mailbox turn: agent-message",
  },
  "ipc/domains/sidechat.ts": {
    sites: { runStreamedTurn: 1, mintUserKeyboardIntent: 1 },
    classification: "side-chat and pane-chat send: queue-auto unless the payload says user-keyboard with a consumed gesture; a keyboard claim "
      + "without one is refused",
  },
  "ipc/domains/plugins.ts": {
    sites: { queueGuidance: 1 },
    classification: "plugin/MCP-app card guidance: other-principal guidance, never the user's",
  },
  "ipc/handlers/chat-stream.ts": {
    sites: { runTurn: 1, runStreamedTurn: 1 },
    classification: "the shared streaming wrapper: forwards the caller's origin, and the verified intent only with a user-keyboard origin; "
      + "no default origin",
  },
  "main/exec-mode.ts": {
    sites: { runStreamedTurn: 1, userKeyboardLiteral: 1 },
    classification: "headless `ave exec`: the owner's command-line prompt, proven by a single-use host-minted unattended authority; it never "
      + "gets the host-terminal capability",
  },
  "main/session-goal-revival.ts": {
    sites: { runTurn: 1 },
    classification: "session goal revival: delegates to the chat domain's agent-message turn",
  },
  "routines/routine-engine.ts": {
    sites: { runTurn: 1 },
    classification: "scheduled routines: plugin-emitted",
  },
  "engine/subagent-runner.ts": {
    sites: { runTurn: 2, queueGuidanceWithDisposition: 1 },
    classification: "sub-agent child turns: llm-tool-arg or agent-message; guidance into a running child: agent-message",
  },
  "engine/a2a-subagent-message-bus.ts": {
    sites: { queueGuidanceWithDisposition: 1 },
    classification: "a child's report into its parent's live turn: agent-message guidance",
  },
  "engine/a2a-agent-message-bus.ts": {
    sites: { queueGuidanceWithDisposition: 1 },
    classification: "A2A peer messages: agent-message guidance",
  },
  "permissions/parent-adjudicator.ts": {
    sites: { runTurn: 1 },
    classification: "the adjudicator's own side-turn method (not a ConversationLoop turn); it decides cards, it never types",
  },
  "engine/turn/types.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "documentation of RunTurnOptions.userKeyboardIntent",
  },
  "shared/chat-origin.ts": {
    sites: { mintUserKeyboardIntent: 1, userKeyboardLiteral: 2 },
    classification: "the single mint and the payload check it relies on",
  },
  "tools/pipeline/rationale-control.ts": {
    sites: { userKeyboardLiteral: 2 },
    classification: "the request anchor of a turn already admitted as the user's",
  },
  "preload/gesture-intent.ts": {
    sites: { userKeyboardLiteral: 4 },
    classification: "preload gesture tokens: minted only during an active gesture, consumed once",
  },
  "preload/public-surface.ts": {
    sites: { userKeyboardLiteral: 4 },
    classification: "chat.send/guide/edit-resend/continue/retry bridges: report userActivation from the consumed token only",
  },
  "preload/internal-api-surface.ts": {
    sites: { userKeyboardLiteral: 2 },
    classification: "side-chat send bridge: reports userActivation from the consumed token only; queue-auto otherwise",
  },
  "ui/renderer/types.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "renderer API type of the side-chat send origin",
  },
  "ui/renderer/hooks/use-side-chat.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "side-chat hook: a claim the preload checks against the captured token",
  },
  "ui/renderer/components/Composer.tsx": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the empty snapshot returned when no gesture token can be captured",
  },
  "ui/renderer/components/InputActionBar.tsx": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the bottom send button's empty snapshot when no gesture token can be captured",
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function inventory(): Record<string, Partial<Record<EntryKind, number>>> {
  const found: Record<string, Partial<Record<EntryKind, number>>> = {};
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const sites: Partial<Record<EntryKind, number>> = {};
    for (const [kind, pattern] of Object.entries(ENTRY_PATTERNS) as Array<[EntryKind, RegExp]>) {
      const count = text.match(pattern)?.length ?? 0;
      if (count > 0) sites[kind] = count;
    }
    if (Object.keys(sites).length > 0) found[relative(SRC, file).split(sep).join("/")] = sites;
  }
  return found;
}

describe("turn entry points", () => {
  it("are all classified: a new or extra entry, or a stale classification, fails until someone decides whose turn it is", () => {
    const expected = Object.fromEntries(Object.entries(CLASSIFIED).map(([file, { sites }]) => [file, sites]));
    expect(inventory()).toEqual(expected);
  });

  it("let only the IPC handlers that received a renderer gesture mint a keyboard intent", () => {
    const minting = Object.entries(inventory())
      .filter(([file, sites]) => (sites.mintUserKeyboardIntent ?? 0) > 0 && file !== "shared/chat-origin.ts")
      .map(([file]) => file)
      .sort();
    expect(minting).toEqual(["ipc/domains/chat.ts", "ipc/domains/sidechat.ts", "ipc/handlers/chat.ts"]);
  });
});

describe("keyboard intent minting", () => {
  it.each([
    ["a consumed keyboard gesture", { inputOrigin: "user-keyboard", userActivation: true }, true],
    ["a keyboard claim whose token was not consumed", { inputOrigin: "user-keyboard", userActivation: false }, false],
    ["a keyboard claim with no activation report", { inputOrigin: "user-keyboard" }, false],
    ["a truthy non-boolean activation", { inputOrigin: "user-keyboard", userActivation: "true" }, false],
    ["a queued auto-send, even with activation", { inputOrigin: "queue-auto", userActivation: true }, false],
    ["an agent message", { inputOrigin: "agent-message", userActivation: true }, false],
    ["no payload", undefined, false],
  ])("for %s mints %s", (_label, payload, mints) => {
    expect(mintUserKeyboardIntent(payload) !== undefined).toBe(mints);
  });

  it("spends a minted intent once and never a lookalike", () => {
    const intent = mintUserKeyboardIntent({ inputOrigin: "user-keyboard", userActivation: true });
    expect(spendUserKeyboardIntent(intent)).toBe(true);
    expect(spendUserKeyboardIntent(intent)).toBe(false);
    expect(spendUserKeyboardIntent({ kind: "verified-user-keyboard-intent" })).toBe(false);
    expect(spendUserKeyboardIntent(undefined)).toBe(false);
  });
});
