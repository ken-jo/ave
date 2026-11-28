import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ts } from "ts-morph";
import { expect, it } from "vitest";

const RUNNER_PATH = "src/tools/invocation-runner.ts";
const SENSITIVE_PATHS = "src/permissions/sensitive-paths.ts";

// Each operand walk must have its own synchronous boundary. Deferred callbacks open a new decision.
const entries: Readonly<Record<string, readonly string[]>> = {
  "src/plugins/isolation/out-of-process-plugin.ts": ["outermostContainingRoots(spec.envelope.read", "outermostContainingRoots(spec.envelope.write", "resolveUserChosenDirectory(inputs, grant"],
  "src/plugins/isolation/host-api-dispatcher.ts": ["assertGrantsWithinEnvelope(call, \"allowReadPaths\"", "assertGrantsWithinEnvelope(call, \"allowWritePaths\""],
  "src/permissions/asrt-sandbox.ts": ["isGrantPathWithin(root, path)", "assertWriteGrantsOutsideConfinementState(write, declaredConfinementStatePaths()", "readDenyEvidence(trustedSettings)", "admitFilesystemPolicy(trustedSettings)"],
  "src/permissions/sandbox-write-policy.ts": ["canonicalize(root)", "canonicalize(path)"],
  "src/sandbox/path-validator.ts": ["validateInDecision(path, cwd", "admitWindowsLookupPaths([path], \"preview\""],
  "src/permissions/rules/shell-rule-approval.ts": ["decodePowerShellEncodedCommands(command, dialect)", "exactRuleOf(dialect, command, cwd", "shellRuleCoversParsedCommand(dialect, pattern, action, command, cwd, commandSyntax("],
  "src/permissions/rules/shell-exfiltration.ts": ["inspectStatement(statement, cwd, context, single", "fileTransferOption(originalToken)", "nativePathProbe(candidate, cwd, context)"],
  "src/permissions/rules/powershell-exfiltration.ts": ["inspectParsed(asPowerShellCommand(input)", "inspectPowerShellPermissionPathsInDecision(...args)"],
  "src/tools/shell-path-policy.ts": ["findShellPathPolicyViolationInDecision(...args)"],
  "src/tools/pipeline/path-extraction.ts": ["findShellPathPolicyViolation("],
  "src/tools/shell-tools.ts": ["findPowerShellAstPathViolationInDecision("],
  "src/permissions/rules/scoped-rule-matcher.ts": ["editPaths(subject, root)", "editDepthCandidatesInDecision(path, cwd)"],
  "src/permissions/permission-manager.ts": ["this.evaluatePermissionInDecision(", "pathGrantRemovalMatcher(root, options?.preserveRoots)", "isAdmissionDeniedPath(target.canonicalPath, args.effect)"],
  [RUNNER_PATH]: [
    "targetFilePaths.map((path) => resolveFileTarget(path))",
    "resolveFileTarget(path)",
    "PermissionManager.checkPathScope(",
    "assertFileTargetsUnchanged()",
    "resolveFileTarget(target.filePath, observation !== undefined)",
  ],
  "src/tools/invocation-authorization.ts": ["assertFileTargetsUnchanged()"],
  "src/permissions/stage-workspace-binding.ts": ["bindings.set(sessionId, physical)", "inspectPhysicalFilesystemPath(path, root", "tryNativeRealpath(home)"],
  "src/permissions/unattended-lane.ts": ["tryNativeRealpath(root)"],
  "src/tools/file-access-policy.ts": ["admissionDeniedFilePattern(path, effect)", "resolvePathForPolicy(root)"],
  "src/tools/file-read-core.ts": ["assertReadableInDecision(inputPath"],
  "src/tools/guarded-file-transfer.ts": ["ensureFileAccess(path, context", "containsPath(source.path, lexicalDestination)", "containsPath(source.path, this.summary.destinationPath)"],
  "src/tools/file-tools.ts": ["admissionDeniedFilePattern(full)", "opts.skip(full)"],
  "src/tools/grep-search.ts": ["policy.admissionDenied(path)", "checkBoundSearchPath(path, cwd, roots, policy)", "judgedPathNamesOpenedFile(judged, opened)", "admissionDeniedFilePattern(root)", "localFs.stat(route)"],
  "src/ipc/domains/workspace.ts": ["isSensitiveEntry(sensitivePath)", "listedEntryType(ent, full)", "sanitizeRuntimeAllowedDirectories(additional)"],
  "src/ipc/domains/workspace-file-search.ts": ["assertReadableFilePath(match.path"],
  "src/ipc/domains/preview.ts": ["assertReadableFilePath(path, cwd, extraAllowed, audience)", "recordPreviewFileAccess(e, deps, resolved, sessionId)"],
  "src/main/preview-file-access.ts": ["currentScopeCovers(path, scope())", "isCurrent(receipt, receipt.owner.deps, scope)"],
  "src/permissions/reviewer/risk-classifier.ts": ["rule(input)", "extractDeclaredPathTargets(input).map("],
  "src/engine/turn/session.ts": ["previousSessionDirectories.filter(", "previousTurnDirectories.filter("],
  "src/permissions/workspace-root-lifecycle.ts": ["isPathAtOrBelow(removedRoot, directory)"],
  "src/hooks/hook-config-trust.ts": ["resolveHookConfigDirectory(configDir)", "hashHookCommandFiles(entry.command, entry.configDir)"],
  "src/memory/project-agents-md.ts": ["chainDirectories(top, canonicalProject)", "directoryLayer(top, dir, new Set(), new Set())"],
  "src/work-board/template-graph.ts": ["protectedControlEntryFor(path)", "isSensitivePath(path, \"read\")"],
  [SENSITIVE_PATHS]: [
    "admitLocalRoute(configured)",
    "localFs.realpathNative(admitLocalRoute(configured).verdict)",
    "projectLocalWindowsFilesystemPath(pathResolve(path), MAX_WALK_UP)",
  ],
  "src/permissions/shell-working-directory-identity.ts": ["captureShellWorkingDirectoryIdentity(cwd, batch)", "admitWindowsLookupPaths([...paths], \"shell-cwd\")"],
  "src/shared/windows-read-deny-evidence.ts": ["routeLocality(path)"],
  "src/shared/shell-execution.ts": ["inspectShellExecutionInDecision(command, cwd"],
  "src/shared/shell-filesystem-path.ts": ["physicalParentPath(absolute", "resolveFilesystemPath(path, cwd, maxMissingAncestors)"],
  "src/main/external-open-target.ts": ["resolveWindowsExternalOpenTarget(requested,", "windowsLinkChainVerdict(requested)", "authorize(target.real, pass)"],
  "src/permissions/mxc-windows.ts": ["canonicalPatternSpellings(requestedPatterns, baseAllows)"],
  "src/permissions/windows-grant-targets.ts": ["pinWindowsGrantTargetsInDecision(...args)"],
  "src/permissions/admitted-obligation.ts": ["admitLocalRoute(entry.target)"],
  "src/permissions/rules/git-repository-inputs.ts": ["inspectRepositoryInDecision(cwd)"],
  "src/tools/shell-executable-read-paths.ts": ["admitLocalRoute(executable.target)"],
  // Both platform arms reach their lookups through `holderPaths().targets`.
  "src/permissions/confined-child.ts": ["admitLocalRoute(executable.target,", "paths.targets([...grants.read, ...grants.write]", "paths.targets([spec.cwd]", "rankMxcFilesystem(windows.model)"],
  "src/main/host-script-runtime.ts": ["admitLocalRoute(left)", "admitLocalRoute(right)"],
};

