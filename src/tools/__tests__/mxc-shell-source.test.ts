import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../__tests__/test-helpers.js";

const shellTools = readRepoFile("src/tools/shell-tools.ts");
const powershellSectionStart = shellTools.indexOf(" * Native PowerShell tool.");
const bashSection = shellTools.slice(0, powershellSectionStart);
const powershellSection = shellTools.slice(powershellSectionStart);

function metadataObjects(source: string): string[] {
  return [...source.matchAll(/\bmetadata\s*:\s*\{([^{}]*)\}/g)].map((match) => match[1]);
}

function propertyName(property: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(property)?.[1];
}

function isUnavailableMetadata(metadata: string): boolean {
  const properties = metadata.split(",").map((property) => property.trim()).filter(Boolean);
  // Spreads and computed keys can overwrite any preceding verdict field.
  const lastUnknownWrite = properties.findLastIndex((property) => propertyName(property) === undefined);
  const expected = {
    sandboxed: /^sandboxed\s*:\s*false$/,
    sandboxAttempted: /^sandboxAttempted\s*:\s*true$/,
    isolation: /^isolation\s*:\s*(?:"unavailable"|'unavailable')$/,
  };
  return Object.entries(expected).every(([name, value]) => {
    const index = properties.findLastIndex((property) => propertyName(property) === name);
    return index > lastUnknownWrite && value.test(properties[index]);
  });
}

describe("stage workspace session contract", () => {
  it("every sandboxed shell composes its boundary snapshot for the calling session", () => {
    // Four routes, one snapshot each: the bash wrap, the PowerShell wrap, the Windows PowerShell container, and the macOS
    // container runner shared by bash and PowerShell. The macOS runner returns before either wrap takes its snapshot.
    expect(shellTools.match(/createAveHomeBoundarySnapshot\(/gu)).toHaveLength(4);
    expect(shellTools.match(/const boundarySnapshot = createAveHomeBoundarySnapshot\(sessionId\);/gu)).toHaveLength(3);
    const posixRunner = shellTools.slice(shellTools.indexOf("async function runPosixContainerShell("), shellTools.indexOf("export async function spawnWithSandbox("));
    expect(posixRunner.match(/createAveHomeBoundarySnapshot\(/gu)).toEqual(["createAveHomeBoundarySnapshot("]);
    expect(posixRunner).toContain("const boundary = createAveHomeBoundarySnapshot(input.sessionId);");
    expect(posixRunner).toContain("const launch = await boundary.run(() => prepareMxcPosixShellLaunch({");
    for (const [start, end] of [["export async function spawnWithSandbox(", "async function spawnWithTimeout("], ["async function spawnPowerShellWithSandbox(", "async function spawnPowerShellInMxc("]] as const) {
      const route = shellTools.slice(shellTools.indexOf(start), shellTools.indexOf(end));
      const call = route.indexOf("return await runPosixContainerShell({");
      expect(call).toBeGreaterThan(-1);
      expect(route.slice(call, route.indexOf("});", call))).toMatch(/\bsessionId\b/u);
      expect(call).toBeLessThan(route.indexOf("const boundarySnapshot = createAveHomeBoundarySnapshot(sessionId);"));
    }
    expect(bashSection.match(/boundarySessionOf\(ctx\)/gu)).toHaveLength(1);
    expect(powershellSection.match(/boundarySessionOf\(ctx\)/gu)).toHaveLength(3);
    expect(powershellSection).toContain("launch = await boundarySnapshot.run(() => prepareMxcShellLaunch({");
  });
});

describe("background shell lifetime contract", () => {
  it("registers the background child with the managed-child registry", () => {
    expect(bashSection).toMatch(/trackManagedChildProcess\(child,\s*\{\s*label:\s*"tool:bash:background",\s*killProcessGroup,?\s*\}\)/);
    expect(bashSection).toContain('spawnWindowsJobProcess(shell.cmd, [...argv], { cwd, env }, hold)');
    expect(bashSection).toContain("detached: true");
    expect(bashSection).toContain('killProcessGroup: process.platform !== "win32"');
  });

  it("states the lifetime in the parameter the model chooses from", () => {
    expect(bashSection).toContain("The shell is bound to this session and is ");
    expect(bashSection).toContain("terminated when the session ends");
  });

  it("states the lifetime again in the result the model reads back", () => {
    expect(bashSection).toContain("This shell is managed by the session and is stopped when the session ends.");
    expect(bashSection).toContain("Descendants that leave the owned process group may survive its cleanup.");
  });
});

describe("shell unavailable metadata", () => {
  it("does not claim isolation before a command starts in its container", () => {
    const helperStart = shellTools.indexOf("function mxcSpawnFailure(");
    expect(helperStart).toBeGreaterThanOrEqual(0);
    const helper = metadataObjects(shellTools.slice(helperStart, shellTools.indexOf("\n}\n", helperStart)));
    expect(helper.map(isUnavailableMetadata)).toEqual([true]);
    const start = shellTools.indexOf("async function spawnPowerShellInMxc(");
    const end = shellTools.indexOf("async function spawnPowerShell(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const implementation = shellTools.slice(start, end);
    expect(metadataObjects(implementation).filter((metadata) => /\bsandboxAttempted\s*:/.test(metadata))).toEqual([]);
  });

  it("lets failure verdicts override preceding artifact metadata, but rejects later overrides", () => {
    const verdict = 'sandboxed: false, sandboxAttempted: true, isolation: "unavailable"';
    for (const prefix of ["", "...artifactMetadata, ", "...cleanupMetadata, "]) {
      expect(isUnavailableMetadata(prefix + verdict)).toBe(true);
    }
    for (const suffix of ["...artifactMetadata", "...cleanupMetadata", "sandboxed: true", "sandboxAttempted: false", 'isolation: "asrt"', "[unknownKey]: true"]) {
      expect(isUnavailableMetadata(`${verdict}, ${suffix}`)).toBe(false);
    }
  });
});
