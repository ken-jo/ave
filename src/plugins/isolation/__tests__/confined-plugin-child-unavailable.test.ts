import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/index.js";
import { spawnConfinedPluginChild, type ConfinedPluginChildSpec } from "../out-of-process-plugin.js";

// The plugin child spawn on Windows: past the start guard its first step is the child's sandbox HOME, made under the real runtime root.
describe("a Windows plugin child without a proved container runtime root", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.runIf(process.platform === "win32")("is refused with the named reason before anything starts", async () => {
    // Nothing established in this file, and no root published by the run's set-up.
    vi.stubEnv("AVE_TEST_MXC_RUNTIME_ROOT", "null");
    const assertStillValid = vi.fn();
    await expect(spawnConfinedPluginChild({
      pluginId: "example", socketDir: "C:/example/plugin/sock", assertStillValid,
      launch: { kind: "entry", childEntryPath: "C:/example/plugin-child.js" },
      envelope: {} as ConfinedPluginChildSpec["envelope"],
    })).rejects.toMatchObject({ code: "sandbox-home-unavailable", message: t("sandboxPolicy.homesUnavailable") });
    expect(assertStillValid).toHaveBeenCalledOnce();
  });
});