function synchronousDecision(call: ts.CallExpression): ts.CallExpression | undefined {
  let node: ts.Node | undefined = call.parent;
  while (node !== undefined && !ts.isSourceFile(node)) {
    if (ts.isFunctionLike(node)) {
      const async = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      if (async) return undefined;
      const parent: ts.Node = node.parent;
      if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return undefined;
      if (ts.isIdentifier(parent.expression) && parent.expression.text === "withLocalityDecision") return parent;
      // An inline synchronous array callback runs before its caller returns.
      if (!ts.isPropertyAccessExpression(parent.expression)
        || !["every", "filter", "find", "flatMap", "map", "some"].includes(parent.expression.name.text)) return undefined;
    }
    node = node.parent;
  }
  return undefined;
}

function descendants<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  function visit(node: ts.Node): void {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
  return found;
}

function matchingCalls(calls: readonly ts.CallExpression[], anchor: string): ts.CallExpression[] {
  const matching = calls.filter(call => call.getText().startsWith(anchor));
  expect(matching.length, anchor).toBeGreaterThan(0);
  return matching;
}

function checkEntries(source: ts.SourceFile, anchors: readonly string[]): void {
  const calls = descendants(source, ts.isCallExpression);
  for (const anchor of anchors) {
    for (const call of matchingCalls(calls, anchor)) {
      expect(synchronousDecision(call) !== undefined, anchor).toBe(true);
    }
  }
}

function expectSharedDecision(calls: readonly ts.CallExpression[], anchors: readonly string[]): ts.CallExpression {
  const decisions = anchors.flatMap(anchor => matchingCalls(calls, anchor).map(synchronousDecision));
  const decision = decisions[0];
  assert(decision !== undefined && decisions.every(candidate => candidate === decision),
    `${anchors[0]} must share one synchronous locality decision with the rest of the judgment`);
  return decision;
}

