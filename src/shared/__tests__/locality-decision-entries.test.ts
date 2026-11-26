import { readFileSync } from "node:fs";
import { ts } from "ts-morph";
import { expect, it } from "vitest";

// Each operand walk must have its own synchronous boundary. Deferred callbacks open a new decision.
const entries: Readonly<Record<string, readonly string[]>> = {
  "src/plugins/isolation/out-of-process-plugin.ts": ["outermostContainingRoots(spec.envelope.read", "outermostContainingRoots(spec.envelope.write", "resolveUserChosenDirectory(inputs, grant"],
  "src/plugins/isolation/host-api-dispatcher.ts": ["assertGrantsWithinEnvelope(call, \"allowReadPaths\"", "assertGrantsWithinEnvelope(call, \"allowWritePaths\""],
  "src/permissions/asrt-sandbox.ts": ["isGrantPathWithin(root, path)", "assertWriteGrantsOutsideConfinementState(write, declaredConfinementStatePaths()", "buildSandboxConfigInDecision(...args)"],
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
  "src/tools/invocation-runner.ts": ["targetFilePaths.map(resolveFileTarget)", "PermissionManager.checkPathScope(", "assertFileTargetsUnchanged()"],
  "src/tools/invocation-authorization.ts": ["assertFileTargetsUnchanged()"],
  "src/permissions/stage-workspace-binding.ts": ["bindings.set(sessionId, physical)", "inspectPhysicalFilesystemPath(path, root", "tryLocalRealpath(home)"],
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
  "src/permissions/sensitive-paths.ts": ["admitLocalRoute(target, { projectMissing: true })", "runtimeSettingsScopes.set(scope, targets)"],
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
  "src/permissions/confined-child.ts": ["admitLocalRoute(executable.target,", "admitWindowsLookupPaths([...grants.read, ...grants.write]", "admitWindowsLookupPaths([spec.cwd]", "rankMxcFilesystem(admitted.model)"],
  "src/main/host-script-runtime.ts": ["admitLocalRoute(left)", "admitLocalRoute(right)"],
};

function synchronousBoundary(call: ts.CallExpression): boolean {
  let node: ts.Node | undefined = call.parent;
  while (node !== undefined && !ts.isSourceFile(node)) {
    if (ts.isFunctionLike(node)) {
      const async = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      if (async) return false;
      const parent: ts.Node = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments[0] === node
        && ts.isIdentifier(parent.expression) && parent.expression.text === "withLocalityDecision") return true;
      // An inline synchronous array callback runs before its caller returns.
      if (!ts.isCallExpression(parent) || !ts.isPropertyAccessExpression(parent.expression)
        || !["every", "filter", "find", "map", "some"].includes(parent.expression.name.text)) return false;
    }
    node = node.parent;
  }
  return false;
}

it.each(Object.entries(entries))("%s encloses each listed judgment in a synchronous locality decision", (path, anchors) => {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const anchor of anchors) {
    const matching = calls.filter(call => call.getText(source).startsWith(anchor));
    expect(matching.length, anchor).toBeGreaterThan(0);
    expect(matching.map(call => synchronousBoundary(call)), anchor).toEqual(matching.map(() => true));
  }
});
