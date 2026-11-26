// windows-permission
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getConfiguredHostResources } from "../../main/host-resources.js";
import { windowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import { physicalReadTarget, pinSandboxLookups } from "../../sandbox/path-validator.js";
import * as windowsPathFacts from "../../shared/windows-path-facts.js";
import { admitObligations, type ObligationRow } from "../admitted-obligation.js";

const deny = (spelling: string): ObligationRow => ({ spelling, polarity: { effect: "deny", access: "read" }, source: "settings" });

describe.runIf(process.platform === "win32")("admitObligations pin failures", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "obligation-pin-failure-")));
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());

  it("throws a missing host-resources configuration instead of reporting an incomplete walk", () => {
    expect(getConfiguredHostResources()).toBeUndefined();
    expect(() => admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "a"))] }))
      .toThrow("host-resources-unavailable");
  });

  it("surfaces missing host resources from a physical read lookup", () => {
    expect(getConfiguredHostResources()).toBeUndefined();
    expect(() => physicalReadTarget(join(root, "a"), root, [])).toThrow(/^host-resources-unavailable$/u);
  });

  it("surfaces missing host resources while pinning sandbox lookups", () => {
    expect(getConfiguredHostResources()).toBeUndefined();
    expect(() => pinSandboxLookups([join(root, "a"), root])).toThrow(/^host-resources-unavailable$/u);
  });

  it("throws a malformed helper reply", () => {
    vi.spyOn(windowsPathFacts, "pinWindowsPaths").mockImplementation(() => { throw new Error("Invalid Windows path pin"); });
    expect(() => admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "a"))] }))
      .toThrow("Invalid Windows path pin");
  });

  it("reports an unavailable helper once per batch as helper-unavailable", () => {
    const pin = vi.spyOn(windowsPathFacts, "pinWindowsPaths").mockImplementation(() => {
      throw windowsPathKindHelperUnavailable("Windows path facts helper did not answer", "ETIMEDOUT");
    });
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "a")), deny(join(root, "b"))] });
    expect(set.unresolved.map(row => row.reason)).toEqual(["helper-unavailable", "helper-unavailable"]);
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it("reports a path the helper cannot read as an incomplete walk", () => {
    vi.spyOn(windowsPathFacts, "pinWindowsPaths").mockImplementation(() => {
      throw Object.assign(new Error("Windows path facts helper failed (exit 4)"), { status: 4 });
    });
    const set = admitObligations({ purpose: "sandbox-config", principal: "srt-sandbox", rows: [deny(join(root, "a"))] });
    expect(set.unresolved.map(row => row.reason)).toEqual(["incomplete-walk"]);
  });
});
