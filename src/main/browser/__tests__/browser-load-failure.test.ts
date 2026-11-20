import { describe, expect, it } from "vitest";
import { describeLoadFailure, describePageCrash } from "../browser-load-failure.js";

describe("describeLoadFailure", () => {
  it.each([
    [-105, "dns"], [-137, "dns"], [-106, "offline"], [-102, "connection"], [-118, "connection"], [-7, "connection"],
    [-201, "certificate"], [-202, "certificate"], [-299, "certificate"], [-107, "secure-connection"], [-113, "secure-connection"],
    [-312, "blocked"], [-20, "blocked"], [-310, "redirects"], [-2, "failed"], [-300, "failed"], [-501, "failed"],
  ] as const)("classifies network code %i as %s", (code, reason) => {
    expect(describeLoadFailure(code, "ERR_X", "https://site.example/").reason).toBe(reason);
  });

  it("keeps the code name as plain diagnostic text and only an address the browser may open", () => {
    expect(describeLoadFailure(-105, "ERR_NAME_NOT_RESOLVED <b>x</b>\n", "https://missing.invalid/a")).toEqual({
      reason: "dns", code: -105, detail: "ERR_NAME_NOT_RESOLVEDbxb", url: "https://missing.invalid/a",
    });
    expect(describeLoadFailure(-300, "ERR_INVALID_URL", "javascript:alert(1)").url).toBe("");
    expect(describeLoadFailure(-2, "E".repeat(500), "https://site.example/").detail).toHaveLength(100);
  });

  it("describes a crashed page by its exit reason", () => {
    expect(describePageCrash("oom", "https://site.example/")).toEqual({ reason: "crashed", code: 0, detail: "oom", url: "https://site.example/" });
  });
});
