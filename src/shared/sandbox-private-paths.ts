import { join } from "node:path";
import { aveHome } from "./ave-home.js";
import { testSandboxPrivateBase } from "./ave-home-test-guard.js";

/** Ephemeral sandbox storage uses the test-owned base when present, keeping test sweeps outside real application data. */
export function sandboxPrivateBase(): string {
  return testSandboxPrivateBase() ?? join(aveHome(), "sandbox");
}

/** Host-owned action data is hidden from ordinary confined principals on every platform. */
export function appOwnedSandboxActionRoot(): string {
  return join(sandboxPrivateBase(), "actions");
}
