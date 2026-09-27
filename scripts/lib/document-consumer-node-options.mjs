const guard = new URL("./document-consumer-guard.mjs", import.meta.url).href;

export function guardedNodeOptions(options = "") {
  const preload = `--import=${guard}`;
  return options.split(/\s+/).includes(preload) ? options : [options, preload].filter(Boolean).join(" ");
}
