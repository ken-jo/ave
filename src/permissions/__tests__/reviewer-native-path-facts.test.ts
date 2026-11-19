import { beforeEach, describe, expect, it, vi } from "vitest";

const observations = vi.hoisted(() => ({
  targets: new Map<string, string>(),
  sensitiveReads: new Map<string, boolean>(),
  resolutions: [] as string[],
  inspections: [] as Array<{ path: string; effect: string }>,
  matches: [] as string[],
}));

vi.mock("../../shared/tool-path-resolution.js", async () => {
  const { win32 } = await import("node:path");
  return { resolveToolPathForPermission: (value: string, cwd: string) => win32.resolve(cwd, value) };
});

vi.mock("../sensitive-paths.js", async original => {
  const actual = await original<typeof import("../sensitive-paths.js")>();
  const resolveNative = (path: string): string => observations.targets.get(path) ?? path;
  const fold = (path: string): string => actual.foldCanonicalPathSeparators(path, "win32").toLowerCase();
  return {
    ...actual,
    canonicalizePathForMatch: (path: string) => fold(resolveNative(path)),
    caseFoldForMatch: (path: string) => path.toLowerCase(),
    resolvePathForPolicy: (path: string) => {
      observations.resolutions.push(path);
      return resolveNative(path);
    },
    isSensitivePath: (path: string, effect: string) => {
      observations.inspections.push({ path, effect });
      return effect === "read" && path.toLowerCase().endsWith(".pem") &&
        observations.sensitiveReads.get(path) !== false ? "**/*.pem" : null;
    },
  };
});

vi.mock("../allowed-directories.js", async original => {
  const actual = await original<typeof import("../allowed-directories.js")>();
  return {
    ...actual,
    isPathAllowed: (...args: Parameters<typeof actual.isPathAllowed>) => {
      observations.matches.push(args[0]);
      return actual.isPathAllowed(...args);
    },
  };
});

import { _internal, RuleBasedRiskClassifier, type ToolInvocationContext } from "../reviewer/risk-classifier.js";

beforeEach(() => {
  observations.targets.clear();
  observations.sensitiveReads.clear();
  observations.resolutions.length = 0;
  observations.inspections.length = 0;
  observations.matches.length = 0;
});

function context(paths: string[], allowedDirectories = ["c:/project"]): ToolInvocationContext {
  return {
    toolName: "write_file",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "user-keyboard",
    finalInput: { path: paths },
    executionCwd: "C:\\Project",
    allowedDirectories,
    sensitivePathsAdjacent: [],
    sandboxCapability: { kind: "none", confidence: "verified", platform: "win32", reason: "none" },
  };
}

function hostFacts(input: ToolInvocationContext) {
  const prompt = _internal.buildUserPrompt(input, { level: "low", reason: "path facts" });
  const match = /<HOST_POLICY_FACTS>\n([\s\S]*?)\n<\/HOST_POLICY_FACTS>/.exec(prompt);
  if (match?.[1] === undefined) throw new Error("Host policy facts missing");
  return JSON.parse(match[1]) as {
    declaredPathCount: number;
    allDeclaredPathsInsideAllowedDirectories: boolean;
    anyDeclaredPathSensitiveRead: boolean;
    declaredPaths: Array<{ path: string; insideAllowedDirectories: boolean; sensitiveRead: boolean }>;
  };
}

describe("reviewer native path facts", () => {
  it("inspects and displays the stored native target after resolving the operand once", () => {
    const operand = "C:\\Project\\Cafe\u0301\\cErT.PEM";
    const nativePath = "C:\\Project\\Cafe\u0301\\Cert.pem";
    observations.targets.set(operand, nativePath);
    observations.sensitiveReads.set(nativePath, false);

    const facts = hostFacts(context([operand]));

    expect(facts.declaredPaths).toEqual([{
      path: nativePath,
      pathTruncated: false,
      insideAllowedDirectories: true,
      sensitiveRead: false,
      sensitiveWrite: false,
    }]);
    expect(observations.resolutions).toEqual([operand]);
    expect(observations.inspections).toEqual([
      { path: nativePath, effect: "read" },
      { path: nativePath, effect: "write" },
    ]);
    expect(observations.matches).toEqual(["c:/project/caf\u00e9/cert.pem"]);
  });

  it.each([
    ["caf\u00e9.pem", "cafe\u0301.pem"],
    ["K.pem", "\u212a.pem"],
    ["cert.pem", "Cert.pem"],
  ])("keeps separate content facts for native names with one policy key: %s and %s", (harmless, secret) => {
    const harmlessPath = `C:\\Project\\${harmless}`;
    const secretPath = `C:\\Project\\${secret}`;
    observations.sensitiveReads.set(harmlessPath, false);
    observations.sensitiveReads.set(secretPath, true);

    const facts = hostFacts(context([harmlessPath, secretPath]));

    expect(facts.declaredPathCount).toBe(2);
    expect(facts.declaredPaths.map(({ path, sensitiveRead }) => ({ path, sensitiveRead }))).toEqual([
      { path: harmlessPath, sensitiveRead: false },
      { path: secretPath, sensitiveRead: true },
    ]);
    expect(facts.anyDeclaredPathSensitiveRead).toBe(true);
    expect(facts.allDeclaredPathsInsideAllowedDirectories).toBe(true);
    expect(observations.inspections.filter(({ effect }) => effect === "read").map(({ path }) => path))
      .toEqual([harmlessPath, secretPath]);
    expect(observations.matches[0]).toBe(observations.matches[1]);
  });

  it.each([
    ["C:\\Project\\Cafe\u0301\\Report.txt", "low", true],
    ["C:\\Other\\Cafe\u0301\\Report.txt", "high", false],
  ] as const)("keeps folded scope matching for native target %s", (nativePath, level, insideAllowedDirectories) => {
    const input = context([nativePath], ["c:/project/caf\u00e9"]);

    expect(new RuleBasedRiskClassifier().classify(input).level).toBe(level);
    expect(hostFacts(input)).toMatchObject({ allDeclaredPathsInsideAllowedDirectories: insideAllowedDirectories });
    expect(observations.matches.length).toBeGreaterThan(0);
    for (const path of observations.matches) {
      expect(path).toBe(nativePath.replace(/\\/g, "/").normalize("NFC").toLowerCase());
    }
  });
});
