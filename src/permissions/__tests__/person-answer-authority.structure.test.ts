// A person's answer becomes authority only as a `StandingAnswer`, and only the owner (pending-answer-policy.ts) makes one. The
// `@ts-expect-error` lines are compile-time probes: `bun run check:typecheck-tests` fails when one of them compiles.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { describe, expect, it } from "vitest";
import { authorizeToolInvocation, type AuthorizationStageContext } from "../../tools/invocation-authorization.js";
import { executeAuthorizedToolInvocation, type ExecutionStageContext } from "../../tools/invocation-execution.js";
import type { ApprovalDecision } from "../approval-gate.js";
import { mintHostShellExecutionPermit, recordHostShellPolicyAuthorization, type HostShellExecutionPermitBinding } from "../host-shell-execution-permit.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { HOST_TERMINAL_PERMISSION_CHANGED, issueHostTerminalWriteAuthority } from "../host-terminal-write-authority.js";
import * as owner from "../pending-answer-policy.js";
import { openPendingAnswerCard, personAnswerStands, spendStandingAnswer, standingAnswerFor, toolUseAction, type StandingAnswer } from "../pending-answer-policy.js";
import type { PermissionCheckResult, PermissionManager } from "../permission-manager.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";

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
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
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

const policy = { getPolicyEpoch: () => "1:0:0", getPolicyContextEpoch: () => "1" } as unknown as PermissionManager;
const asked: PermissionCheckResult = { decision: "ask", reason: "Run it on the host." };
const ACTION = toolUseAction("probe");
const decisionFor = (requestId: string): ApprovalDecision => ({ requestId, choice: "allow-once" });
const openCard = (requestId: string, action = ACTION) => openPendingAnswerCard(policy, asked, () => asked, "stale-refused",
  { gate: {}, requestId, action, uses: ["shell-permit", "shell-policy", "terminal-write"] });
const proofOf = (card: ReturnType<typeof openCard>): StandingAnswer | undefined => card.verdict?.kind === "stands" ? card.verdict.proof : undefined;

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
    await expect(executeAuthorizedToolInvocation({ toolUse, ...flagged } as never)).rejects.toThrow(missing);
    await expect(executeAuthorizedToolInvocation({ toolUse } as never)).rejects.toThrow(missing);
    await expect(authorizeToolInvocation({ toolUse, directoryAuthorization: directory } as never)).rejects.toThrow("Directory authorization carries no standing answer for this action");
    // A standing answer to another call is no provenance for this one.
    const card = openCard("other", toolUseAction("other"));
    personAnswerStands(card, decisionFor("other"));
    expect(proofOf(card)).toBeDefined();
    await expect(executeAuthorizedToolInvocation({ toolUse, humanApproved: proofOf(card) } as never)).rejects.toThrow(missing);
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
    const calls = (name: string) => nodesMentioning(name)
      .flatMap(({ node, where }) => ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : node.expression.getText()) === name
        ? [{ node, where }] : []);
    const sites = (name: string) => calls(name).map(({ where }) => where).sort();
    expect(sites("commitStagedAllowSaves")).toEqual([`${OWNER}#saveStandingAnswerRule`]);
    expect(sites("deferAllowSaves")).toEqual([`${OWNER}#openPendingAnswerCard`]);
    expect(sites("stageAllowSave")).toEqual(["ipc/domains/permissions.ts#registerPermissionsHandlers", "ipc/domains/permissions.ts#registerPermissionsHandlers"]);
    const cards = calls("openPendingAnswerCard");
    const saves = calls("saveStandingAnswerRule");
    const verdicts = calls("personAnswerStands").filter(({ node }) => node.arguments.length === 2);
    expect(saves.map(({ where }) => where).sort()).toEqual(cards.map(({ where }) => where).sort());
    expect(cards.map(({ where }) => where)).toContain("permissions/egress-approval.ts#createApprovalGateEgressRequester");
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
      expect(saves.some(({ where: scope, node: call }) => scope === where && call.pos > (verdict?.node.pos ?? Infinity) &&
        call.arguments[0]?.getText() === cardName && call.arguments[1]?.getText() === verdict?.node.arguments[1]?.getText()), where).toBe(true);
    }
    const spends = calls("spendStandingAnswer")
      .filter(({ node }) => node.arguments[1]?.getText() === '"rule-save"').map(({ where }) => where);
    expect(spends).toEqual(["permissions/approval-gate.ts#commitStagedAllowSaves"]);
  });
});
