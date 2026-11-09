import { describe, expect, it } from "vitest";
import { BrowserSitePermissions } from "../browser-site-permissions.js";
import { decidePermission } from "../decision-pipeline.js";

describe("agent browser site permissions", () => {
  it("keeps exact origins within their own session", () => {
    const sites = new BrowserSitePermissions();
    sites.allow("parent", "https://example.test/a", "this-site");
    expect(sites.allows("parent", "https://example.test/b")).toBe(true);
    for (const url of ["http://example.test", "https://example.test:444", "https://other.test"]) expect(sites.allows("parent", url)).toBe(false);
    expect(sites.allows("child", "https://example.test")).toBe(false);
    expect(sites.allows("new", "https://example.test")).toBe(false);
    sites.clear("parent");
    expect(sites.allows("parent", "https://example.test")).toBe(false);
  });
  it("allows any web origin without granting other schemes or credentials", () => {
    const sites = new BrowserSitePermissions();
    sites.allow("session", "https://example.test", "any-site");
    for (const url of ["https://other.test:444", "http://other.test"]) expect(sites.allows("session", url)).toBe(true);
    for (const url of ["file:///example", "data:text/html,hi", "javascript:void(0)", "chrome://settings", "devtools://devtools", "ave://home", "https://alice:secret@example.test"]) expect(sites.allows("session", url)).toBe(false);
    expect(new BrowserSitePermissions().allows("session", "https://example.test")).toBe(false);
  });
  it("allows agent tool use while preserving deny rules, exfiltration and headless denial", () => {
    const base = { tool: { name: "browser_click", source: "builtin" as const, kind: "write" as const }, mode: "strict" as const, headless: false, agentBrowser: true as const };
    expect(decidePermission(base).outcome).toBe("allow");
    expect(decidePermission({ ...base, rules: { deny: "denied" } }).outcome).toBe("deny");
    expect(decidePermission({ ...base, mode: "allow", exfiltration: { reason: "upload" } }).outcome).toBe("ask");
    expect(decidePermission({ ...base, headless: true }).outcome).toBe("deny");
    expect(decidePermission({ ...base, userOwnedSurface: { kind: "browser", choice: "ask" } }).outcome).toBe("ask");
  });
});
