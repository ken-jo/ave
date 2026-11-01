// Every place that starts or steers a conversation turn, classified by who it speaks for. A turn is the user's own (and may carry the
// host-terminal capability) only when main minted a verified keyboard intent from a payload whose gesture token preload consumed; every
// other entry defaults to a non-user origin. The inventory is derived from the compiler's syntax tree of every source file, so a new
// entry point that nobody classified fails here instead of silently inheriting an origin.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";

import { parseSourceFiles, parseSourceTexts } from "../../../../scripts/lib/ts7-ast.mjs";
import { mintUserKeyboardIntent, spendUserKeyboardIntent } from "../../../shared/chat-origin.js";
import type { ConversationLoop } from "../../conversation-loop.js";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

/** The names that start or steer a turn, or mint the keyboard intent. */
const ENTRY_NAMES = [
  "runTurn", "runStreamedTurn", "queueUserGuidance", "queueGuidance", "queueGuidanceWithDisposition", "mintUserKeyboardIntent",
] as const;
type EntryName = typeof ENTRY_NAMES[number];
/**
 * What the inventory counts, per file, on the compiler's syntax tree:
 * - each entry name: every reference spelled by name, as an identifier, a property name or key, an import or export specifier, a
 *   destructuring key, or a string or template literal key, so `loop.runTurn(…)`, `loop?.runTurn?.(…)`, `loop["runTurn"](…)` and
 *   `loop.runTurn.call(…)` are all counted, and so are declarations; then every use of a local alias bound to it
 *   (`const run = loop.runTurn`, `const { runTurn: run } = loop`, `import { mintUserKeyboardIntent as mint }`), followed transitively;
 * - `userKeyboardLiteral`: every `"user-keyboard"` string or template literal;
 * - `computedCall`: every call whose callee is a member chosen by a non-literal key (`loop[name](…)`), and every `Reflect.*` call,
 *   since neither names its target. Such a call can reach an entry without spelling it, so it must be classified like one.
 * A new entry point, an alias of one or a computed call changes a count and fails until it is classified. The one form left out is a
 * computed member read that is stored rather than called (`const f = loop[name]; f()`): bounding it would mean inventorying every
 * indexed read. That form still meets `runTurn`, which refuses a keyboard origin without a spent, host-minted intent, so the runtime
 * check, not this inventory, is what makes a turn the user's.
 */
type EntryKind = EntryName | "userKeyboardLiteral" | "computedCall";
type Sites = Partial<Record<EntryKind, number>>;
const ENTRY_NAME_SET: ReadonlySet<string> = new Set(ENTRY_NAMES);

type Node = ts.Node;
const nameText = (node: Node | undefined): string | undefined => {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
};
/** The text of a key the source spells literally. */
const literalText = (node: Node): string | undefined =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined);
const stripExpression = (node: Node): Node => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
};

/** The entry a value expression refers to: a name, a member by name or literal key, or `.bind(…)` of one. */
function referencedEntry(node: Node, aliases: ReadonlyMap<string, EntryName>): EntryName | undefined {
  const expression = stripExpression(node);
  if (ts.isIdentifier(expression)) return ENTRY_NAME_SET.has(expression.text) ? expression.text as EntryName : aliases.get(expression.text);
  if (ts.isPropertyAccessExpression(expression)) {
    const name = nameText(expression.name);
    if (name !== undefined && ENTRY_NAME_SET.has(name)) return name as EntryName;
  }
  if (ts.isElementAccessExpression(expression)) {
    const key = literalText(expression.argumentExpression);
    if (key !== undefined && ENTRY_NAME_SET.has(key)) return key as EntryName;
  }
  // `entry.bind(…)` is still the entry; any other call's result is a value, not the entry.
  if (ts.isCallExpression(expression)) {
    const callee = stripExpression(expression.expression);
    if (ts.isPropertyAccessExpression(callee) && nameText(callee.name) === "bind") return referencedEntry(callee.expression, aliases);
  }
  return undefined;
}

/**
 * Whether a `"user-keyboard"` literal is a value that could be handed on as an origin. A literal that only names the type, is compared
 * against, or labels a switch case cannot make anything the user's, so it is not counted; every other position is.
 */
