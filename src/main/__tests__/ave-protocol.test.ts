import { describe, expect, it } from "vitest";
import {
  findAveProtocolUri,
  parseGitMarketplaceUri,
  parsePluginAuthUri,
} from "../ave-protocol.js";

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

  it("does not collide with the install route — `ave://install/...` is not auth", () => {
    // Documents that install URIs don't accidentally satisfy auth parser.
    expect(parsePluginAuthUri("ave://install/my-plugin?code=" + validCode)).toBeNull();
  });
});

describe("parseGitMarketplaceUri", () => {
  it("reads install and uninstall links with a kind, a package name and a source", () => {
    expect(parseGitMarketplaceUri("ave://install/plugin/calendar@ave")).toEqual({
      action: "install",
      key: { sourceId: "ave", kind: "plugin", name: "calendar" },
    });
    expect(parseGitMarketplaceUri("AVE://UNINSTALL/messaging-connection/team-chat@corp-tools")).toEqual({
      action: "uninstall",
      key: { sourceId: "corp-tools", kind: "messaging-connection", name: "team-chat" },
    });
  });

  it("reads an add link's address as given, for the Add dialog to check", () => {
    expect(parseGitMarketplaceUri("ave://marketplace/add?url=https%3A%2F%2Fgithub.com%2Facme%2Ftools")).toEqual({
      action: "add",
      url: "https://github.com/acme/tools",
    });
    expect(parseGitMarketplaceUri("ave://marketplace/add?url=acme%2Ftools")).toEqual({ action: "add", url: "acme/tools" });
  });

  it("refuses a folder named by a link: the Add dialog opens empty and says why (§18.3 #7)", () => {
    for (const address of ["file:///Users/me/market", "/Users/me/market", "~/market", "C:\\market", "\\\\server\\share\\market", "./market", "../market"]) {
      expect(parseGitMarketplaceUri(`ave://marketplace/add?url=${encodeURIComponent(address)}`), address).toEqual({ action: "add-refused", reason: "deep-link-path" });
    }
    // The address is not carried: nothing of the folder reaches the dialog.
    expect(JSON.stringify(parseGitMarketplaceUri("ave://marketplace/add?url=%2FUsers%2Fme%2Fsecret"))).not.toContain("secret");
  });

  it("reads no install link whose package or source has a credential's shape, and reads names that only look alike (§18.8)", () => {
    // Assembled here so no whole token sits in the source.
    const token = `glp${"at-"}${"abcd1234".repeat(3)}`;
    expect(parseGitMarketplaceUri(`ave://install/skill/${token}@corp-tools`)).toBeNull();
    expect(parseGitMarketplaceUri(`ave://install/skill/notes@${token}`)).toBeNull();
    expect(parseGitMarketplaceUri("ave://install/skill/test-marketplace2026@test-marketplace2026")).toEqual({
      action: "install",
      key: { sourceId: "test-marketplace2026", kind: "skill", name: "test-marketplace2026" },
    });
  });

  it("reads nothing from the server-era slug links it replaces (design §16.2)", () => {
    expect(parseGitMarketplaceUri("ave://install/my-plugin")).toBeNull();
    expect(parseGitMarketplaceUri("ave://install/plugin/my-plugin")).toBeNull();
    expect(parseGitMarketplaceUri("ave://mcp-login/context7-mcp")).toBeNull();
  });

  it("refuses anything outside the three shapes", () => {
    for (const url of [
      "ave://install/widget/calendar@ave",
      "ave://install/plugin/Calendar@ave",
      "ave://install/plugin/calendar@AVE",
      "ave://install/plugin/calendar@",
      "ave://install/plugin/@ave",
      "ave://install/plugin/cal--endar@ave",
      "ave://install/plugin/calendar@ave/extra",
      "ave://install/plugin/calendar@ave?auto=1",
      "ave://install/plugin/calendar@ave#now",
      "ave://marketplace/add",
      "ave://marketplace/add?url=",
      "ave://marketplace/add?url=a&id=b",
      "ave://marketplace/remove?url=acme%2Ftools",
      "ave://marketplace/add?url=acme%0Atools",
      `ave://marketplace/add?url=${"a".repeat(2049)}`,
      "https://install/plugin/calendar@ave",
    ]) {
      expect(parseGitMarketplaceUri(url), url).toBeNull();
    }
  });
});
