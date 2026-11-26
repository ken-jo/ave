import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
// A person's answer becomes authority only as a `StandingAnswer`, and only the owner (pending-answer-policy.ts) makes one. The
// `@ts-expect-error` lines are compile-time probes: `bun run check:typecheck-tests` fails when one of them compiles.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it } from "vitest";
import { proofOf } from "../../__tests__/support/standing-answer.js";
import { authorizeToolInvocation, type AuthorizationStageContext } from "../../tools/invocation-authorization.js";
import { executeAuthorizedToolInvocation, type ExecutionStageContext } from "../../tools/invocation-execution.js";
import type { ApprovalDecision } from "../approval-gate.js";
import { RULE_PROVENANCE } from "../decision-provenance.js";
import { mintHostShellExecutionPermit, recordHostShellPolicyAuthorization, type HostShellExecutionPermitBinding } from "../host-shell-execution-permit.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { HOST_TERMINAL_PERMISSION_CHANGED, issueHostTerminalWriteAuthority } from "../host-terminal-write-authority.js";
import * as owner from "../pending-answer-policy.js";
import { openPendingAnswerCard, personAnswerStands, spendStandingAnswer, standingAnswerFor, toolUseAction, type StandingAnswer } from "../pending-answer-policy.js";
import type { PermissionCheckResult, PermissionManager } from "../permission-manager.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";

withSourceHostResources();

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const OWNER = "permissions/pending-answer-policy.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });
}

function nameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) return node.name.getText();
  return undefined;
}

type Found = { file: string; where: string; node: ts.Node };

/** Every node of the product sources that mention `needle`, with its file and enclosing function. */
function nodesMentioning(needle: string): Found[] {
  const texts = new Map<string, string>();
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    if (text.includes(needle)) texts.set(relative(SRC, path).split("\\").join("/"), text);
  }
  const found: Found[] = [];
  for (const [file, source] of parseSourceTexts(texts) as Map<string, ts.SourceFile>) {
    const visit = (node: ts.Node, owning: string): void => {
      const here = nameOf(node) ?? owning;
      found.push({ file, where: `${file}#${here}`, node });
      node.forEachChild((child) => visit(child, here));
    };
    visit(source, "<module>");
  }
  return found;
}

function gateReceivesRequest(request: ts.CallExpression, gate?: ts.Expression): boolean {
  const call = request.parent;
  return ts.isCallExpression(call) && call.arguments[0] === request &&
    ts.isPropertyAccessExpression(call.expression) && call.expression.name.getText() === "requestAndWait" &&
    (gate === undefined || call.expression.expression.getText() === gate.getText());
}

function calls(name: string) {
  return nodesMentioning(name)
    .flatMap(({ node, where }) => ts.isCallExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() === name
        : ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression)
          ? node.expression.argumentExpression.text === name
          : node.expression.getText() === name)
      ? [{ node, where }] : []);
}


function requireNode<T>(node: T | undefined, label: string): T {
  if (node === undefined) throw new Error(`Missing approval syntax: ${label}`);
  return node;
}

function compactBinding(text: string): string {
  return text.replace(/\s/g, "").replace(/,(?=})/g, "");
}

function directStatement(node: ts.Node): ts.Statement {
  let parent = node;
  while (!ts.isStatement(parent)) parent = parent.parent;
  return parent;
}

function admissionStatement(call: ts.CallExpression, assigned: string | undefined): ts.Statement | undefined {
  const parent = call.parent;
  if (assigned === undefined) return ts.isExpressionStatement(parent) ? parent : undefined;
  if (ts.isVariableDeclaration(parent) && parent.initializer === call && parent.name.getText() === assigned) {
    return directStatement(parent);
  }
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === call && parent.left.getText() === assigned && ts.isExpressionStatement(parent.parent)) {
    return parent.parent;
  }
}

function precedingApprovalStatement(admission: ts.Statement, use: ts.Node): boolean {
  if (admission.end > use.getStart()) return false;
  const block = admission.parent;
  if (!ts.isBlock(block)) return false;
  for (let cursor: ts.Node | undefined = use; cursor !== undefined; cursor = cursor.parent) {
    if (cursor.pos === block.pos && cursor.end === block.end && cursor.kind === block.kind) return true;
  }
  const guarded = block.parent;
  if (!ts.isTryStatement(guarded) || guarded.tryBlock !== block || guarded.catchClause === undefined) return false;
  const last = guarded.catchClause.block.statements.at(-1);
  if (last && (ts.isReturnStatement(last) || ts.isThrowStatement(last))) return precedingApprovalStatement(guarded, use);
  // The coordinator starts with a refusal and only a successful admission changes it.
  if (guarded.catchClause.block.statements.length === 1 && last && ts.isIfStatement(last) &&
      last.thenStatement.kind === ts.SyntaxKind.ThrowStatement) {
    const outcome = block.statements.at(-1);
    if (outcome?.getText() !== "approvalOutcome = approvalFailureKind(decision);") return false;
    for (let cursor: ts.Node | undefined = use; cursor !== undefined; cursor = cursor.parent) {
      const branch: ts.Node | undefined = cursor.parent;
      if (branch && ts.isIfStatement(branch) && branch.thenStatement === cursor &&
          branch.expression.getText() === "decision !== null && approvalOutcome === undefined") return true;
    }
  }
  return false;
}