function claimsKeyboardOrigin(literal: Node): boolean {
  const parent = (literal as Node & { parent?: Node }).parent;
  if (parent === undefined) return true;
  if (ts.isLiteralTypeNode(parent)) return false;
  if (ts.isCaseClause(parent)) return false;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return !(operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken);
  }
  return true;
}

/** A member key the source does not spell: not a literal, not a number, and not a well-known `Symbol.*`. */
function isComputedKey(key: Node): boolean {
  if (literalText(key) !== undefined || ts.isNumericLiteral(key)) return false;
  const expression = stripExpression(key);
  return !(ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Symbol");
}

function sitesOf(source: Node): Sites {
  const sites: Sites = {};
  const add = (kind: EntryKind) => { sites[kind] = (sites[kind] ?? 0) + 1; };
  // Local aliases, to a fixed point so an alias of an alias is followed too. The declaring identifier itself is not a use.
  const aliases = new Map<string, EntryName>();
  const declaring = new Set<Node>();
  for (let grew = true; grew;) {
    grew = false;
    const bind = (local: Node | undefined, entry: EntryName | undefined) => {
      if (local === undefined || entry === undefined || !ts.isIdentifier(local) || aliases.has(local.text) || ENTRY_NAME_SET.has(local.text)) return;
      aliases.set(local.text, entry);
      declaring.add(local);
      grew = true;
    };
    const collect = (node: Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) bind(node.name, referencedEntry(node.initializer, aliases));
      if (ts.isBindingElement(node)) {
        const key = nameText(node.propertyName ?? node.name);
        if (key !== undefined) bind(node.name, ENTRY_NAME_SET.has(key) ? key as EntryName : aliases.get(key));
      }
      if (ts.isImportSpecifier(node) && node.propertyName !== undefined) {
        const key = nameText(node.propertyName);
        if (key !== undefined && ENTRY_NAME_SET.has(key)) bind(node.name, key as EntryName);
      }
      node.forEachChild(collect);
    };
    collect(source);
  }
  const visit = (node: Node) => {
    const text = nameText(node);
    if (text !== undefined) {
      if (ENTRY_NAME_SET.has(text)) add(text as EntryName);
      else if (ts.isIdentifier(node) && !declaring.has(node) && aliases.has(text)) add(aliases.get(text)!);
      if (text === "user-keyboard" && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && claimsKeyboardOrigin(node)) {
        add("userKeyboardLiteral");
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = stripExpression(node.expression);
      if (ts.isElementAccessExpression(callee) && isComputedKey(callee.argumentExpression)) add("computedCall");
      // `Reflect.get(target, key)` reads a member by a key it does not spell; a spelled key is counted as a name above.
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Reflect"
        && nameText(callee.name) === "get" && node.arguments.length >= 2 && isComputedKey(node.arguments[1]!)) {
        add("computedCall");
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return sites;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function inventory(): Record<string, Sites> {
  const files = sourceFiles(SRC);
  const parsed = parseSourceFiles(files);
  // Every file must parse: an unparsed file would hide its entries.
  expect(files.filter((file) => !parsed.has(file))).toEqual([]);
  const found: Record<string, Sites> = {};
  for (const file of files) {
    const sites = sitesOf(parsed.get(file) as unknown as Node);
    if (Object.keys(sites).length > 0) found[relative(SRC, file).split(sep).join("/")] = sites;
  }
  return found;
}

interface Classified {
  sites: Sites;
  /** Who the entry speaks for, and how a user origin (if any) is earned. */
  classification: string;
}

const CLASSIFIED: Record<string, Classified> = {
  "audit/permission-audit-proof.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the audit-chain self-test row; not a turn origin",
  },
  "boot/node-host-runtime.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a Reflect.get forwarding proxy over a host runtime object; no turn entry",
  },
  "boot/steps/plugin-runtime/host-api-factory.ts": {
    sites: { computedCall: 1 },
    classification: "computed: the plugin HostApi proxy's Reflect.get; plugins reach no turn entry through it",
  },
  "boot/steps/plugin-tool-executor.ts": {
    sites: { userKeyboardLiteral: 3 },
    classification: "the trust origin of forced explicit approval cards a person answers; not a turn origin",
  },
  "core/work-board-engine.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the trust origin of a work-board plan card a person approves; not a turn origin",
  },
  "engine/a2a-agent-message-bus.ts": {
    sites: { queueGuidanceWithDisposition: 2 },
    classification: "A2A peer messages: agent-message guidance",
  },
  "engine/a2a-subagent-message-bus.ts": {
    sites: { queueGuidanceWithDisposition: 1 },
    classification: "a child's report into its parent's live turn: agent-message guidance",
  },
  "engine/conversation-loop.ts": {
    sites: { runTurn: 3, queueGuidance: 1, queueUserGuidance: 1, userKeyboardLiteral: 1, queueGuidanceWithDisposition: 1 },
    classification: "the loop's own declarations: runTurn delegates to run-turn, which refuses a keyboard origin without a spent intent; queueUserGuidance marks the user principal, queueGuidance and queueGuidanceWithDisposition do not",
  },
  "engine/subagent-runner.ts": {
    sites: { queueGuidanceWithDisposition: 1, runTurn: 2 },
    classification: "sub-agent child turns: llm-tool-arg or agent-message; guidance into a running child: agent-message",
  },
  "engine/turn/commands.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "a slash command's permission-mode change, reached only from a turn whose origin admits slash dispatch",
  },
  "engine/turn/query-loop.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "marks a drained guidance batch as the user's only when every entry came through queueUserGuidance",
  },
  "engine/turn/run-turn.ts": {
    sites: { runTurn: 1, userKeyboardLiteral: 2 },
    classification: "runTurn spends the verified intent, refuses an unsigned keyboard origin, and records original user text only after that verification. An admitted, session-bound remote controller turn is the user's (owner decision 2026-11-02): its permission, tool-trust and request-anchor origin is user-keyboard, while the verified-keyboard-intent checks still read the transport origin, so a remote turn never spends or forges a keyboard intent",
  },
  "ipc/domains/chat.ts": {
    sites: { mintUserKeyboardIntent: 5, runStreamedTurn: 4, userKeyboardLiteral: 3, runTurn: 1, queueUserGuidance: 1, queueGuidance: 1 },
    classification: "chat.guide: user guidance only with a consumed gesture, otherwise other-principal guidance. Edit-resend, continue (incl. resume-interrupted) and retry-effort: refused without a consumed gesture, else a user turn carrying the minted intent (a staged envelope replays under its staged origin). Branch-from-checkpoint: mints from its click and holds the intent as a single-use grant for that branch's auto-continue. Session-goal revival and the parent mailbox turn: agent-message",
  },
  "ipc/domains/permissions.ts": {
    sites: { userKeyboardLiteral: 2 },
    classification: "settings-UI permission changes gated by their own consumed gesture and the permission slash dispatched from the settings surface; permission trust origins, not turn origins",
  },
  "ipc/domains/plugins.ts": {
    sites: { queueGuidance: 1 },
    classification: "plugin/MCP-app card guidance: other-principal guidance, never the user's",
  },
  "ipc/domains/sidechat.ts": {
    sites: { runStreamedTurn: 2, mintUserKeyboardIntent: 2, userKeyboardLiteral: 1 },
    classification: "side-chat and pane-chat send: queue-auto unless the payload says user-keyboard with a consumed gesture; a keyboard claim without one is refused",
  },
  "ipc/domains/ui.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a native menu label lookup; no turn entry",
  },
  "ipc/handlers/chat-stream.ts": {
    sites: { runStreamedTurn: 1, runTurn: 1 },
    classification: "the shared streaming wrapper: forwards the caller's origin, and the verified intent only with a user-keyboard origin; no default origin",
  },
  "ipc/handlers/chat.ts": {
    sites: { mintUserKeyboardIntent: 2, runStreamedTurn: 2, userKeyboardLiteral: 1 },
    classification: "chat.send (desktop composer, ESC queue, ⌘⏎ inject, send-now, the bottom button, slash commands typed there) and the conversation command port: user only when the payload says user-keyboard with userActivation true (preload consumed the gesture token); command-port actors (tailnet, platform bridge, surface) get their own non-user origin; queue-auto drains stay queue-auto; the literal names the persona of a keyboard send",
  },
  "main/a2a-remote-runtime.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the trust origin of an A2A remote action card a person approves; not a turn origin",
  },
  "main/exec-mode.ts": {
    sites: { runStreamedTurn: 2, userKeyboardLiteral: 1 },
    classification: "headless `ave exec`: the owner's command-line prompt, proven by a single-use host-minted unattended authority; it never gets the host-terminal capability",
  },
  "main/session-goal-revival.ts": {
    sites: { runTurn: 2 },
    classification: "session goal revival: delegates to the chat domain's agent-message turn",
  },
  "marketplace/log.ts": {
    sites: { computedCall: 2 },
    classification: "computed: a logger method chosen by level; no turn entry",
  },
  "permissions/manifest-integrity.ts": {
    sites: { computedCall: 2 },
    classification: "computed: the frozen-manifest proxy's Reflect.get; no turn entry",
  },
  "permissions/permission-mode-apply.ts": {
    sites: { userKeyboardLiteral: 3 },
    classification: "the trust origin of an explicit user permission-mode action; not a turn origin",
  },
  "permissions/reviewer/risk-classifier.ts": {
    sites: { computedCall: 2 },
    classification: "computed: a command spec's option value checks; no turn entry",
  },
  "plugins/lifecycle-log.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a logger method chosen by level; no turn entry",
  },
  "plugins/plugin-host-effect-scope.ts": {
    sites: { computedCall: 1 },
    classification: "computed: the effect-scope proxy's Reflect.get over a plugin HostApi namespace; no turn entry",
  },
  "preload/gesture-intent.ts": {
    sites: { userKeyboardLiteral: 3 },
    classification: "preload gesture tokens: minted only during an active gesture, consumed once",
  },
  "preload/internal-api-surface.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "side-chat send bridge: reports userActivation from the consumed token only; queue-auto otherwise",
  },
  "preload/public-surface.ts": {
    sites: { userKeyboardLiteral: 5 },
    classification: "chat.send/guide/edit-resend/continue/retry/branch bridges: report userActivation from the consumed token only",
  },
  "routines/routine-engine.ts": {
    sites: { runTurn: 1 },
    classification: "scheduled routines: plugin-emitted",
  },
  "shared/chat-origin.ts": {
    sites: { mintUserKeyboardIntent: 1 },
    classification: "the single mint",
  },
  "shared/development-env-policy.ts": {
    sites: { computedCall: 1 },
    classification: "computed: Reflect.get of a development environment variable; no turn entry",
  },
  "tools/browser-tools.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a browser tool executor chosen by tool name from the browser executor table; no turn entry",
  },
  "tools/pipeline/rationale-control.ts": {
    sites: { userKeyboardLiteral: 2 },
    classification: "the request anchor of a turn already admitted as the user's, and the origin list it validates",
  },
  "ui/renderer/components/Composer.tsx": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the empty snapshot returned when no gesture token can be captured",
  },
  "ui/renderer/components/DocumentEngineInstallContent.tsx": {
    sites: { computedCall: 1 },
    classification: "computed: a document-engine install, cancel or uninstall action on its own API; no turn entry",
  },
  "ui/renderer/components/InputActionBar.tsx": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the bottom send button's empty snapshot when no gesture token can be captured",
  },
  "ui/renderer/components/RoutinePanel.tsx": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the natural-language routine request, sent with its click's captured token",
  },
  "ui/renderer/hooks/use-highlighted-code.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a lazily loaded grammar chosen by language; no turn entry",
  },
  "ui/renderer/hooks/use-native-context-menu.ts": {
    sites: { computedCall: 1 },
    classification: "computed: a context-menu handler chosen by command; no turn entry",
  },
  "ui/renderer/hooks/use-send-message.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "the composer's default send mode claims user-keyboard; main admits it only with the captured token",
  },
  "ui/renderer/hooks/use-side-chat.ts": {
    sites: { userKeyboardLiteral: 1 },
    classification: "side-chat hook: a claim the preload checks against the captured token",
  },
  "ui/renderer/tabs/PermissionsTab.tsx": {
    sites: { computedCall: 2 },
    classification: "computed: localized label lookups; no turn entry",
  },
};

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

