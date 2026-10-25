import { isSafeMcpEnvironmentName } from "./safe-names.js";

const NPX_TARGET = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const UVX_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?==[0-9][0-9A-Za-z.!+_-]*$/u;
const BARE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const IMAGE = /^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)*(?::(?!latest$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/u;

export function portableLauncherLiteralIndexes(name: string, command: string, args: readonly string[]): readonly number[] {
  const refuse = (): never => { throw new Error(`mcpServers.${name} has an unpinned or unsupported launcher`); };
  if (command === "node" || command === "bun") {
    if (!args[0] || !(args[0].startsWith("./") || args[0].startsWith("${PLUGIN_ROOT}/"))) refuse();
    return [];
  }
  if (command.startsWith("./")) return [];
  if (command === "npx") {
    let index = 0;
    while (args[index] === "-y" || args[index] === "--yes") index += 1;
    if (!args[index] || !NPX_TARGET.test(args[index])) refuse();
    return Array.from({ length: index + 1 }, (_, offset) => offset + 1);
  }
  if (command === "uvx") {
    if (args[0] === "--from" || args[0]?.startsWith("--from=")) {
      const inline = args[0] !== "--from";
      const target = inline ? args[0]!.slice("--from=".length) : args[1];
      const executable = args[inline ? 1 : 2];
      if (!target || !UVX_TARGET.test(target) || !executable || !BARE.test(executable)) refuse();
      return inline ? [1, 2] : [1, 2, 3];
    }
    if (!args[0] || !UVX_TARGET.test(args[0])) refuse();
    return [1];
  }
  if (command === "docker") {
    if (args[0] !== "run") refuse();
    let index = 1;
    while (index < args.length) {
      const option = args[index]!;
      if (["-i", "--interactive", "--rm", "--init", "-t", "--tty"].includes(option)) { index += 1; continue; }
      if (option === "-e" || option === "--env" || option.startsWith("--env=")) {
        const inline = option.startsWith("--env=");
        const value = inline ? option.slice("--env=".length) : args[index + 1];
        if (!value || !isSafeMcpEnvironmentName(value.split("=", 1)[0]!)) refuse();
        index += inline ? 1 : 2; continue;
      }
      if (option === "--network" || option.startsWith("--network=")) {
        const inline = option.startsWith("--network=");
        const value = inline ? option.slice("--network=".length) : args[index + 1];
        if (value !== "none" && value !== "bridge") refuse();
        index += inline ? 1 : 2; continue;
      }
      break;
    }
    if (!args[index] || !IMAGE.test(args[index])) refuse();
    return Array.from({ length: index + 1 }, (_, offset) => offset + 1);
  }
  return refuse();
}
