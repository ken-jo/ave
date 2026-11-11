import { afterEach, describe, expect, it, vi } from "vitest";
import * as dlp from "../../shared/dlp.js";
import { bootstrapErrorForLog } from "../bootstrap-error-log.js";

afterEach(() => vi.restoreAllMocks());

describe("bootstrap error log boundary", () => {
  it("fails closed when diagnostic scrubbing throws while retaining the original cause", () => {
    const cause = new Error("synthetic internal preparation detail");
    const error = new Error("preparation failed", { cause });
    vi.spyOn(dlp, "scrubDiagnosticSecretsStrict").mockImplementation(() => {
      throw new Error("diagnostic scrubber unavailable");
    });
    expect(bootstrapErrorForLog(error)).toEqual({
      name: "Error", message: "[REDACTED:DIAGNOSTIC]", stack: "[REDACTED:DIAGNOSTIC]",
    });
    expect(error.cause === cause).toBe(true);
  });

  it("omits arbitrary error properties rather than exposing serializer raw references", () => {
    const error = Object.assign(new Error("preparation failed"), { unsafeDetail: "synthetic internal detail" });
    const projected = bootstrapErrorForLog(error);
    expect(Object.hasOwn(projected, "raw")).toBe(false);
    expect(Object.hasOwn(projected, "unsafeDetail")).toBe(false);
    expect(error.unsafeDetail).toBe("synthetic internal detail");
  });
});
