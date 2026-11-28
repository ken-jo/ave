/** A real MCP stdio server started by `McpClient` on macOS's holder route: the handshake, a tool call and a disconnect
 * cross real native pipes into a Seatbelt holder, and the server cannot read the Ave home's protected files. The server is
 * system perl, outside every writable root. Its route-mocked twin is `mcp-client-mxc-holder.test.ts`. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAC_HOLDER_ROUTE, provenMacHolderRoute, type ProvenMacHolderRoute } from "../../__tests__/support/mac-holder-route.js";

vi.mock("../../main/default-workspace-root.js", async (actual) =>
  (await import("../../__tests__/support/holder-test-workspace.js")).holderTestWorkspaceRoot(await actual()));

const { McpClient } = await import("../mcp-client.js");
const { ToolRegistry } = await import("../../tools/registry.js");
const { unusedNetworkFetch } = await import("../../__tests__/support/network-fetch-stubs.js");
const { governanceWithPolicy, buildPolicy, stdioApproval } = await import("./test-helpers.js");
const { __resetWrappedMcpServersForTest, isMcpServerWrapped, setActiveSandboxCapability, __resetActiveSandboxCapabilityForTest,
  setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } = await import("../../permissions/sandbox-capability.js");

const PERL = "/usr/bin/perl";
// Newline-delimited JSON-RPC: answer the handshake, then report what the server could read.
const SERVER = String.raw`
$| = 1;
while (my $line = <STDIN>) {
  my ($id) = $line =~ /"id"\s*:\s*(\d+)/;
  my ($method) = $line =~ /"method"\s*:\s*"([^"]+)"/;
  next unless defined $id;
  my $result;
  if ($method eq "initialize") { $result = '{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"perl","version":"1"}}'; }
  elsif ($method eq "tools/list") { $result = '{"tools":[{"name":"probe","description":"probe","inputSchema":{"type":"object"}}]}'; }
  elsif ($method eq "tools/call") {
    my $secret = open(my $fh, "<", $ENV{PROBE_SECRET}) ? "secret-read" : "secret-denied:" . ($!+0);
    $result = '{"content":[{"type":"text","text":"pid=' . $$ . ' ' . $secret . '"}]}';
  }
  if (defined $result) { print '{"jsonrpc":"2.0","id":' . $id . ',"result":' . $result . "}\n"; }
  else { print '{"jsonrpc":"2.0","id":' . $id . ',"error":{"code":-32601,"message":"Method not found"}}' . "\n"; }
}
`;

// The macOS permission job requires its cases: a macOS runner without the holder route fails here instead of skipping.
if (process.platform === "darwin" && !MAC_HOLDER_ROUTE && process.env.AVE_REQUIRE_SANDBOX_CASES === "1") {
  throw new Error("AVE_REQUIRE_SANDBOX_CASES=1 but the macOS holder route is off on this host");
}

describe.runIf(MAC_HOLDER_ROUTE)("an MCP stdio server on macOS's holder route (native)", () => {
  let root: string;
  let route: ProvenMacHolderRoute;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-mac-holder-")));
    vi.stubEnv("AVE_HOME", join(root, "ave-home"));
    mkdirSync(join(root, "ave-home", "secrets"), { recursive: true, mode: 0o700 });
    route = provenMacHolderRoute();
    setPluginWorkerConfinementRequestedAtBoot(true);
    setActiveSandboxCapability({ kind: "asrt", platform: "darwin", confidence: "verified", reason: "test",
      confines: { filesystem: true, network: true, process: true } });
    __resetWrappedMcpServersForTest();
  });

  afterEach(async () => {
    __resetWrappedMcpServersForTest();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    await route.release();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("connects, calls a tool in the holder, is refused the Ave home's secrets, and ends with the disconnect", async () => {
    const script = join(root, "server.pl");
    writeFileSync(script, SERVER);
    const secret = join(root, "ave-home", "secrets", "token");
    writeFileSync(secret, "host-only");
    const sandboxRoot = join(root, "sandbox");
    mkdirSync(sandboxRoot);
    const config = { id: "perl", transport: "stdio" as const, command: PERL, args: [script], sandboxRoot, env: { PROBE_SECRET: secret } };
    const mcp = new McpClient(config, governanceWithPolicy(buildPolicy([stdioApproval(config.id, config.command)])), new ToolRegistry(), unusedNetworkFetch);
    await mcp.connect();
    expect(isMcpServerWrapped("perl")).toBe(true);
    const text = JSON.stringify(await mcp.callTool("probe", {}));
    expect(text).toMatch(/secret-denied:1\b/u);
    const pid = Number(/pid=(\d+)/u.exec(text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    // Control: the host reads the same file.
    expect((await import("node:fs")).readFileSync(secret, "utf8")).toBe("host-only");
    await mcp.disconnect();
    expect(isMcpServerWrapped("perl")).toBe(false);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000, interval: 50 });
  }, 60_000);
});
