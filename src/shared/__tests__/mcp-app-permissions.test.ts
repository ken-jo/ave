/** Pure tests cover computed policy; browser enforcement is verified in test/e2e/ui/mcp-app-permissions.spec.ts. */
import { describe, it, expect } from "vitest";
import {
  MCP_APP_PERMISSION_FEATURES,
  buildMcpAppAllowAttr,
  declaredFeatures,
  isElectronPermissionGranted,
} from "../mcp-app-permissions.js";
import type { McpUiResourcePermissions } from "../../mcp/types.js";

describe("the host capability table", () => {
  it("carries ONLY the features proven to work end-to-end (camera, microphone, geolocation)", () => {
    expect(MCP_APP_PERMISSION_FEATURES.map((f) => f.key)).toEqual([
      "camera",
      "microphone",
      "geolocation",
    ]);
    // clipboardWrite is deliberately excluded — measured denied even when delegated.
    expect(MCP_APP_PERMISSION_FEATURES.some((f) => f.key === "clipboardWrite")).toBe(false);
  });
});

describe("buildMcpAppAllowAttr — the host-computed inner-frame allow-list", () => {
  it("declared ⇒ exactly the declared, table-known tokens, in TABLE order", () => {
    expect(buildMcpAppAllowAttr({ geolocation: {}, camera: {} })).toBe("camera; geolocation");
    expect(buildMcpAppAllowAttr({ camera: {}, microphone: {}, geolocation: {} })).toBe(
      "camera; microphone; geolocation",
    );
  });

  it("undeclared / empty / undefined ⇒ empty string (fail-closed: no allow attribute)", () => {
    expect(buildMcpAppAllowAttr(undefined)).toBe("");
    expect(buildMcpAppAllowAttr({})).toBe("");
  });

  it("a spec feature the host cannot honor (clipboardWrite) is NEVER delegated, even if declared", () => {
    expect(buildMcpAppAllowAttr({ clipboardWrite: {} })).toBe("");
    expect(buildMcpAppAllowAttr({ camera: {}, clipboardWrite: {} })).toBe("camera");
  });
});

describe("isElectronPermissionGranted — the fail-closed session decision", () => {
  it("grants a declared feature's Electron permission", () => {
    expect(isElectronPermissionGranted({ geolocation: {} }, "geolocation")).toBe(true);
    expect(isElectronPermissionGranted({ camera: {} }, "media", ["video"])).toBe(true);
    expect(isElectronPermissionGranted({ microphone: {} }, "media", ["audio"])).toBe(true);
  });

  it("denies an undeclared feature, an absent declaration, and an unmodelled permission", () => {
    expect(isElectronPermissionGranted({ geolocation: {} }, "media", ["video"])).toBe(false);
    expect(isElectronPermissionGranted(undefined, "geolocation")).toBe(false);
    expect(isElectronPermissionGranted({}, "geolocation")).toBe(false);
    expect(isElectronPermissionGranted({ geolocation: {} }, "notifications")).toBe(false);
    expect(isElectronPermissionGranted({ clipboardWrite: {} }, "clipboard-sanitized-write")).toBe(
      false,
    );
  });

  it("media-kind split: a mic-only card gets its mic and is DENIED the camera (and vice versa)", () => {
    const micOnly: McpUiResourcePermissions = { microphone: {} };
    expect(isElectronPermissionGranted(micOnly, "media", ["audio"])).toBe(true);
    expect(isElectronPermissionGranted(micOnly, "media", ["video"])).toBe(false);

    const camOnly: McpUiResourcePermissions = { camera: {} };
    expect(isElectronPermissionGranted(camOnly, "media", ["video"])).toBe(true);
    expect(isElectronPermissionGranted(camOnly, "media", ["audio"])).toBe(false);
  });

  it("a combined video+audio media request needs BOTH declared (fail-closed)", () => {
    expect(
      isElectronPermissionGranted({ camera: {}, microphone: {} }, "media", ["video", "audio"]),
    ).toBe(true);
    expect(isElectronPermissionGranted({ microphone: {} }, "media", ["video", "audio"])).toBe(false);
  });

  it("a `media` ask/check with an INDETERMINATE kind is fail-closed → DENIED (not a coarse-match grant)", () => {
    // Unknown media kind must deny; a microphone declaration cannot authorize an indeterminate camera request.
    expect(isElectronPermissionGranted({ microphone: {} }, "media")).toBe(false);
    expect(isElectronPermissionGranted({ microphone: {} }, "media", [])).toBe(false);
    expect(isElectronPermissionGranted({ camera: {} }, "media")).toBe(false);
    expect(isElectronPermissionGranted({ camera: {} }, "media", [])).toBe(false);
    expect(isElectronPermissionGranted({ camera: {}, microphone: {} }, "media", [])).toBe(false);
    expect(isElectronPermissionGranted({ geolocation: {} }, "media")).toBe(false);
  });

  it("the indeterminate-kind DENY is media-only: a kindless feature (geolocation) still grants on a declared match", () => {
    // Non-media grants do not require a media kind.
    expect(isElectronPermissionGranted({ geolocation: {} }, "geolocation")).toBe(true);
    expect(isElectronPermissionGranted({ geolocation: {}, microphone: {} }, "geolocation")).toBe(
      true,
    );
  });
});

describe("declaredFeatures", () => {
  it("filters to declared, table-known keys (drops clipboardWrite and unknowns)", () => {
    expect(declaredFeatures({ camera: {}, clipboardWrite: {} }).map((f) => f.key)).toEqual([
      "camera",
    ]);
    expect(declaredFeatures(undefined)).toEqual([]);
    expect(declaredFeatures({})).toEqual([]);
  });
});
