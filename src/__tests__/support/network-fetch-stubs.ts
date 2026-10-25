import { vi } from "vitest";

/** Throw on unexpected explicit-transport requests instead of reaching the host network. */
export const unusedNetworkFetch: typeof fetch = () => {
  throw new Error("this suite must not issue a network request");
};

/** Tripwire ambient fetch so explicit-transport tests catch accidental global network access. */
export function forbidAmbientFetch(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("this code must take its transport as an argument, not the ambient fetch");
  });
}
