import { describe, expect, it } from "vitest";
import { findAveProtocolUri, parseMarketplacePluginActionUri, parsePluginAuthUri } from "../ave-protocol.js";

describe("findAveProtocolUri", () => {
  it("returns the custom protocol URI from argv", () => {
    expect(
      findAveProtocolUri([
        "/Applications/Ave.app/Contents/MacOS/Ave",
        "--flag",
        "ave://install/my-plugin",
      ]),
    ).toBe("ave://install/my-plugin");
  });

  it("returns null when argv has no ave protocol URI", () => {
    expect(findAveProtocolUri(["/usr/bin/ave", "--flag", "https://example.com"])).toBeNull();
  });

  it("matches uppercase scheme AVE://", () => {
    expect(
      findAveProtocolUri(["/Applications/Ave.app/Contents/MacOS/Ave", "AVE://install/plugin"]),
    ).toBe("AVE://install/plugin");
  });

  it("matches mixed-case scheme e.g. Ave://", () => {
    expect(findAveProtocolUri(["Ave://open/dashboard"])).toBe("Ave://open/dashboard");
  });

  it("returns the first matching URI when multiple are present", () => {
    expect(
      findAveProtocolUri(["ave://first", "AVE://second"]),
    ).toBe("ave://first");
  });
});

describe("parsePluginAuthUri", () => {
  // 32-char URL-safe code — representative of a real plugin OAuth callback.
  const validCode = "abc123_DEF456-ghi789.JKL012~mno3";

  it("parses a well-formed plugin-auth URL with pluginId 'agent-hub'", () => {
    expect(parsePluginAuthUri(`ave://plugin-auth/agent-hub?code=${validCode}`)).toEqual({
      pluginId: "agent-hub",
      code: validCode,
    });
  });

  it("parses a well-formed plugin-auth URL with a different pluginId", () => {
    expect(parsePluginAuthUri(`ave://plugin-auth/some-other-plugin?code=${validCode}`)).toEqual({
      pluginId: "some-other-plugin",
      code: validCode,
    });
  });

  it("ignores URL fragments — they never reach the host process anyway", () => {
    expect(
      parsePluginAuthUri(`ave://plugin-auth/agent-hub?code=${validCode}#noise`),
    ).toEqual({ pluginId: "agent-hub", code: validCode });
  });

  it("rejects empty code (`?code=`)", () => {
    expect(parsePluginAuthUri("ave://plugin-auth/agent-hub?code=")).toBeNull();
  });

  it("rejects missing code", () => {
    expect(parsePluginAuthUri("ave://plugin-auth/agent-hub")).toBeNull();
  });

  it("rejects code shorter than the minimum length", () => {
    expect(parsePluginAuthUri("ave://plugin-auth/agent-hub?code=short")).toBeNull();
  });

  it("rejects code longer than the maximum length (>256)", () => {
    const tooLong = "a".repeat(257);
    expect(parsePluginAuthUri(`ave://plugin-auth/agent-hub?code=${tooLong}`)).toBeNull();
  });

  it("rejects parameter pollution (`?code=a&code=b`)", () => {
    expect(
      parsePluginAuthUri(`ave://plugin-auth/agent-hub?code=${validCode}&code=${validCode}`),
    ).toBeNull();
  });

  it("rejects missing pluginId (`ave://plugin-auth?code=...`)", () => {
    expect(parsePluginAuthUri(`ave://plugin-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects empty pluginId (`ave://plugin-auth/?code=...`)", () => {
    expect(parsePluginAuthUri(`ave://plugin-auth/?code=${validCode}`)).toBeNull();
  });

  it("rejects pluginId with invalid characters (uppercase, '!')", () => {
    expect(
      parsePluginAuthUri(`ave://plugin-auth/Bad-PluginID!?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects pluginId starting with a digit", () => {
    expect(
      parsePluginAuthUri(`ave://plugin-auth/1plugin?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects extra path segments under plugin-auth", () => {
    expect(
      parsePluginAuthUri(`ave://plugin-auth/agent-hub/extra?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects the legacy `ave://agent-hub-auth?code=...` host (no backwards compat)", () => {
    expect(parsePluginAuthUri(`ave://agent-hub-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects unrelated host (`ave://other-host?code=...`)", () => {
    expect(parsePluginAuthUri(`ave://other-host?code=${validCode}`)).toBeNull();
  });

  it("rejects non-ave schemes", () => {
    expect(parsePluginAuthUri(`https://plugin-auth/agent-hub?code=${validCode}`)).toBeNull();
  });

  it("rejects code with disallowed characters", () => {
    // Spaces decode but aren't in the unreserved class.
    expect(
      parsePluginAuthUri("ave://plugin-auth/agent-hub?code=has%20space1234567"),
    ).toBeNull();
    // Slashes are not URL-safe-base64.
    expect(
      parsePluginAuthUri("ave://plugin-auth/agent-hub?code=has/slash1234567"),
    ).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parsePluginAuthUri("not a url")).toBeNull();
    expect(parsePluginAuthUri("")).toBeNull();
  });

  it("does not collide with the install route — `ave://install/<slug>` is not auth", () => {
    // Documents that install URIs don't accidentally satisfy auth parser.
    expect(parsePluginAuthUri("ave://install/my-plugin?code=" + validCode)).toBeNull();
  });
});

describe("parseMarketplacePluginActionUri", () => {
  it("parses install and uninstall plugin action URLs", () => {
    expect(parseMarketplacePluginActionUri("ave://install/agent-hub")).toEqual({
      action: "install",
      slug: "agent-hub",
      packageType: "plugin",
    });
    expect(parseMarketplacePluginActionUri("ave://uninstall/agent-hub")).toEqual({
      action: "uninstall",
      slug: "agent-hub",
      packageType: "plugin",
    });
  });

  it("accepts URL-encoded slug paths after decoding", () => {
    expect(parseMarketplacePluginActionUri("ave://uninstall/agent.hub_2")).toEqual({
      action: "uninstall",
      slug: "agent.hub_2",
      packageType: "plugin",
    });
  });

  it("parses package-typed marketplace action URLs", () => {
    expect(parseMarketplacePluginActionUri("ave://install/agent/research-helper")).toEqual({
      action: "install",
      slug: "research-helper",
      packageType: "agent",
    });
    expect(parseMarketplacePluginActionUri("ave://uninstall/skill/summarizer")).toEqual({
      action: "uninstall",
      slug: "summarizer",
      packageType: "skill",
    });
  });

  it("rejects query strings, fragments, unknown hosts, and unsafe slugs", () => {
    expect(parseMarketplacePluginActionUri("ave://uninstall/agent-hub?confirm=1")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://uninstall/agent-hub#confirm")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://remove/agent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://uninstall/%2E%2E%2Fagent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://uninstall/%E0%A4%A")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://install/theme/agent-hub")).toBeNull();
    expect(parseMarketplacePluginActionUri("ave://install/agent/agent-hub/extra")).toBeNull();
  });
});
