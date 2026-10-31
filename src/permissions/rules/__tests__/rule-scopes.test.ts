import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { projectRulesLocation, updateProjectRulesFile } from "../project-rule-files.js";
import { ProjectRuleScopes } from "../rule-scopes.js";

let directory: string;
let project: string;
let nested: string;
let scopes: ProjectRuleScopes;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-rule-load-")));
  project = join(directory, "project");
  nested = join(project, "src");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(project, ".git", "objects"), { recursive: true });
  mkdirSync(join(project, ".git", "refs"));
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  scopes = new ProjectRuleScopes(directory);
});

afterEach(async () => cleanupTmpDir(directory));

describe("concurrent project rule loading", () => {
  it("shares a first load across working directories with the same project identity", async () => {
    const states = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      scopes.ensureLoaded(index % 2 === 0 ? project : nested)));
    expect(states.every(state => state === states[0])).toBe(true);
    expect(scopes.getRevision()).toBe(1);
    await scopes.ensureLoaded(project);
    expect(scopes.getRevision()).toBe(1);
  });

  it("reloads an edited policy once and retains its new revision and rules", async () => {
    const initial = await scopes.ensureLoaded(project);
    await updateProjectRulesFile(projectRulesLocation(directory, project), file => {
      file.rules.push({ pattern: "Network(example.test:443)", action: "deny" });
    });
    const states = await Promise.all([scopes.ensureLoaded(project), scopes.ensureLoaded(nested)]);
    expect(states[0]).toBe(states[1]);
    expect(states[0]).not.toBe(initial);
    expect(states[0]).toMatchObject({ ok: true, rules: [{ pattern: "Network(example.test:443)", action: "deny" }] });
    expect(scopes.getRevision()).toBe(2);
    expect(scopes.policyVersionFor(project)).toBeDefined();
  });

  it("clears a failed shared load so the next load can recover", async () => {
    const location = projectRulesLocation(directory, project);
    mkdirSync(location.filePath, { recursive: true });
    const failed = await Promise.allSettled([scopes.ensureLoaded(project), scopes.ensureLoaded(nested)]);
    expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(scopes.getRevision()).toBe(0);
    rmSync(location.filePath, { recursive: true });
    mkdirSync(dirname(location.filePath), { recursive: true });
    expect(await scopes.ensureLoaded(project)).toMatchObject({ ok: true, rules: [] });
    expect(scopes.getRevision()).toBe(1);
  });
});
