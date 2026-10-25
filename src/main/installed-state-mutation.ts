import { isAppRelaunchRequested } from "./app-relaunch-state.js";

let pendingMutations = 0;

export function hasInstalledStateMutationInFlight(): boolean {
  return pendingMutations > 0;
}

export async function withInstalledStateMutation<T>(mutate: () => Promise<T>): Promise<T> {
  if (isAppRelaunchRequested()) {
    throw Object.assign(new Error("Installed package changes are paused while Ave is restarting."), { code: "relaunch-in-progress" });
  }
  pendingMutations += 1;
  try {
    return await mutate();
  } finally {
    pendingMutations -= 1;
  }
}
