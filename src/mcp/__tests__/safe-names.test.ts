/**
 * The manifest-supplied environment-name rule, which MCP servers and `process`
 * entries share (docs/design/plugin-hostapi-protocol.md §9.7 P3, decision 36).
 *
 * Every refusal is case-insensitive: on Windows environment names are, and a
 * name that differs from a host-owned one only in case is never something a
 * plugin needs.
 */
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
