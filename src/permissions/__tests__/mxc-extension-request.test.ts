import { describe, expect, it } from "vitest";
import { createMxcExtensionRequest } from "../../__tests__/support/mxc-supervisor.js";
import { assertMxcExtensionRequest } from "../mxc-extension-request.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";

describe("sealed extension request boundary", () => {
  it("accepts the fixed UI-enabled, endpoint-scoped request without widening paths", () => {
    const request = createMxcExtensionRequest(), before = JSON.stringify(request);
    expect(() => assertMxcExtensionRequest(request)).not.toThrow();
    expect(JSON.stringify(request)).toBe(before);
    expect(request.filesystem?.readonlyPaths).not.toContain("C:\\");
  });

  it.each(["ui", "telemetry", "inheritance", "backend", "cwd", "drive-root", "proxy", "environment", "enumeration"])("rejects invalid %s policy", (which) => {
    const request = createMxcExtensionRequest();
    switch (which) {
      case "ui": request.ui!.disable = true; break;
      case "telemetry": Object.assign(request, { telemetry: {} }); break;
      case "inheritance": request.inheritDefaultEnvironment = true; break;
      case "backend": request.containment = { type: "process" }; break;
      case "cwd": request.workingDirectory = "D:\\outside"; break;
      case "drive-root": request.filesystem!.readonlyPaths!.push("C:\\"); break;
      case "proxy": request.network!.runtimeConfig!.networkProxy = "http://example.test:80"; break;
      case "environment": request.environment!.MXC_FFI_DIR = "C:\\override"; break;
      case "enumeration": if (request.containment?.type === "processcontainer") delete request.containment.config!.filesystem!.enumeratePaths; break;
    }
    expect(() => assertMxcExtensionRequest(request)).toThrow(MxcProcessContractError);
  });
});
