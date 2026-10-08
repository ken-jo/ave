import { fileURLToPath, pathToFileURL } from "node:url";

const guardPath = fileURLToPath(new URL("./document-consumer-guard.mjs", import.meta.url));

export function documentGuardImportArgument(path = guardPath) {
  return `--import=${pathToFileURL(path).href}`;
}

export function guardedNodeOptions(options = "", path = guardPath) {
  const preload = documentGuardImportArgument(path);
  return options.split(/\s+/).includes(preload) ? options : [options, preload].filter(Boolean).join(" ");
}
