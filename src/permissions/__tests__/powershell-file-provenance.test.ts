import { describe, expect, it, vi } from "vitest";
import { PowerShellFileProvenance } from "../rules/powershell-file-provenance.js";
import { PowerShellAnalysisContext } from "../rules/powershell-command-policy.js";

describe("scoped file provenance", () => {
  it("does not enumerate prior writes when creating read-only argument probes", () => {
    const parent = new PowerShellFileProvenance(new PowerShellAnalysisContext(), "/work/project");
    for (let index = 0; index < 400; index += 1) parent.record(`note${index}.txt`);
    const original = Map.prototype[Symbol.iterator];
    let visited = 0;
    const iteration = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
      const iterator = original.call(this);
      const next = iterator.next.bind(iterator);
      iterator.next = () => {
        const result = next();
        if (!result.done) visited += 1;
        return result;
      };
      return iterator;
    });
    let found = 0;
    try {
      for (let index = 0; index < 400; index += 1) {
        const probe = parent.fork();
        if (probe.lookup("note0.txt") !== undefined && !probe.hasExecutableWrites()) found += 1;
      }
    } finally { iteration.mockRestore(); }
    expect(found).toBe(400);
    expect(visited).toBe(0);
  });

  it("keeps snapshots frozen after later parent writes and overwrites", () => {
    const parent = new PowerShellFileProvenance(new PowerShellAnalysisContext(), "/work/project");
    parent.record("known.txt");
    const child = parent.fork();
    parent.record("known.txt", { source: "curl.exe" });
    parent.record("later.exe", { source: "wget.exe" });
    expect(child.lookup("known.txt")).toEqual({ catalogue: undefined });
    expect(parent.lookup("known.txt")?.catalogue).toBe("curl.exe");
    expect(child.lookup("later.exe")).toBeUndefined();
    expect(child.hasExecutableWrites()).toBe(false);
    expect(parent.hasExecutableWrites()).toBe(true);
  });

  it("isolates local child effects across nested probes", () => {
    const parent = new PowerShellFileProvenance(new PowerShellAnalysisContext(), "/work/project");
    const child = parent.fork();
    child.record("child.exe", { source: "curl.exe" });
    const grandchild = child.fork();
    child.record("late.exe");
    grandchild.record("leaf.exe");
    expect(parent.lookup("child.exe")).toBeUndefined();
    expect(grandchild.lookup("child.exe")?.catalogue).toBe("curl.exe");
    expect(grandchild.lookup("late.exe")).toBeUndefined();
    expect(child.lookup("leaf.exe")).toBeUndefined();
    expect(grandchild.lookup("leaf.exe")).toBeDefined();
  });

  it("preserves short-name and tree provenance within a snapshot", () => {
    const parent = new PowerShellFileProvenance(new PowerShellAnalysisContext(), "/work/project");
    parent.record("longfilename.exe", { source: "curl.exe" });
    parent.record("tree", { tree: true });
    const child = parent.fork();
    parent.record("unseenname.exe");
    expect(child.lookup("longfi~1.exe")?.catalogue).toBe("curl.exe");
    expect(child.lookup("tree/nested.exe")).toBeDefined();
    expect(child.lookup("unseen~1.exe")).toBeUndefined();
  });
});
