import { describe, expect, it } from "vitest";
import {
  scrubPackagedProcessEnv,
  shouldScrubPackagedEnvKey,
} from "../packaged-env-scrub.js";
import { PACKAGED_DEVELOPMENT_ENV_VARS } from "../../shared/development-env-policy.js";

describe("packaged env scrub", () => {
  it("scrubs dev/test flags before packaged preload inheritance", () => {
    const env: NodeJS.ProcessEnv = {
      AVE_DEV: "1",
      AVE_DEV_CONSOLE: "1",
      AVE_E2E: "1",
      AVE_DEBUG_STREAM: "1",
      VITE_DEBUG_STREAM: "1",
      AVE_WIN_NO_SANDBOX: "1",
      AVE_PLUGINS_DIR: "/tmp/plugins",
      AVE_ADMISSION_OFFLINE: "1",
      AVE_REVOCATION_OFFLINE: "1",
      AVE_WHITELIST_OFFLINE: "1",
      AVE_DEMO_KEY_OPENAI: "legacy-secret",
      AVE_DEMO_HOST_MAP: "api.internal=10.0.0.1",
      AVE_HOME: "/tmp/ave-home",
      NODE_ENV: "development",
    };

    const scrubbed = scrubPackagedProcessEnv(env).sort();

    expect(scrubbed).toEqual([
      "AVE_ADMISSION_OFFLINE",
      "AVE_DEBUG_STREAM",
      "AVE_DEMO_HOST_MAP",
      "AVE_DEMO_KEY_OPENAI",
      "AVE_DEV",
      "AVE_DEV_CONSOLE",
      "AVE_E2E",
      "AVE_PLUGINS_DIR",
      "AVE_REVOCATION_OFFLINE",
      "AVE_WHITELIST_OFFLINE",
      "AVE_WIN_NO_SANDBOX",
      "VITE_DEBUG_STREAM",
    ]);
    expect(env).toEqual({
      AVE_HOME: "/tmp/ave-home",
      NODE_ENV: "development",
    });
  });

  it("scrubs every exact variable in the canonical development inventory", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      PACKAGED_DEVELOPMENT_ENV_VARS.map((name) => [name, "set"]),
    );

    expect(scrubPackagedProcessEnv(env).sort()).toEqual([...PACKAGED_DEVELOPMENT_ENV_VARS].sort());
    expect(env).toEqual({});
  });

  it("keeps the packaged scrub predicate aligned with dev-flags SOT", () => {
    expect(shouldScrubPackagedEnvKey("AVE_DEV_RELOAD")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_E2E")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_DEBUG_STREAM")).toBe(true);
    expect(shouldScrubPackagedEnvKey("VITE_DEBUG_STREAM")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_ADMISSION_OFFLINE")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_REVOCATION_OFFLINE")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_WHITELIST_OFFLINE")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_DEMO_KEY_OPENAI")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_DEMO_HOST_MAP")).toBe(true);
    expect(shouldScrubPackagedEnvKey("AVE_HOME")).toBe(false);
    expect(shouldScrubPackagedEnvKey("OPENAI_API_KEY")).toBe(false);
  });
});
