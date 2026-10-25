import policy from "../../src/shared/app-relaunch-policy.json" with { type: "json" };

export function shouldRelaunchDevChild(code, signal) {
  return code === policy.devExitCode && signal === null;
}
