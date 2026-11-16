import { describe, expect, it, vi } from "vitest";
import { BROWSER_PAGE_PROMPT_LIMIT } from "../../../shared/browser-workspace.js";
import { BrowserPagePrompts } from "../browser-page-prompts.js";

const QUESTION = { origin: "https://site.example", permissions: ["geolocation"] } as const;

describe("BrowserPagePrompts", () => {
  it("lists a guest's questions oldest first and settles the one that is answered", async () => {
    const changed = vi.fn();
    const prompts = new BrowserPagePrompts(changed);
    const first = prompts.ask(7, "permission", QUESTION);
    const second = prompts.ask(7, "permission", { ...QUESTION, permissions: ["camera"] });
    const [a, b] = prompts.list(7);
    expect(prompts.list(7)).toEqual([{ ...QUESTION, kind: "permission", id: a?.id }, { ...QUESTION, kind: "permission", permissions: ["camera"], id: b?.id }]);
    expect(a?.id).not.toBe(b?.id);
    expect(prompts.list(8)).toEqual([]);
    expect(prompts.answer(8, String(a?.id), { kind: "permission", choice: "block" })).toBe(false);
    expect(prompts.answer(7, String(b?.id), { kind: "permission", choice: "block" })).toBe(true);
    await expect(second).resolves.toEqual({ kind: "permission", choice: "block" });
    expect(prompts.list(7)).toHaveLength(1);
    expect(prompts.answer(7, String(b?.id), { kind: "permission", choice: "allow-once" })).toBe(false);
    prompts.dismissGuest(7);
    await expect(first).resolves.toBeNull();
    expect(prompts.list(7)).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("ends a question beyond the per-tab limit without showing it", async () => {
    const prompts = new BrowserPagePrompts(() => {});
    for (let index = 0; index < BROWSER_PAGE_PROMPT_LIMIT; index++) void prompts.ask(7, "permission", QUESTION);
    await expect(prompts.ask(7, "permission", QUESTION)).resolves.toBeNull();
    expect(prompts.list(7)).toHaveLength(BROWSER_PAGE_PROMPT_LIMIT);
    await expect(Promise.race([prompts.ask(8, "permission", QUESTION), Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("refuses an answer of another kind and dismisses only the kinds it is asked to", async () => {
    const prompts = new BrowserPagePrompts(() => {});
    const leave = prompts.ask(7, "leave", { origin: "https://site.example" });
    const permission = prompts.ask(7, "permission", QUESTION);
    const leaveId = String(prompts.list(7)[0]?.id);
    expect(prompts.answer(7, leaveId, { kind: "permission", choice: "allow-once" })).toBe(false);
    prompts.dismissGuest(7, (prompt) => prompt.kind === "permission");
    await expect(permission).resolves.toBeNull();
    expect(prompts.list(7).map((prompt) => prompt.kind)).toEqual(["leave"]);
    expect(prompts.answer(7, leaveId, { kind: "leave", leave: true })).toBe(true);
    await expect(leave).resolves.toEqual({ kind: "leave", leave: true });
  });
});
