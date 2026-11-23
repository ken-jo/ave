// windows-permission
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
  it("reports what allows a site and takes it back so the next request asks again", () => {
    const sites = new BrowserSitePermissions();
    expect(sites.granted("s1", "https://a.example/")).toBeNull();
    sites.allow("s1", "https://a.example/page", "this-site");
    sites.allow("s1", "https://b.example/", "this-site");
    expect(sites.granted("s1", "https://a.example/other")).toBe("this-site");
    expect(sites.revoke("s1", "https://a.example/")).toBe(true);
    expect(sites.allows("s1", "https://a.example/")).toBe(false);
    expect(sites.allows("s1", "https://b.example/")).toBe(true);
    expect(sites.revoke("s1", "https://a.example/")).toBe(false);
    // An any-site grant is what opens every site, so revoking one site under it removes it; exact grants stay.
    sites.allow("s1", "https://c.example/", "any-site");
    expect(sites.granted("s1", "https://z.example/")).toBe("any-site");
    expect(sites.revoke("s1", "https://z.example/")).toBe(true);
    expect(sites.allows("s1", "https://z.example/")).toBe(false);
    expect(sites.allows("s1", "https://b.example/")).toBe(true);
    expect(sites.revoke("other", "https://b.example/")).toBe(false);
    expect(sites.revoke("s1", "https://b.example/")).toBe(true);
    expect(sites.granted("s1", "https://b.example/")).toBeNull();
  });
});
