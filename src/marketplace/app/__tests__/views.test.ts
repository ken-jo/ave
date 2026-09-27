import { describe, expect, it } from "vitest";
import { authorityDelta, authorityView, widensAuthority } from "../views.js";

describe("filesystem authority review", () => {
  const base = authorityView({ capabilities: [] });
  const declared = authorityView({
    capabilities: [],
    sandbox: {
      read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read a certificate bundle" }],
      write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }],
    },
  });

  it("shows every reviewed grant and treats an added entry as widening", () => {
    expect(declared.filesystem).toEqual([
      { access: "read", target: "certs", why: "Read a certificate bundle" },
      { access: "write", target: "config.workspace", why: "Store project data" },
    ]);
    const delta = authorityDelta(base, declared);
    expect(delta?.added.filesystem).toEqual(declared.filesystem);
    expect(widensAuthority(delta)).toBe(true);
    expect(authorityDelta(declared, base)?.removed.filesystem).toEqual(declared.filesystem);
  });

  it("does not treat a reason-only edit as new filesystem authority", () => {
    const revised = { ...declared, filesystem: declared.filesystem.map((grant) => ({ ...grant, why: "Updated explanation" })) };
    expect(authorityDelta(declared, revised)).toBeNull();
  });
});
