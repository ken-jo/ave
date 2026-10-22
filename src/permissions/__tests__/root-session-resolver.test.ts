import { describe, expect, it } from "vitest";
import { JudgeContractError } from "../judge/judge-contract.js";
import { createRootSessionResolver } from "../root-session-resolver.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "sub-11111111-22222222-2222-4222-8222-222222222222";
const GRANDCHILD = "sub-22222222-33333333-3333-4333-8333-333333333333";

describe("root session resolution", () => {
  it("maps nested children to their shared host-recorded root", () => {
    const parents: Record<string, string> = { [CHILD]: ROOT, [GRANDCHILD]: CHILD };
    const resolve = createRootSessionResolver((id) => parents[id]);
    expect(resolve(ROOT)).toBe(ROOT);
    expect(resolve(CHILD)).toBe(ROOT);
    expect(resolve(GRANDCHILD)).toBe(ROOT);
  });

  it("consults current provenance when a restored runner becomes available", () => {
    let parent: string | undefined;
    const resolve = createRootSessionResolver((id) => id === CHILD ? parent : undefined);
    expect(resolve(CHILD)).toBe(CHILD);
    parent = ROOT;
    expect(resolve(CHILD)).toBe(ROOT);
  });

  it("rejects cycles and malformed origins", () => {
    const cycle: Record<string, string> = { [CHILD]: GRANDCHILD, [GRANDCHILD]: CHILD };
    expect(() => createRootSessionResolver((id) => cycle[id])(CHILD)).toThrow(JudgeContractError);
    expect(() => createRootSessionResolver(() => "../foreign")(CHILD)).toThrow(JudgeContractError);
    expect(() => createRootSessionResolver(() => "work-board:0")(CHILD)).toThrow(JudgeContractError);
  });

  it("shares a stable work-board root across nested host-owned children", () => {
    const origins: Record<string, string> = { [CHILD]: "work-board:42", [GRANDCHILD]: CHILD };
    const resolve = createRootSessionResolver((id) => origins[id]);
    expect(resolve(CHILD)).toBe("work-board:42");
    expect(resolve(GRANDCHILD)).toBe("work-board:42");
  });
});
