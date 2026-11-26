import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const SINKS = new Set(["mintHostShellExecutionPermit", "issueHostTerminalWriteAuthority"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  return undefined;
}

/** Every place a person's answer can turn into shell or terminal authority, as `file#function: what`. */
function authoritySites() {
  const texts = new Map<string, string>();
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    if (/mintHostShellExecutionPermit\(|issueHostTerminalWriteAuthority\(|humanApproved/.test(text)) texts.set(relative(SRC, path).split("\\").join("/"), text);
  }
  const parsed = parseSourceTexts(texts);
  const sites: string[] = [];
  const functions = new Map<string, ts.Node>();
  for (const [file, source] of parsed as Map<string, ts.SourceFile>) {
    const visit = (node: ts.Node, owner: string): void => {
      const named = nameOf(node);
      const here = named ?? owner;
      if (named) functions.set(`${file}#${named}`, node);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SINKS.has(node.expression.text)) {
        if (!file.endsWith(node.expression.text === "mintHostShellExecutionPermit" ? "host-shell-execution-permit.ts" : "host-terminal-write-authority.ts")) {
          sites.push(`${file}#${here}: ${node.expression.text}`);
        }
      }
      const approved = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText() === "humanApproved"
        ? node.right
        : (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) && node.name.getText() === "humanApproved" ? node.initializer : undefined;
      if (approved && approved.kind !== ts.SyntaxKind.FalseKeyword) sites.push(`${file}#${here}: humanApproved = ${approved.getText()}`);
      node.forEachChild((child) => visit(child, here));
    };
    visit(source, "<module>");
  }
  return { sites, functions, parsed: parsed as Map<string, ts.SourceFile> };
}

const AUTH = "tools/invocation-authorization.ts#authorizeToolInvocation";
const LATE = "tools/invocation-execution.ts#requestLateApproval";
const HOOK = "hooks/hook-command-policy.ts#createHookCommandAuthorizer";
const SURFACE = "tools/pipeline/user-owned-surface.ts#resolveUserOwnedSurfaceApproval";
const DIRECTORY = "tools/invocation-runner.ts#requestOutOfAllowedDirectoryAccess";

// The owner function opens a `PendingAnswerCard` and hands it to `personAnswerStands`, the only judge of its answer.
type Owner = { readonly card: string };
const site = (where: string, what: string, owners: readonly Owner[], count = 1) => ({ key: `${where}: ${what}`, where, what, owners, count });
const SITES = [
  site(HOOK, 'humanApproved = result.decision === "ask"', [{ card: HOOK }]),
  site(HOOK, "mintHostShellExecutionPermit", [{ card: HOOK }]),
  site(AUTH, "humanApproved = context.directoryAuthorization?.humanApproved ?? false", [{ card: DIRECTORY }]),
  site(AUTH, "humanApproved = surfaceResolution.humanApproved ?? manuallyApproved", [{ card: AUTH }, { card: SURFACE }]),
  site("tools/invocation-execution.ts#executeAuthorizedToolInvocation", "humanApproved = initialHumanApproved", [{ card: AUTH }, { card: DIRECTORY }]),
  site("tools/invocation-execution.ts#issueTerminalWriteAuthority", "issueHostTerminalWriteAuthority", [{ card: AUTH }, { card: LATE }]),
  site("tools/invocation-execution.ts#executeAuthorizedToolInvocation", "mintHostShellExecutionPermit", [{ card: AUTH }, { card: DIRECTORY }]),
  site(LATE, 'humanApproved = surfaceResolution.humanApproved ?? (decision.choice.startsWith("allow") && !isHostApprovalRejectedDecision(decision))', [{ card: LATE }, { card: SURFACE }]),
  site(LATE, "mintHostShellExecutionPermit", [{ card: LATE }]),
  site(DIRECTORY, "humanApproved = surfaceResolution.humanApproved ?? true", [{ card: DIRECTORY }, { card: SURFACE }]),
  site(DIRECTORY, "humanApproved = true", [{ card: DIRECTORY }], 2),
  site("tools/invocation-runner.ts#executeAdmitted", "humanApproved = resolution.humanApproved === true", [{ card: DIRECTORY }], 2),
  site("tools/invocation-runner.ts#executeAuthorized", "humanApproved = authorization.humanApproved", [{ card: AUTH }]),
  // The first card's answer, judged by the caller before it asks this function; then the fallback card's own.
  site(SURFACE, "humanApproved = true", [{ card: AUTH }, { card: LATE }, { card: DIRECTORY }], 2),
  site(SURFACE, 'humanApproved = decision.choice === "allow-once" && !isHostApprovalRejectedDecision(decision)', [{ card: SURFACE }]),
];

function calls(node: ts.Node, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && child.expression.getText().split(".").pop() === name) found.push(child);
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Where the owner judges a person's answer, or why it does not. */
function judgement(functions: Map<string, ts.Node>, owner: Owner): number | string {
  const name = owner.card;
  const fn = functions.get(name);
  if (!fn) return `${name}: not found`;
  const judged = calls(fn, "personAnswerStands");
  const cards = calls(fn, "openPendingAnswerCard").flatMap((call) => {
    let at: ts.Node | undefined = call.parent;
    while (at && !ts.isVariableDeclaration(at)) at = at.parent;
    return at && ts.isVariableDeclaration(at) ? [{ name: at.name.getText(), start: at.getStart() }] : [];
  });
  const [card, ...others] = cards;
  if (!card || others.length > 0) return `${name}: opens ${cards.length} pending answer cards`;
  const judge = judged.find((call) => call.arguments[1]?.getText() === card.name);
  if (!judge) return `${name}: card ${card.name} is not judged by personAnswerStands`;
  const asked = calls(fn, "requestAndWait").some((call) => call.getStart() > card.start && call.getStart() < judge.getStart());
  return asked ? judge.getStart() : `${name}: no card is asked between open and judgement`;
}

describe("authority from a person's answer", () => {
  it("passes every site through personAnswerStands; an unlisted site fails", () => {
    const { sites, functions } = authoritySites();
    const counted: Record<string, number> = {};
    for (const found of sites) if (!found.endsWith("= undefined")) counted[found] = (counted[found] ?? 0) + 1;
    expect(counted).toEqual(Object.fromEntries(SITES.map((entry) => [entry.key, entry.count])));
    const failures: string[] = [];
    for (const entry of SITES) {
      for (const owner of entry.owners) {
        const at = judgement(functions, owner);
        if (typeof at === "string") failures.push(`${entry.key}: ${at}`);
      }
      // A sink in its owner's own function comes after the judgement.
      const own = entry.owners.find((owner) => owner.card === entry.where);
      const fn = functions.get(entry.where);
      if (own && fn && SINKS.has(entry.what)) {
        const at = judgement(functions, own);
        if (typeof at === "number" && calls(fn, entry.what).some((call) => call.getStart() < at)) failures.push(`${entry.key}: issued before personAnswerStands`);
      }
    }
    expect(failures).toEqual([]);
  });

  // The epoch form judges no fresh check while the policy stands still and honors no same-card receipt. It is left to cards
  // that grant no shell or terminal authority; a new caller fails here.
  it("leaves the epoch form only to cards without shell or terminal authority", () => {
    const legacy: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("personAnswerStands(")) continue;
      const file = relative(SRC, path).split("\\").join("/");
      const source = parseSourceTexts(new Map([[file, text]])).get(file) as ts.SourceFile | undefined;
      if (!source) throw new Error(`${file} did not parse`);
      const visit = (node: ts.Node, owner: string): void => {
        const here = nameOf(node) ?? owner;
        if (ts.isCallExpression(node) && node.expression.getText() === "personAnswerStands" && node.arguments.length === 4) legacy.push(`${file}#${here}`);
        node.forEachChild((child) => visit(child, here));
      };
      visit(source, "<module>");
    }
    expect(legacy.sort()).toEqual([
      "permissions/effect-enforcement.ts#gateMutatingEffect",
      "permissions/egress-approval.ts#createApprovalGateEgressRequester",
      // The write fence: it judges the check it has just run.
      "permissions/host-terminal-write-authority.ts#refusal",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#lateApprovalStands",
    ]);
  });
});