describe("the turn entry inventory", () => {
  const sitesOfText = (text: string): Sites => {
    const parsed = parseSourceTexts(new Map([["fixture.ts", text]]));
    const source = parsed.get("fixture.ts");
    if (source === undefined) throw new Error("fixture did not parse");
    return sitesOf(source as unknown as Node);
  };

  // Each form reaches an entry without the plain `loop.runTurn(…)` spelling; each must still be counted so it needs classifying.
  it.each([
    ["an element access with a literal key", `declare const loop: any; loop["runTurn"]("x");`, { runTurn: 1 }],
    ["an element access with a template key", "declare const loop: any; loop[`runTurn`](\"x\");", { runTurn: 1 }],
    ["an optional call", `declare const loop: any; loop?.runTurn?.("x");`, { runTurn: 1 }],
    ["call/apply on the member", `declare const loop: any; loop.runTurn.call(loop, "x"); loop.runTurn.apply(loop, ["x"]);`, { runTurn: 2 }],
    ["a variable alias", `declare const loop: any; const go = loop.runTurn; go("a"); go("b");`, { runTurn: 3 }],
    ["an alias of an alias", `declare const loop: any; const a = loop.runTurn; const b = a; b("x");`, { runTurn: 3 }],
    ["a bound alias", `declare const loop: any; const go = loop.runTurn.bind(loop); go("x");`, { runTurn: 2 }],
    ["a destructured alias", `declare const loop: any; const { runTurn: go } = loop; go("x");`, { runTurn: 2 }],
    ["a destructured name", `declare const loop: any; const { queueGuidance } = loop; queueGuidance("x");`, { queueGuidance: 2 }],
    ["an import alias of the mint", `import { mintUserKeyboardIntent as mint } from "./chat-origin.js"; mint({}); mint({});`, { mintUserKeyboardIntent: 3 }],
    ["a mint passed as a callback", `import { mintUserKeyboardIntent } from "./chat-origin.js"; [{}].map(mintUserKeyboardIntent);`, { mintUserKeyboardIntent: 2 }],
    ["a computed member call", `declare const loop: any; declare const name: string; loop[name]("x");`, { computedCall: 1 }],
    ["a concatenated key", `declare const loop: any; loop["run" + "Turn"]("x");`, { computedCall: 1 }],
    ["an optional computed call", `declare const loop: any; declare const name: string; loop?.[name]?.("x");`, { computedCall: 1 }],
    ["a reflective read", `declare const loop: any; declare const name: string; Reflect.get(loop, name)("x");`, { computedCall: 1 }],
    ["a keyboard origin value", `const options = { inputOrigin: "user-keyboard" as const };`, { userKeyboardLiteral: 1 }],
  ] as const)("counts %s", (_label, text, expected) => {
    expect(sitesOfText(text)).toEqual(expected);
  });

  it("does not count a call's result as an alias, or a keyboard literal that only names a type or is compared", () => {
    expect(sitesOfText([
      `import { mintUserKeyboardIntent } from "./chat-origin.js";`,
      `const intent = mintUserKeyboardIntent({}); void intent; void intent;`,
      `type Origin = "user-keyboard"; declare const o: string; if (o === "user-keyboard") {} switch (o) { case "user-keyboard": break; }`,
    ].join("\n"))).toEqual({ mintUserKeyboardIntent: 2 });
  });
});

