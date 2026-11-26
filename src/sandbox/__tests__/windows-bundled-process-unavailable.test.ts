import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.js";
import { spawnWindowsBundledProcess } from "../wrap-bundled-command.js";

// The MCP server and hook spawn on Windows: its first step is the process's sandbox HOME, made under the real runtime root.
describe("a Windows bundled process without a proved container runtime root", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.runIf(process.platform === "win32")("is refused with the named reason before anything starts", async () => {
    // Nothing established in this file, and no root published by the run's set-up.
    vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", "null");
    await expect(spawnWindowsBundledProcess({
      label: "mcp:example", command: "C:/Program Files/example/server.exe", args: [], baseEnv: {},
      allowRead: [], allowWrite: [], egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "example" },
    })).rejects.toMatchObject({ code: "sandbox-home-unavailable", message: t("sandboxPolicy.homesUnavailable") });
  });
});
