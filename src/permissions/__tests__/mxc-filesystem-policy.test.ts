import { describe, expect, it } from "vitest";
import { synthesizeMxcAncestorQueries } from "../mxc-filesystem-policy.js";

const EMPTY_GRANTS = { readwrite: [], readonly: [], denied: [] };

describe("container ancestor query policy", () => {
  it("queries uncovered strict ancestors on every involved volume without content grants", () => {
    const grants = { readwrite: [String.raw`D:\stage\holder\home`], readonly: [String.raw`C:\runtime\bin`], denied: [] };
    expect(synthesizeMxcAncestorQueries(grants)).toEqual([
      String.raw`D:\stage\holder`, String.raw`D:\stage`, "D:\\",
      String.raw`C:\runtime`, "C:\\",
    ]);
    expect(grants.readonly).toEqual([String.raw`C:\runtime\bin`]);
    expect(grants.readwrite).toEqual([String.raw`D:\stage\holder\home`]);
  });

  it("deduplicates case-insensitively and omits ancestors covered by existing grants", () => {
    expect(synthesizeMxcAncestorQueries({ ...EMPTY_GRANTS,
      readonly: [String.raw`C:\runtime`, String.raw`c:\runtime\bin`],
    }, [String.raw`C:\runtime\bin\scripts`])).toEqual(["C:\\"]);
  });

  it("retains profile ancestors as explicit name exposure without sibling content grants", () => {
    const grants = { ...EMPTY_GRANTS, readwrite: [String.raw`C:\Users\sample\Temp\holder`] };
    const queries = synthesizeMxcAncestorQueries(grants);
    expect(queries).toContain(String.raw`C:\Users\sample`);
    expect(queries).toContain(String.raw`C:\Users`);
    expect(grants.readwrite).not.toContain(String.raw`C:\Users\sample`);
    // A query path is not a promise that names beneath it remain invisible.
    expect(queries).not.toContain(String.raw`C:\Users\sample\Documents`);
  });

  it("adds no descendant query grants or sibling content roots", () => {
    const grants = { ...EMPTY_GRANTS, readonly: [String.raw`C:\stage\holder`] };
    expect(synthesizeMxcAncestorQueries(grants)).toEqual([String.raw`C:\stage`, "C:\\"]);
    expect(grants.readonly).toHaveLength(1);
  });

  it.each(["C:\\", String.raw`D:\folder\..`, "/tmp/runtime", String.raw`\\server\share\runtime`])(
    "refuses root content and non-drive paths: %s", (root) => {
      expect(() => synthesizeMxcAncestorQueries({ ...EMPTY_GRANTS, readonly: [root] })).toThrow();
    },
  );

  it("refuses unadmitted entries and denied ancestor conflicts", () => {
    expect(() => synthesizeMxcAncestorQueries({ ...EMPTY_GRANTS, readonly: [String.raw`C:\runtime`] },
      [String.raw`D:\outside`])).toThrow("already be admitted");
    expect(() => synthesizeMxcAncestorQueries({ ...EMPTY_GRANTS,
      readonly: [String.raw`C:\protected\runtime`], denied: [String.raw`C:\protected`],
    })).toThrow("conflicts");
  });
});