// A branch's auto-continue grant, a session lease and a pending file-mention read are bound to the loop's session epoch. The loop makes
// that binding hold by construction: `sessionId` and `sessionEpoch` are getters, and `replaceSessionIdentity` is the only code that
// changes them, always together. The compiler refuses any assignment to the getters, through any alias, on a main loop or a sub-agent
// child alike; this check keeps the backing fields private to that one method and keeps engine code from writing the getters at all.
const SESSION_IDENTITY_MEMBERS: ReadonlySet<string> = new Set(["sessionId", "sessionEpoch"]);
const SESSION_IDENTITY_FIELDS: ReadonlySet<string> = new Set(["approvalSessionId", "sessionEpochValue"]);
const SESSION_IDENTITY_WRITER = "replaceSessionIdentity";
const parentOf = (node: Node): Node | undefined => (node as Node & { parent?: Node }).parent;
const writtenMember = (target: Node): string | undefined => {
  const expression = stripExpression(target);
  if (ts.isPropertyAccessExpression(expression)) return nameText(expression.name);
  if (ts.isElementAccessExpression(expression)) return literalText(expression.argumentExpression);
  return undefined;
};
const insideWriter = (node: Node): boolean => {
  for (let current = parentOf(node); current !== undefined; current = parentOf(current)) {
    if (ts.isMethodDeclaration(current)) return nameText(current.name) === SESSION_IDENTITY_WRITER;
  }
  return false;
};

