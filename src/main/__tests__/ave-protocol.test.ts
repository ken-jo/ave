import { describe, expect, it } from "vitest";
import { findAveProtocolUri, parseAgentHubAuthUri } from "../ave-protocol.js";

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

describe("parseAgentHubAuthUri", () => {
  // 32-char URL-safe code — representative of a real agent-hub callback.
  const validCode = "abc123_DEF456-ghi789.JKL012~mno3";

  it("parses a well-formed agent-hub-auth URL", () => {
    expect(parseAgentHubAuthUri(`ave://agent-hub-auth?code=${validCode}`)).toEqual({
      code: validCode,
    });
  });

  it("accepts a trailing slash on the host (`ave://agent-hub-auth/?code=...`)", () => {
    expect(parseAgentHubAuthUri(`ave://agent-hub-auth/?code=${validCode}`)).toEqual({
      code: validCode,
    });
  });

  it("ignores URL fragments — they never reach the host process anyway", () => {
    expect(
      parseAgentHubAuthUri(`ave://agent-hub-auth?code=${validCode}#noise`),
    ).toEqual({ code: validCode });
  });

  it("rejects empty code (`?code=`)", () => {
    expect(parseAgentHubAuthUri("ave://agent-hub-auth?code=")).toBeNull();
  });

  it("rejects missing code", () => {
    expect(parseAgentHubAuthUri("ave://agent-hub-auth")).toBeNull();
  });

  it("rejects code shorter than the minimum length", () => {
    expect(parseAgentHubAuthUri("ave://agent-hub-auth?code=short")).toBeNull();
  });

  it("rejects code longer than the maximum length (>256)", () => {
    const tooLong = "a".repeat(257);
    expect(parseAgentHubAuthUri(`ave://agent-hub-auth?code=${tooLong}`)).toBeNull();
  });

  it("rejects parameter pollution (`?code=a&code=b`)", () => {
    expect(
      parseAgentHubAuthUri(`ave://agent-hub-auth?code=${validCode}&code=${validCode}`),
    ).toBeNull();
  });

  it("rejects non-agent-hub-auth host (`ave://install/...`)", () => {
    expect(parseAgentHubAuthUri("ave://install/my-plugin")).toBeNull();
  });

  it("rejects unrelated host (`ave://other-host?code=...`)", () => {
    expect(parseAgentHubAuthUri(`ave://other-host?code=${validCode}`)).toBeNull();
  });

  it("rejects non-ave schemes", () => {
    expect(parseAgentHubAuthUri(`https://agent-hub-auth?code=${validCode}`)).toBeNull();
  });

  it("rejects path segments under agent-hub-auth", () => {
    expect(
      parseAgentHubAuthUri(`ave://agent-hub-auth/extra?code=${validCode}`),
    ).toBeNull();
  });

  it("rejects code with disallowed characters", () => {
    // Spaces decode but aren't in the unreserved class.
    expect(
      parseAgentHubAuthUri("ave://agent-hub-auth?code=has%20space1234567"),
    ).toBeNull();
    // Slashes are not URL-safe-base64.
    expect(
      parseAgentHubAuthUri("ave://agent-hub-auth?code=has/slash1234567"),
    ).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parseAgentHubAuthUri("not a url")).toBeNull();
    expect(parseAgentHubAuthUri("")).toBeNull();
  });

  it("does not collide with parseAveInstallUri's domain (`ave://install/...`)", () => {
    // Documents that install URIs don't accidentally satisfy auth parser.
    expect(parseAgentHubAuthUri("ave://install/my-plugin?code=" + validCode)).toBeNull();
  });
});
