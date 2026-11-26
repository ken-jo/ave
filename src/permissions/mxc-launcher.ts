import { posix, win32 } from "node:path";
import { containerPlatform, containerTarget, containerTargets, type ContainerArch, type ContainerTarget } from "../shared/container-platform.js";
import { isRecord } from "../shared/is-record.js";
import pins from "./mxc-launcher-pins.json" with { type: "json" };

function readLauncherPins(input: unknown): ReadonlyMap<ContainerTarget, string> {
  if (!isRecord(input)) throw new Error("Container launcher pins are missing");
  const required = containerTargets();
  for (const target of Object.keys(input)) {
    if (!required.some((expected) => expected === target)) throw new Error(`Unknown container launcher target: ${target}`);
  }

  const result = new Map<ContainerTarget, string>();
  for (const target of required) {
    if (!Object.hasOwn(input, target)) throw new Error(`Missing container launcher pin: ${target}`);
    const entry = input[target];
    const launcher = isRecord(entry) ? entry.launcher : undefined;
    const [platform, arch] = target.split("-") as [NodeJS.Platform, ContainerArch];
    const member = `bin/${arch}/${containerPlatform(platform)?.launcherFile}`;
    if (!isRecord(launcher) || launcher.member !== member || typeof launcher.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(launcher.sha256)) {
      throw new Error(`Malformed container launcher pin: ${target}`);
    }
    result.set(target, launcher.sha256);
  }
  return result;
}

const launcherPins = readLauncherPins(pins.targets);

export function pinnedLauncherSha256(target: ContainerTarget): string {
  const sha256 = launcherPins.get(target);
  if (sha256 === undefined) throw new Error(`Missing container launcher pin: ${target}`);
  return sha256;
}

export function launcherPathFor(resourcePath: string, platform: NodeJS.Platform, arch: string): string | undefined {
  const container = containerPlatform(platform);
  if (container === undefined || containerTarget(platform, arch) === undefined) return undefined;
  return (platform === "win32" ? win32 : posix).join(resourcePath, "mxc", arch, container.launcherFile);
}

export { readLauncherPins as _readLauncherPinsForTest };
