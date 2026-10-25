/** Reject environment-name overrides case-insensitively because Windows treats case variants as the same key. */
import { describe, expect, it } from "vitest";
import { isSafeMcpEnvironmentName } from "../safe-names.js";

describe("isSafeMcpEnvironmentName", () => {
  it.each(["SMOKE_VENDOR_DIR", "API_TOKEN", "_PRIVATE", "PYTHONUNBUFFERED"])("admits %s", (name) => {
    expect(isSafeMcpEnvironmentName(name)).toBe(true);
  });

  it.each(["PLUGIN_ROOT", "plugin_root", "Plugin_Root", "PLUGIN_DATA", "plugin_data", "Plugin_Data"])(
    "refuses the host-owned name %s in every spelling",
    (name) => {
      expect(isSafeMcpEnvironmentName(name)).toBe(false);
    },
  );

  it.each(["PATH", "Path", "path", "BASH_ENV", "bash_env", "LD_PRELOAD", "NODE_OPTIONS", "PYTHONPATH", "DYLD_INSERT_LIBRARIES"])(
    "refuses the reserved name %s",
    (name) => {
      expect(isSafeMcpEnvironmentName(name)).toBe(false);
    },
  );

  it.each(["NPM_CONFIG_REGISTRY", "uv_index_url", "HTTPS_PROXY", "SSL_CERT_FILE"])(
    "refuses the launcher-family name %s",
    (name) => {
      expect(isSafeMcpEnvironmentName(name)).toBe(false);
    },
  );

  it.each(["1ABC", "A-B", "A=B", "", "X".repeat(65)])("refuses the malformed name %j", (name) => {
    expect(isSafeMcpEnvironmentName(name)).toBe(false);
  });
});
