import { describe, expect, it } from "vitest";
import { findAveProtocolUri } from "../ave-protocol.js";

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