/** Writes of a session identity member, or of its backing fields outside the one writer method, in any form and through any owner. */
function directSessionIdentityWrites(source: Node): number {
  let writes = 0;
  const check = (target: Node, at: Node) => {
    const member = writtenMember(target);
    if (member === undefined) return;
    if (SESSION_IDENTITY_MEMBERS.has(member) || (SESSION_IDENTITY_FIELDS.has(member) && !insideWriter(at))) writes += 1;
  };
  const visit = (node: Node) => {
    if (isAssignment(node)) check(node.left, node);
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) check(node.operand, node);
    if (ts.isDeleteExpression(node)) check(node.expression, node);
    node.forEachChild(visit);
  };
  visit(source);
  return writes;
}
const isAssignment = (node: Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node)
  && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

describe("conversation session identity", () => {
  it("changes only through the loop's one writer: no engine code writes a session identity member or its backing field", () => {
    const files = sourceFiles(join(SRC, "engine"));
    const parsed = parseSourceFiles(files);
    expect(files.filter((file) => !parsed.has(file))).toEqual([]);
    const writing = files
      .map((file) => [relative(SRC, file).split(sep).join("/"), directSessionIdentityWrites(parsed.get(file) as unknown as Node)] as const)
      .filter(([, count]) => count > 0);
    expect(writing).toEqual([]);
  });

  it("is read-only to the compiler: assigning either getter, through an alias or on a child, does not typecheck", () => {
    const writes = (loop: ConversationLoop, child: ConversationLoop) => {
      const alias = loop;
      // @ts-expect-error sessionId is a getter; replaceSessionIdentity is the only writer.
      alias.sessionId = "x";
      // @ts-expect-error sessionEpoch is a getter and moves only with the session identity.
      loop.sessionEpoch++;
      // @ts-expect-error a sub-agent child is the same class and has the same one writer.
      child.sessionId = "y";
    };
    expect(typeof writes).toBe("function");
  });

  const writesIn = (text: string): number => {
    const source = parseSourceTexts(new Map([["fixture.ts", text]])).get("fixture.ts");
    if (source === undefined) throw new Error("fixture did not parse");
    return directSessionIdentityWrites(source as unknown as Node);
  };

  it.each([
    ["a direct swap", `declare const loop: any; loop.sessionId = "x";`, 1],
    ["a swap through an alias", `declare const loop: any; const alias = loop; alias.sessionId = "x";`, 1],
    ["a child's swap", `declare const child: any; child.sessionId = "x";`, 1],
    ["a swap through an element key", `declare const loop: any; loop["sessionId"] = "x";`, 1],
    ["an epoch bump under a dead branch", `declare const loop: any; if (false) loop.sessionEpoch++;`, 1],
    ["an epoch bump in a nested function", `declare const loop: any; loop.sessionId = "x"; (() => { loop.sessionEpoch += 1; })();`, 2],
    ["a backing-field write outside the writer", `class L { private approvalSessionId = ""; reset() { this.approvalSessionId = "x"; } }`, 1],
    ["the writer itself", `class L { private approvalSessionId = ""; private sessionEpochValue = 0;
      replaceSessionIdentity(id: string) { this.approvalSessionId = id; this.sessionEpochValue += 1; } }`, 0],
    ["a read", `declare const loop: any; const id = loop.sessionId; void id;`, 0],
  ] as const)("counts %s", (_label, text, expected) => {
    expect(writesIn(text)).toBe(expected);
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
