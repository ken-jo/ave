import { createContainedShellLifecycle, type ContainedShellLifecycle } from "../../tools/contained-shell-lifecycle.js";
import { prepareMxcShellLaunch, type MxcShellLaunch, type PrepareMxcShellLaunchInput } from "../../tools/mxc-shell-launch.js";

export interface OwnedMxcShellLaunch extends MxcShellLaunch {
  readonly lifecycle: ContainedShellLifecycle;
  /** Dispose everything the launch allocated; rejects with every disposal failure. */
  release(): Promise<void>;
}

/** Prepare a launch as its shell owner does: a preparation that fails disposes what it allocated before rejecting. */
export async function prepareOwnedMxcShellLaunch(
  input: PrepareMxcShellLaunchInput,
  lifecycle: ContainedShellLifecycle = createContainedShellLifecycle(),
): Promise<OwnedMxcShellLaunch> {
  let launch: MxcShellLaunch;
  try {
    launch = await prepareMxcShellLaunch(input, lifecycle);
  } catch (error) {
    const failures = await lifecycle.dispose();
    if (failures.length > 0) throw new AggregateError([error, ...failures], "contained shell launch failed and so did its release");
    throw error;
  }
  return {
    ...launch,
    lifecycle,
    async release() {
      const failures = await lifecycle.dispose();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "contained shell launch release failed");
    },
  };
}