function assertRequestSource(ask: ts.CallExpression, admission: ts.CallExpression, label: string): void {
  let sent = ask.arguments[0];
  if (sent && ts.isCallExpression(sent) && sent.expression.getText() === "bindPendingAnswerRequest") sent = sent.arguments[0];
  const expected = requireNode(admission.arguments[1], label);
  if (!ts.isObjectLiteralExpression(expected)) {
    expect(sent?.getText(), label).toBe(expected.getText());
    return;
  }
  const field = (object: ts.ObjectLiteralExpression, key: string): string | undefined => {
    const prop = object.properties.find((entry) =>
      (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) && entry.name.getText() === key);
    return prop && (ts.isPropertyAssignment(prop) ? prop.initializer.getText() : ts.isShorthandPropertyAssignment(prop) ? prop.name.getText() : undefined);
  };
  const requestId = field(expected, "requestId");
  if (requestId === undefined) {
    expect(sent?.getText(), label).toBe("binding.card.requestId");
    expect(ask.arguments[1]?.getText(), label).toContain("requestId: binding.card.requestId");
    return;
  }
  if (sent && ts.isObjectLiteralExpression(sent)) {
    const givenId = field(sent, ask.expression.getText() === "requestHumanApproval" ? "requestId" : "id");
    if (givenId === undefined) {
      expect(sent.properties.filter(ts.isSpreadAssignment).some((spread) => spread.expression.getText() === "approvalRequest"), label).toBe(true);
      expect(["approvalRequest.id", "approvalRequestId"], label).toContain(requestId);
    } else {
      expect(givenId, label).toBe(requestId);
      if (ask.expression.getText() !== "requestHumanApproval") {
        expect(field(sent, "toolName"), label).toBe(field(expected, "toolName"));
        const toolUseId = field(expected, "toolUseId");
        if (toolUseId === "ctx.toolUseId") {
          expect(compactBinding(sent.getText()), label).toContain("...(ctx.toolUseId===undefined?{}:{invocationToolUseId:ctx.toolUseId})");
        } else {
          expect(field(sent, "invocationToolUseId") ?? "undefined", label).toBe(toolUseId);
        }
      }
    }
  } else if (sent?.getText() === "fallback") {
    expect(requestId, label).toBe("fallbackId");
    expect(sent.getSourceFile().text.slice(0, sent.pos), label).toMatch(/const fallback: ApprovalRequestInput = \{\s*\.\.\.request,\s*id: fallbackId,/);
  } else {
    const argument = sent?.getText();
    const resolvesDesktop = ts.isPropertyAccessExpression(ask.expression) && ask.expression.name.getText() === "resolveFromDesktopRendererWithFreshIdentity";
    expect(requestId, label).toBe(resolvesDesktop ? argument : `${argument}.id`);
  }
}

const policy = { getPolicyEpoch: () => "1:0:0", getPolicyContextEpoch: () => "1" } as unknown as PermissionManager;
const asked: PermissionCheckResult = { decision: "ask", reason: "Run it on the host.", provenance: RULE_PROVENANCE };
const ACTION = toolUseAction("probe");
const decisionFor = (requestId: string): ApprovalDecision => ({ requestId, choice: "allow-once" });
const openCard = (requestId: string, action = ACTION) => openPendingAnswerCard(policy, asked, () => asked, "stale-refused",
  { gate: {}, requestId, action, uses: ["shell-permit", "shell-policy", "terminal-write"] });

/** A host shell action that needs a person's answer. */
function shellBinding(): HostShellExecutionPermitBinding {
  const plan = buildHostShellExecutionPlan({
    platform: "win32", requestedSandbox: true,
    activeCapability: { kind: "asrt", confidence: "verified", platform: "win32", reason: "partial", confines: { filesystem: true, process: false, network: true } },
  });
  return Object.freeze({
    plan, planIdentity: plan.identity, toolName: "bash", toolUseId: "probe", command: "echo probe", requestedCwd: undefined,
    executionCwd: tmpdir(), resolvedCwd: tmpdir(), cwdIdentity: captureShellWorkingDirectoryIdentity(tmpdir()), timeoutSeconds: 30,
    executionMode: "default", justification: undefined, runInBackground: false, allowedDirectories: Object.freeze([]),
  } satisfies HostShellExecutionPermitBinding);
}

const terminalInput = {
  manager: policy, action: ACTION, reviewed: false, decidedBackend: "host", backendIdentity: () => "host", check: () => asked,
  settled: { decision: "allow", reason: "user approved approval request (allow-once)" } as PermissionCheckResult,
};

declare const Outside: typeof StandingAnswer;

describe("authority from a person's answer", () => {
  it("lets no module but the owner construct a standing answer", () => {
    const nodes = nodesMentioning("StandingAnswer");
    const classes = nodes.filter(({ node }) => node.kind === ts.SyntaxKind.ClassDeclaration && /^class StandingAnswer\b/.test(node.getText()));
    // One class, in the owner, declared without `export`, with a private constructor.
    expect(classes.map(({ file }) => file)).toEqual([OWNER]);
    const constructors = nodes.filter(({ node }) => node.kind === ts.SyntaxKind.Constructor && node.parent === classes[0]?.node);
    expect(constructors.map(({ node }) => /^private constructor\(\)/.test(node.getText()))).toEqual([true]);
    // It is constructed once, in its own static block, and leaves the module only as a type.
    const constructed = nodes.filter(({ node }) => node.kind === ts.SyntaxKind.NewExpression && /^new StandingAnswer\b/.test(node.getText()));
    expect(constructed.map(({ file, node }) => {
      let at: ts.Node | undefined = node.parent;
      while (at && at.kind !== ts.SyntaxKind.ClassStaticBlockDeclaration) at = at.parent;
      return [file, at !== undefined && at.parent === classes[0]?.node];
    })).toEqual([[OWNER, true]]);
    const exported = nodes.filter(({ node }) => node.kind === ts.SyntaxKind.ExportDeclaration && /\bStandingAnswer\b/.test(node.getText()));
    expect(exported.map(({ file, node }) => [file, node.getText()])).toEqual([[OWNER, "export type { StandingAnswer };"]]);
    // No cast names a standing answer outside the owner's own registry lookup.
    const casts = nodes.filter(({ node }) => (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || node.kind === ts.SyntaxKind.TypeAssertionExpression)
      && /\bStandingAnswer\b/.test(ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? node.type.getText() : node.getText()));
    expect(casts.map(({ where }) => where)).toEqual([`${OWNER}#standingAnswerFor`]);
    // The issuer is called only by the judgement.
    const issued = nodes.filter(({ node }) => ts.isCallExpression(node) && node.expression.getText() === "issueStandingAnswer");
    expect(issued.map(({ where }) => where)).toEqual([`${OWNER}#judgeCard`]);

    // At run time the module exports neither the class nor the issuer, and the constructor reached through a real proof's
    // prototype makes nothing the registry knows.
    const card = openCard("made");
    expect(personAnswerStands(card, decisionFor("made"))).toBe(true);
    const Made = Object.getPrototypeOf(proofOf(card)).constructor as new () => StandingAnswer;
    expect(Object.values(owner as Record<string, unknown>).some((value) => value === Made)).toBe(false);
    expect(Object.keys(owner)).not.toEqual(expect.arrayContaining(["StandingAnswer"]));
    expect(Object.keys(owner)).not.toEqual(expect.arrayContaining(["issueStandingAnswer"]));
    expect(standingAnswerFor(new Made(), ACTION)).toBeUndefined();
    expect(spendStandingAnswer(new Made(), "shell-permit", ACTION)).toBeUndefined();

    // @ts-expect-error the constructor is private to the owner
    const constructedOutside = (): StandingAnswer => new Outside();
    // @ts-expect-error an object literal is no standing answer
    const literal: StandingAnswer = { standing: true };
    // @ts-expect-error the owner exports no value to construct
    const exportedValue: unknown = owner.StandingAnswer;
    expect([typeof constructedOutside, typeof literal, exportedValue]).toEqual(["function", "object", undefined]);
  });

  // Probe 1: a sink reached through another name still takes only the owner's proof.
  it("probe: an alias of a sink issues nothing for a raw answer", () => {
    const mint = mintHostShellExecutionPermit;
    const record = recordHostShellPolicyAuthorization;
    const issue = issueHostTerminalWriteAuthority;
    const binding = shellBinding();
    const decision = decisionFor("alias");
    // @ts-expect-error a raw answer is not a standing answer
    expect(mint({ plan: binding.plan, binding, answer: decision })).toBeUndefined();
    // @ts-expect-error nor is a flag
    record(binding, true);
    expect(mint({ plan: binding.plan, binding, answer: undefined })).toBeUndefined();
    // @ts-expect-error a raw answer is not a standing answer
    expect(() => issue({ ...terminalInput, answer: decision })).toThrow(HOST_TERMINAL_PERMISSION_CHANGED);
    // @ts-expect-error nor is a flag
    expect(() => issue({ ...terminalInput, answer: true })).toThrow(HOST_TERMINAL_PERMISSION_CHANGED);
    // The same aliases issue for the owner's proof, so the refusals above are the proof's and not the fixture's.
    const card = openCard("alias");
    personAnswerStands(card, decision);
    record(binding, proofOf(card));
    expect(mint({ plan: binding.plan, binding, answer: undefined })).toBeDefined();
    expect(issue({ ...terminalInput, answer: proofOf(card) }).refusal()).toBeUndefined();
  });

  // Probe 2: before the judgement there is no proof to hand to a sink.
  it("probe: a helper that reaches a sink before the judgement holds no proof", () => {
    const binding = shellBinding();
    const card = openCard("early");
    // @ts-expect-error an unjudged card has no proof to read
    expect(() => card.verdict.proof).toThrow(TypeError);
    const helper = (use: (answer: StandingAnswer | undefined) => unknown) => use(proofOf(card));
    expect(helper((answer) => spendStandingAnswer(answer, "terminal-write", ACTION))).toBeUndefined();
    expect(helper((answer) => { recordHostShellPolicyAuthorization(binding, answer); return mintHostShellExecutionPermit({ plan: binding.plan, binding, answer }); })).toBeUndefined();
    // The card and the answer are not the proof, before or after the judgement.
    for (const taken of [card, decisionFor("early")]) {
      expect(() => issueHostTerminalWriteAuthority({ ...terminalInput, answer: taken as never })).toThrow(HOST_TERMINAL_PERMISSION_CHANGED);
    }
    expect(personAnswerStands(card, decisionFor("early"))).toBe(true);
    expect(() => issueHostTerminalWriteAuthority({ ...terminalInput, answer: card as never })).toThrow(HOST_TERMINAL_PERMISSION_CHANGED);
    expect(helper((answer) => spendStandingAnswer(answer, "terminal-write", ACTION))).toBeDefined();
  });

  // Probe 3: `humanApproved` is the proof itself, so nothing can set it ahead of the judgement.
  it("probe: humanApproved set before the judgement is refused", async () => {
    // @ts-expect-error humanApproved is a standing answer, not a flag
    const flagged: Pick<ExecutionStageContext, "humanApproved"> = { humanApproved: true };
    // @ts-expect-error nor is the directory lane's
    const directory: NonNullable<AuthorizationStageContext["directoryAuthorization"]> = { permission: asked, humanApproved: true };
    const toolUse = { id: "probe", name: "probe", input: {} };
    const missing = "Handler admission is missing human approval provenance";
    await expect(executeAuthorizedToolInvocation({ toolUse, permissionResult: asked, ...flagged } as never)).rejects.toThrow(missing);
    await expect(executeAuthorizedToolInvocation({ toolUse, permissionResult: asked } as never)).rejects.toThrow(missing);
    await expect(authorizeToolInvocation({ toolUse, directoryAuthorization: directory } as never)).rejects.toThrow("Directory authorization carries no standing answer for this action");
    // A standing answer to another call is no provenance for this one.
    const card = openCard("other", toolUseAction("other"));
    personAnswerStands(card, decisionFor("other"));
    expect(proofOf(card)).toBeDefined();
    await expect(executeAuthorizedToolInvocation({ toolUse, permissionResult: asked, humanApproved: proofOf(card) } as never)).rejects.toThrow(missing);
  });

  // The owner reads an answer's choice. A host rejection (abort, failed integrity, a choice the card did not offer) is always
  // written as deny-once, so none can stand as an Allow.
  it("marks only deny-once decisions as host-rejected", () => {
    const nodes = nodesMentioning("hostRejectedApprovalDecisions");
    const rejected = nodes.flatMap(({ node }) => ts.isCallExpression(node) && node.expression.getText() === "markHostApprovalRejectedDecision"
      ? [node.arguments[0]?.getText() ?? ""]
      : ts.isVariableDeclaration(node) && node.name.getText() === "forcedDecision" ? [node.initializer?.getText() ?? ""] : []);
    expect(rejected.length).toBeGreaterThan(8);
    expect(rejected.filter((literal) => !/\bchoice: "deny-once"/.test(literal) || /\bchoice: "allow/.test(literal))).toEqual([]);
    const marked = nodes.flatMap(({ where, node }) => ts.isCallExpression(node) && node.expression.getText() === "hostRejectedApprovalDecisions.add"
      ? [`${where.split("#")[1]}: ${node.arguments[0]?.getText()}`] : []);
    expect(new Set(marked)).toEqual(new Set(["markHostApprovalRejectedDecision: decision", "resolveDecision: forcedDecision"]));
  });

  // The epoch form mints no standing answer, judges no fresh check while the policy stands still and honors no same-card receipt.
  // It is left to these routes, which reach no sink; a new caller fails here.
  it("leaves the epoch form only to the named routes that take no standing answer", () => {
    const legacy = nodesMentioning("personAnswerStands(")
      .filter(({ node }) => ts.isCallExpression(node) && node.expression.getText() === "personAnswerStands" && node.arguments.length === 4)
      .map(({ where }) => where);
    expect(legacy.sort()).toEqual([
      // The write fence's refusal: it judges the check it has just run and only ever withdraws authority.
      "permissions/host-terminal-write-authority.ts#refusal",
      // Browser site access: three site cards, each a policy decision about one site.
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      "tools/invocation-execution.ts#authorizeBrowserSite",
      // A late card not yet asked: whether its question still stands, with no answer to judge.
      "tools/invocation-execution.ts#lateApprovalStands",
    ]);
  });

  // The late card's pre-ask check takes its question from the owner and returns a plain yes or no: it neither holds nor makes a
  // standing answer.
  it("keeps the late pre-ask check to the owner's question and a boolean", () => {
    const late = nodesMentioning("lateApprovalStands")
      .filter(({ node }) => ts.isVariableDeclaration(node) && node.name.getText() === "lateApprovalStands").map(({ node }) => node.getText());
    expect(late).toHaveLength(1);
    expect(late[0]).toMatch(/^lateApprovalStands = \(\): boolean =>/);
    expect(late[0]).toContain("pendingQuestionStillAsked(");
    expect(late[0]).not.toMatch(/StandingAnswer|standingAnswerFor|spendStandingAnswer|openPendingAnswerCard|permissionQuestionOf|samePermissionQuestion/);
    const asked = nodesMentioning("pendingQuestionStillAsked(")
      .filter(({ node }) => ts.isCallExpression(node) && node.expression.getText() === "pendingQuestionStillAsked").map(({ where }) => where);
    expect(asked).toEqual(["tools/invocation-execution.ts#lateApprovalStands"]);
  });

  // The gate writes a held allow against the standing answer and spends its rule-save use.
  it("writes a held allow only through the owner and the gate's proof spend", () => {
    const sites = (name: string) => calls(name).map(({ where }) => where).sort();
    expect(sites("commitStagedAllowSaves")).toEqual([`${OWNER}#saveStandingAnswerRule`]);
    expect(sites("pendingAnswerDefersAllowSaves")).toEqual(["permissions/approval-gate.ts#requestAndWait"]);
    expect(sites("stageAllowSave")).toEqual(["ipc/domains/permissions.ts#registerPermissionsHandlers", "ipc/domains/permissions.ts#registerPermissionsHandlers"]);
    const cards = calls("openPendingAnswerCard");
    const asks = calls("bindPendingAnswerRequest");
    const saves = calls("saveStandingAnswerRule");
    const verdicts = calls("personAnswerStands").filter(({ node }) => node.arguments.length === 2);
    const admissions = calls("admitApprovalAnswer");
    expect(saves.map(({ where }) => where).sort()).toEqual(cards.map(({ where }) => where).sort());
    expect(asks.map(({ where }) => where).sort()).toEqual(cards.map(({ where }) => where).sort());
    expect(cards.map(({ where }) => where).sort()).toEqual([
      "hooks/hook-command-policy.ts#createHookCommandAuthorizer",
      "permissions/effect-enforcement.ts#gateMutatingEffect",
      "permissions/egress-approval.ts#createApprovalGateEgressRequester",
      "tools/invocation-authorization.ts#authorizeToolInvocation",
      "tools/invocation-execution.ts#requestLateApproval",
      "tools/invocation-runner.ts#requestOutOfAllowedDirectoryAccess",
      "tools/pipeline/user-owned-surface.ts#resolveSurface",
    ]);
    // Only a card open captures a question to judge an answer. The terminal write fence seals and compares an already settled question.
    expect(sites("permissionQuestionOf")).toEqual([
      "permissions/host-terminal-write-authority.ts#issueHostTerminalWriteAuthority",
      "permissions/host-terminal-write-authority.ts#refusal",
      `${OWNER}#asksNoMoreThan`,
      `${OWNER}#judgeCard`,
      `${OWNER}#openPendingAnswerCard`,
      `${OWNER}#pendingQuestionStillAsked`,
    ]);
    const cardSources = nodesMentioning("openPendingAnswerCard");
    for (const { node, where } of cards) {
      const card = cardSources.find(({ node: assignment, where: scope }) => scope === where &&
        (ts.isVariableDeclaration(assignment) && (assignment.initializer?.getText() === node.getText() ||
          assignment.initializer !== undefined && ts.isConditionalExpression(assignment.initializer) &&
          assignment.initializer.whenTrue.getText() === node.getText()) ||
          ts.isBinaryExpression(assignment) && assignment.right.getText() === node.getText()))?.node;
      const cardName = card && (ts.isVariableDeclaration(card) ? card.name.getText() : ts.isBinaryExpression(card) ? card.left.getText() : undefined);
      expect(cardName, where).toBeDefined();
      const ask = asks.find(({ where: scope, node: call }) => scope === where && call.arguments[1]?.getText() === cardName);
      expect(ask !== undefined && gateReceivesRequest(ask.node), where).toBe(true);
      const binding = node.arguments[4]?.getText();
      // Shared use lists still have to declare the sink at their definition.
      const uses = binding?.match(/\buses: (\w+) \}$/)?.[1];
      expect(uses
        ? nodesMentioning(uses).find(({ node: declaration, where: scope }) => scope === where &&
          ts.isVariableDeclaration(declaration) && declaration.name.getText() === uses)?.node.getText()
        : binding, where).toContain('"rule-save"');
      const verdict = verdicts.find(({ where: scope, node: call }) => scope === where && call.pos > node.pos &&
        call.arguments[0]?.getText() === cardName);
      expect(verdict, where).toBeDefined();
      // The answer is admitted for its own request between the ask and the judgement, so nothing judges, saves or acts on a foreign one.
      expect(admissions.filter(({ where: scope, node: call }) => scope === where && call.pos > (ask?.node.pos ?? Infinity) &&
        call.pos < (verdict?.node.pos ?? -Infinity) && call.arguments[0]?.getText() === verdict?.node.arguments[1]?.getText()), where).toHaveLength(1);
      expect(saves.some(({ where: scope, node: call }) => scope === where && call.pos > (verdict?.node.pos ?? Infinity) &&
        call.arguments[0]?.getText() === cardName && call.arguments[1]?.getText() === verdict?.node.arguments[1]?.getText()), where).toBe(true);
    }
    const spends = calls("spendStandingAnswer")
      .filter(({ node }) => node.arguments[1]?.getText() === '"rule-save"').map(({ where }) => where);
    expect(spends).toEqual(["permissions/approval-gate.ts#commitStagedAllowSaves"]);
  });

  it("passes transformed requests to the receiving gate only through the named adapter", () => {
    const forwards = nodesMentioning("forwardPendingAnswerRequest")
      .flatMap(({ node, where }) => ts.isCallExpression(node) && node.expression.getText() === "forwardPendingAnswerRequest"
        ? [{ node, where }] : []);
    expect(forwards.map(({ where }) => where)).toEqual(["engine/subagent-runner.ts#wrappedRequestAndWait"]);
    for (const { node, where } of forwards) {
      expect(node.arguments.map((arg) => arg.getText()), where).toEqual(["req", "wrapper", "forwarded", "base"]);
      expect(gateReceivesRequest(node, node.arguments[3]), where).toBe(true);
    }
  });

  it("binds each consumed approval to the request that produced it", () => {
    const forwarding = "engine/subagent-runner.ts#wrappedRequestAndWait";
    const toolUse = "toolName: toolUse.name, toolUseId: toolUse.id";
    const request = "requestId: request.id, toolName: request.toolName, toolUseId: request.invocationToolUseId";
    const sealed = "requestId: ticketId, toolName: context.control.sealedAction.toolName, toolUseId: context.control.sealedAction.toolUseId";
    const card = "requestId: card.id, toolName: card.toolName, toolUseId: undefined";
    const namedTool = "requestId, toolName, toolUseId: undefined";
    const sites = [
      ["requestAndWait", "boot/steps/plugin-tool-executor.ts#setupPluginToolExecutor", "decision", card, "answer"],
      ["requestAndWait", "engine/turn/query-loop.ts#gateCrossAgentInterceptedMetaTools", "decision", request],
      ["requestAndWait", "hooks/hook-command-policy.ts#createHookCommandAuthorizer", "approval", 'requestId: id, toolName: "bash", toolUseId: undefined', "admitted"],
      ["requestAndWait", "mcp/mcp-elicitation-resolver.ts#createElicitationResolverFactory", "decision", namedTool, "admitted"],
      ["requestAndWait", "permissions/agent-action-approver.ts#buildSingleFlightAgentActionApprover", "decision", card],
      ["requestAndWait", "permissions/effect-enforcement.ts#gateMutatingEffect", "decision", "requestId, toolName: ctx.toolName, toolUseId: ctx.toolUseId", "admitted"],
      ["requestAndWait", "permissions/egress-approval.ts#createApprovalGateEgressRequester", "decision", namedTool, "answer"],
      ["requestAndWait", "permissions/extension-start-asker.ts#ask", "decision", 'requestId, toolName: "extension_start", toolUseId: undefined', "admitted"],
      ["requestAndWait", "permissions/permission-mode-apply.ts#applyPermissionModeChange", "decision", "requestId: request.id, toolName: request.toolName, toolUseId: undefined"],
      ["requestAndWait", "tools/invocation-authorization.ts#authorizeToolInvocation", "decision", `requestId: approvalRequestId, ${toolUse}`],
      ["requestAndWait", "tools/invocation-execution.ts#authorizeBrowserSite", "actionDecision", "actionRequest"],
      ["requestAndWait", "tools/invocation-execution.ts#authorizeBrowserSite", "siteDecision", "siteRequest"],
      ["requestAndWait", "tools/invocation-execution.ts#requestLateApproval", "decision", `requestId: liveRequest.id, ${toolUse}`],
      ["requestAndWait", "tools/invocation-runner.ts#requestOutOfAllowedDirectoryAccess", "decision", `requestId: approvalRequest.id, ${toolUse}`],
      ["requestAndWait", "tools/pipeline/user-owned-surface.ts#resolveSurface", "decision", "requestId: fallbackId, toolName: fallback.toolName, toolUseId: fallback.invocationToolUseId", "admitted"],
      ["requestAndWait", "tools/skill-load.ts#execute", "decision", 'requestId, toolName: "skill_load", toolUseId: undefined', "admitted"],
      ["requestHumanApproval", "tools/pipeline/rationale-host-coordinator.ts#promptForApproval", "decision", sealed],
      ["resolveFromDesktopRendererWithFreshIdentity", "ipc/domains/permissions.ts#registerPermissionsHandlers", "honoredDecision", "requestId: decision.requestId, toolName: snapshot.toolName, toolUseId: snapshot.toolUseId", "answer"],
      ["resolveWithFreshIdentity", "main/telegram-remote-approval.ts#handleCallbackQuery", "decision", "...binding.card, ...(partialRow ? { extensionStartRow: binding.card.row } : {})", "answer"],
    ] as const;
    const observers = [
      ["tools/invocation-authorization.ts#onSettled", "answer", `requestId: approvalRequestId, ${toolUse}`],
      ["tools/invocation-runner.ts#onSettled", "answer", `requestId: directoryRequestId, ${toolUse}`],
      ["tools/pipeline/rationale-host-coordinator.ts#onSettled", "answer", sealed],
      ["main/telegram-remote-approval.ts#finalTextFor", "decision", "card", "answer"],
      ["tools/invocation-execution.ts#admitBrowserApproval", "decision", request],
      ["tools/pipeline/user-owned-surface.ts#resolveSurface", "decision", request, "initialAnswer"],
    ] as const;

    const admissions = [...calls("admitApprovalAnswer"), ...calls("admitBrowserApproval")];
    const covered = new Set<ts.CallExpression>();
    const usage = [
      ...nodesMentioning("admitApprovalAnswer").filter(({ node }) =>
        ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ||
        ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)),
      ...["approvalFailureKind", "approvalFailureOutcome", "hostApprovalDenialReason", "isSettledRefusal",
        "isAnsweredApprovalDenial", "isHostApprovalCancelledDecision", "answeredApprovalProvenance",
        "consumeUserOwnedSurfaceChoice", "consumeBrowserSiteChoice", "selectRationaleDenial", "onApprovalDecision"]
        .flatMap(calls),
    ];

    function assertConsumer(where: string, result: string, binding: string, assigned: string | undefined, after = 0, before = Infinity): ts.CallExpression {
      const label = `${where} (${result})`;
      const matching = admissions.filter(({ where: owner, node }) => owner === where && node.pos >= after && node.end <= before &&
        node.arguments[0]?.getText() === result);
      expect(matching, label).toHaveLength(1);
      const { node } = requireNode(matching[0], label);
      covered.add(node);
      const delegated = binding === "actionRequest" || binding === "siteRequest";
      expect(node.expression.getText(), label).toBe(delegated ? "admitBrowserApproval" : "admitApprovalAnswer");
      const expected = delegated || binding === "card" ? binding : `{ ${binding} }`;
      expect(compactBinding(node.arguments[1]?.getText() ?? ""), label).toBe(compactBinding(expected));
      const statement = admissionStatement(node, assigned);
      expect(statement !== undefined && ts.isBlock(statement.parent), label).toBe(true);

      const reads = usage.filter(({ where: owner, node: use }) => owner === where && use.pos >= after && use.end <= before &&
        (ts.isCallExpression(use) ? use.arguments[0]?.getText() === result
          : ts.isVariableDeclaration(use) ? use.initializer?.getText() === result
            : (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use)) && use.expression.getText() === result));
      for (const { node: use } of reads) {
        expect(statement && precedingApprovalStatement(statement, use), `${label} must admit before ${use.getText()}`).toBe(true);
      }
      if (assigned !== undefined && statement !== undefined) {
        // A result-bound consumer must read the admitted record downstream. Writing it and consulting
        // only the raw decision could turn a host-owned result into approval.
        const text = statement.getSourceFile().text.slice(statement.end, before);
        expect(text, label).toMatch(new RegExp(`\\b${assigned}\\??\\.(?:choice|decision|trustOrigin)\\b|\\bif \\(${assigned}\\)|\\b${assigned} === undefined\\b`));
      }
      return node;
    }

    for (const entry of new Set(sites.map(([entry]) => entry))) {
      const asks = calls(entry);
      const matching = sites.filter(([name]) => name === entry);
      const expected = matching.map(([, where]) => where);
      expect(asks.map(({ where }) => where).sort()).toEqual(
        (entry === "requestAndWait" ? [...expected, forwarding] : expected).sort(),
      );
      for (const site of matching) {
        const [, where, result, binding] = site;
        const assigned = site.length === 5 ? site[4] : undefined;
        const candidates = asks.filter((ask) => ask.where === where);
        const ask = candidates.length === 1 ? candidates[0] : candidates.find(({ node }) => {
          const awaited = node.parent;
          const declaration = awaited.parent;
          return ts.isAwaitExpression(awaited) && ts.isVariableDeclaration(declaration) && declaration.name.getText() === result;
        });
        const produced = requireNode(ask, where).node;
        const admission = assertConsumer(where, result, binding, assigned, produced.end);
        assertRequestSource(produced, admission, where);
      }
    }

    const fallbackAsk = calls("requestAndWait").find(({ where }) => where === "tools/pipeline/user-owned-surface.ts#resolveSurface");
    for (const site of observers) {
      const [where, result, binding] = site;
      const assigned = site.length === 4 ? site[3] : undefined;
      const before = where.endsWith("#resolveSurface") ? fallbackAsk?.node.pos : undefined;
      const admission = assertConsumer(where, result, binding, assigned, 0, before);
      if (where.endsWith("#resolveSurface")) {
        const original = admission.getSourceFile().text.slice(directStatement(admission).parent.pos, admission.pos);
        expect(original, where).toContain("let { permission, decision } = input;");
        expect(original, where).not.toMatch(/\binput\.decision\b/);
      }
    }
    // This also catches new settlement observers and forwarders that start consuming answers.
    expect(admissions.filter(({ node }) => !covered.has(node)).map(({ where }) => where)).toEqual([]);

    const pluginConsumer = "boot/steps/plugin-tool-executor.ts#setupPluginToolExecutor";
    const plugin = requireNode(admissions.find(({ where }) => where === pluginConsumer), pluginConsumer).node;
    const issuance = requireNode(calls("issueInspectedPluginOperationGrant").find(({ where }) => where === pluginConsumer), pluginConsumer).node;
    const gate = directStatement(issuance).parent;
    expect(ts.isBlock(gate)).toBe(true);
    if (!ts.isBlock(gate)) return;
    const guard = gate.statements.find((statement) => ts.isIfStatement(statement) &&
      statement.expression.getText() === 'denialReason !== undefined || answer?.choice !== "allow-once"');
    expect(guard?.getText()).toContain("throw new Error");
    expect(guard !== undefined && plugin.end < guard.pos && guard.end <= issuance.pos).toBe(true);
  });
});
