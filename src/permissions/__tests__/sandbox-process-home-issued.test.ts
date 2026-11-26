import { describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({ recorded: [] as string[], forgotten: [] as string[] }));

vi.mock("../sandbox-home-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox-home-registry.js")>();
  return {
    ...actual,
    recordIssuedContainerHome: (home: string, root: string) => {
      actual.recordIssuedContainerHome(home, root);
      registry.recorded.push(home);
    },
    forgetIssuedContainerHome: (home: string) => {
      actual.forgetIssuedContainerHome(home);
      registry.forgotten.push(home);
    },
  };
});

vi.mock("../../tools/agent-observation-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tools/agent-observation-context.js")>()),
  registerAgentObservationHome: () => {
    throw new Error("observation registration failed");
  },
}));

const { createSandboxProcessHome } = await import("../sandbox-process-home.js");

describe("a Windows sandbox HOME whose set-up fails after it was issued", () => {
  it.runIf(process.platform === "win32")("is no longer an issued container HOME", () => {
    expect(() => createSandboxProcessHome("win32")).toThrow("observation registration failed");
    expect(registry.recorded).toHaveLength(1);
    expect(registry.forgotten).toEqual(registry.recorded);
  });
});
