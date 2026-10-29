import type { TestContext } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWindowsPathKindHelper } from "../../main/windows-path-kind-launcher.js";
import { detectHostMxcPrerequisites, probeHostMxcPowerShellStart } from "../../permissions/mxc-windows.js";
import type { MxcSupport } from "../../permissions/mxc-windows.js";

/** Only a recognized host tier can excuse native execution; damaged prerequisites still fail. */
export async function requireMxcCapability(skip: TestContext["skip"]): Promise<Extract<MxcSupport, { state: "available" }>> {
  await requireMxcPrerequisites(skip);
  const started = await probeHostMxcPowerShellStart();
  if (started.state !== "available") throw new Error(`Native container start: ${started.reason}: ${started.detail}`);
  return started;
}

/** Policy validation does not start a container or require a successful shell start. */
export async function requireMxcPrerequisites(skip: TestContext["skip"]): Promise<Extract<MxcSupport, { state: "available" }>> {
  const prerequisite = await detectHostMxcPrerequisites();
  if (prerequisite.state !== "available") {
    const reason = `Native container prerequisite: ${prerequisite.reason}: ${prerequisite.detail}`;
    if (prerequisite.reason === "tier-unsupported" && prerequisite.detail === "tier appcontainer-dacl") {
      console.info(reason);
      skip(reason);
    }
    throw new Error(reason);
  }
  return prerequisite;
}

/** Native pipe tests need the current helper; the build is an owner action. */
export function requireMxcPolicyPipeHelper(skip: TestContext["skip"]): void {
  const helper = resolveWindowsPathKindHelper();
  const sources = resolve("native/windows-path-kind");
  const built = statSync(helper).mtimeMs;
  if (readdirSync(sources).filter((name) => /\.(cpp|h)$/.test(name))
    .some((name) => statSync(resolve(sources, name)).mtimeMs > built)) {
    skip("Native policy pipe helper is stale; owner must rebuild the Windows path-kind helper");
  }
}
