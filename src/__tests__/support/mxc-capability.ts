import type { TestContext } from "vitest";
import { detectHostMxcPrerequisites, probeHostMxcPowerShellStart } from "../../permissions/mxc-windows.js";
import type { MxcSupport } from "../../permissions/mxc-windows.js";

/** Only a recognized host tier can excuse native execution; damaged prerequisites still fail. */
export async function requireMxcCapability(skip: TestContext["skip"]): Promise<Extract<MxcSupport, { state: "available" }>> {
  const prerequisite = await detectHostMxcPrerequisites();
  if (prerequisite.state !== "available") {
    const reason = `Native container prerequisite: ${prerequisite.reason}: ${prerequisite.detail}`;
    if (prerequisite.reason === "tier-unsupported" && prerequisite.detail === "tier appcontainer-dacl") {
      console.info(reason);
      skip(reason);
    }
    throw new Error(reason);
  }
  const started = await probeHostMxcPowerShellStart();
  if (started.state !== "available") throw new Error(`Native container start: ${started.reason}: ${started.detail}`);
  return started;
}
