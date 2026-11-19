import { vi } from "vitest";

export async function loadHomeRedactors(home: string, platform: "linux" | "darwin" | "win32" = "linux") {
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    const overrides = { homedir: () => home, platform: () => platform };
    return { ...actual, ...overrides, default: { ...actual, ...overrides } };
  });
  return {
    ...await import("../../audit/dlp-filter.js"),
    ...await import("../../permissions/judge/judge-redaction.js"),
  };
}

export function resetHomeRedactors(): void {
  vi.doUnmock("node:os");
  vi.resetModules();
}