function checkRunnerJudgments(source: ts.SourceFile): void {
  const initial = descendants(source, ts.isVariableDeclaration).find(node => node.name.getText() === "initialPathJudgment");
  assert(initial !== undefined, "Missing initialPathJudgment");
  const verify = descendants(initial, ts.isPropertyAssignment).find(node => node.name.getText() === "verify");
  assert(verify !== undefined, "Missing file seal verify");
  const verifierCalls = new Set(descendants(verify, ts.isCallExpression));
  const initialCalls = descendants(initial, ts.isCallExpression).filter(call => !verifierCalls.has(call));

  const initialDecision = expectSharedDecision(initialCalls, [
    "targetFilePaths.map((path) => resolveFileTarget(path))",
    "resolveFileTarget(path)",
    "PermissionManager.checkPathScope(",
    "createProjectMembership(executionCwd)",
    "inProject(target.canonicalPath)",
    "sanitizeAllowedDirectories(rawProjectRoots)",
    "observeWindowsTarget(parent)",
  ]);
  const verifierDecision = expectSharedDecision([...verifierCalls], [
    "resolveFileTarget(target.filePath, observation !== undefined)",
    "observeWindowsTarget(parent)",
    "sanitizeAllowedDirectories(rawProjectRoots)",
  ]);
  expect(verifierCalls.has(verifierDecision) && verifierDecision !== initialDecision, "file seal verify must open its own decision").toBe(true);
  expect(verifierDecision.arguments, "file seal verify must open a fresh decision").toHaveLength(1);
}

function checkSettingsJudgment(source: ts.SourceFile): void {
  const settings = descendants(source, ts.isFunctionDeclaration).find(node => node.name?.text === "protectRuntimeSettingsPath");
  assert(settings !== undefined, "Missing protectRuntimeSettingsPath");
  expectSharedDecision(descendants(settings, ts.isCallExpression), [
    "projectLocalWindowsFilesystemPath(pathResolve(path), MAX_WALK_UP)",
    "canonicalizePathForMatch(path)",
  ]);
}

function parseSource(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
}

it.each(Object.entries(entries))("%s encloses each listed judgment in a synchronous locality decision", (path, anchors) => {
  const source = parseSource(path, readFileSync(path, "utf8"));
  checkEntries(source, anchors);
  if (path === RUNNER_PATH) checkRunnerJudgments(source);
  if (path === SENSITIVE_PATHS) checkSettingsJudgment(source);
});

function replaceOnce(source: string, from: string, to: string): string {
  expect(source.split(from), from).toHaveLength(2);
  return source.replace(from, to);
}

it("rejects dividing the initial judgment between successive decisions", () => {
  const source = readFileSync(RUNNER_PATH, "utf8").replaceAll("\r\n", "\n");
  const split = replaceOnce(source,
    "const initialPathJudgment = () => withLocalityDecision(() => {\n      const expected = targetFilePaths.map((path) => resolveFileTarget(path));",
    "const initialPathJudgment = () => {\n      const expected = withLocalityDecision(() => targetFilePaths.map((path) => resolveFileTarget(path)));\n      return withLocalityDecision(() => {");
  const replay = replaceOnce(split, "return { sensitiveTarget, linkedTargets, projectRoots, insideProject };\n    });",
    "return { sensitiveTarget, linkedTargets, projectRoots, insideProject };\n      });\n    };");
  expect(() => checkRunnerJudgments(parseSource(RUNNER_PATH, replay))).toThrow("must share one synchronous locality decision");
});

it("rejects sanitizing project roots before the initial decision", () => {
  const source = readFileSync(RUNNER_PATH, "utf8").replaceAll("\r\n", "\n");
  const roots = "const rawProjectRoots = nativeFileWrite ? [executionCwd, ...(permissionContext.projectDirectories ?? [])] : [];\n      const projectRoots = sanitizeAllowedDirectories(rawProjectRoots);";
  const withoutRoots = replaceOnce(source, roots, "");
  const start = "const initialPathJudgment = () => withLocalityDecision(() => {";
  const replay = replaceOnce(withoutRoots, start, `${roots}\n    ${start}`);
  expect(() => checkRunnerJudgments(parseSource(RUNNER_PATH, replay))).toThrow("sanitizeAllowedDirectories(rawProjectRoots)");
});

it("rejects replacing the POSIX physical settings lookup with lexical resolution", () => {
  const source = readFileSync(SENSITIVE_PATHS, "utf8");
  const replay = replaceOnce(source, ": canonicalizePathForMatch(path),", ": pathResolve(path),");
  expect(() => checkSettingsJudgment(parseSource(SENSITIVE_PATHS, replay))).toThrow("canonicalizePathForMatch(path)");
});
