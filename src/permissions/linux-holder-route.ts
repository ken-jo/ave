// The Linux holder route this app run proved, kept apart from the launch code so the start checks can read it without
// importing the container modules.
import type { MxcLinuxShellPrograms } from "./mxc-linux.js";

/** What the boot holder canary proved: the pinned programs, the capture folder and the system bwrap it ran. */
export interface ProvenLinuxHolderRoute {
  readonly programs: MxcLinuxShellPrograms & { validate(): void };
  readonly helperSha256: string;
  readonly captureFolder: string;
  readonly bwrap: { readonly path: string; readonly identity: string };
}

let provenRoute: ProvenLinuxHolderRoute | undefined;

/** The route this app run proved, or undefined: every Linux holder start is refused without it. */
export function provenLinuxHolderRoute(): ProvenLinuxHolderRoute | undefined {
  return provenRoute;
}

/** Set by the boot holder canary once it proved the route; cleared when a later check revokes it. */
export function setProvenLinuxHolderRoute(route: ProvenLinuxHolderRoute | undefined): void {
  provenRoute = route === undefined ? undefined : Object.freeze({ ...route });
}
