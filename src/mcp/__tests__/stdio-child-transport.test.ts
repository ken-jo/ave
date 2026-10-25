/** Verify host projection over a real subprocess and reject pending requests when it crashes. */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { StdioChildTransport } from "../experimental/stdio-child-transport.js";
import { PluginMcpHost } from "../plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";

const FIXTURE = resolve(__dirname, "..", "..", "..", "test", "fixtures", "mcp", "echo-stdio-server.mjs");

function makeHost(registry: ToolRegistry): PluginMcpHost {
  const transport = new StdioChildTransport(process.execPath, [FIXTURE], {
    maxLineBytes: 1024 * 1024,
  });
  void registry;
  return new PluginMcpHost("echo", transport, {}, "test-generation");
}

async function publishTestHost(host: PluginMcpHost, registry: ToolRegistry): Promise<string[]> {
  const tools = await host.prepareTools();
  registry.reservePluginReplacement("echo", tools, []).publish();
  host.publishPrepared(tools);
  return tools.map((tool) => tool.name);
}

async function retireTestHost(host: PluginMcpHost, registry: ToolRegistry): Promise<void> {
  registry.reservePluginReplacement("echo", [], []).publish();
  await host.dispose();
}

describe("StdioChildTransport — out-of-process plugin over a real subprocess", () => {
  it("discovers + registers the subprocess plugin's tools and round-trips a call", async () => {
    const registry = new ToolRegistry();
    const host = makeHost(registry);

    const registered = await publishTestHost(host, registry);
    expect(registered).toEqual(["echo_say"]);

    const tool = registry.findByName("echo_say");
    expect(tool?.source).toBe("plugin");
    // Wire risk claims cannot lower the registration baseline; the host classifies each invocation.
    expect(tool?.category).toBe("write");

    const out = await tool!.execute({ msg: "hi" }, {} as never);
    expect(out).toEqual({ output: "echo: hi", isError: false });

    await retireTestHost(host, registry);
  }, 15_000);

  it("contains a plugin crash — a mid-call subprocess exit surfaces as an error, not a hang", async () => {
    const registry = new ToolRegistry();
    const host = makeHost(registry);
    await publishTestHost(host, registry);

    // Child exit must reject pending calls instead of leaving them to time out.
    const result = await registry.findByName("echo_say")!.execute({ crash: true }, {} as never);
    expect(result.isError).toBe(true);

    await retireTestHost(host, registry);
  }, 15_000);

  it("kills a child whose stdout passes the line bound without a newline", async () => {
    // Bound unterminated child output so a missing newline cannot exhaust host memory.
    const transport = new StdioChildTransport(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000);"],
      { maxLineBytes: 1024 },
    );
    const closed = new Promise<string>((resolve) => transport.onClose(resolve));
    await transport.open();
    expect(await closed).toMatch(/framing violated: .*exceeded 1024 bytes/);
    expect(transport.isAlive()).toBe(false);
  }, 15_000);
});
