import { createRequire } from "node:module";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
import { buildJavaToolOptions, getJavaProxyAgentJarPathAsync } from "@anthropic-ai/sandbox-runtime/dist/sandbox/java-proxy-agent.js";
import { buildSandboxConfig, getVendoredJavaProxyAgentJarPath, rewriteAsarPathToUnpacked } from "../asrt-sandbox.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JVM proxy agent resource", () => {
  it("configures the installed host-owned agent for external processes", async () => {
    const expected = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")),
      "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
    const path = getVendoredJavaProxyAgentJarPath();
    expect(path).toBe(expected);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).size).toBeGreaterThan(0);
    expect(buildSandboxConfig({}).javaAgentJarPath).toBe(
      process.platform === "win32" ? undefined : path,
    );
    // ASRT 0.0.79 resolves the jar asynchronously; the sync form is gone.
    await expect(getJavaProxyAgentJarPathAsync(path)).resolves.toBe(path);
  });

  it("passes the physical archive sidecar path to the external JVM", async () => {
    const root = mkdtempSync(join(tmpdir(), "jvm-agent-resource-"));
    roots.push(root);
    const virtual = join(root, "resources", "app.asar", "node_modules", "@anthropic-ai",
      "sandbox-runtime", "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
    const physical = rewriteAsarPathToUnpacked(virtual);
    mkdirSync(dirname(physical), { recursive: true });
    cpSync(getVendoredJavaProxyAgentJarPath(), physical);
    const selected = await getJavaProxyAgentJarPathAsync(physical);
    expect(selected).toBe(physical);
    if (selected === null) throw new Error("Physical JVM agent was not resolved");
    const options = buildJavaToolOptions({ agentJarPath: selected ?? undefined, inherited: "-Xmx128m" });
    expect(options).toContain(`-javaagent:${physical}`);
    expect(options).toContain("-Xmx128m");
    expect(options).not.toContain(virtual);
  });
});
