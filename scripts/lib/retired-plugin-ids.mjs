// Share retired ids across audits; store words separately to avoid matching this inventory.

/**
 * @typedef {{ words: readonly string[], join: string, separator: string, reason: string }} RetiredPluginId
 */

/** @type {readonly RetiredPluginId[]} */
export const RETIRED_PLUGIN_IDS = Object.freeze([
  Object.freeze({
    words: Object.freeze(["agent", "hub"]),
    join: "-",
    separator: "[-_]?",
    reason: "work-board and message-board plugin; its server was shut down and the board moved into the host",
  }),
  Object.freeze({
    words: Object.freeze(["page", "index"]),
    join: "",
    // This spelling names an external library API rather than a retired plugin.
    separator: "",
    reason: "former id of the local-indexer plugin",
  }),
  Object.freeze({
    words: Object.freeze(["work", "assistant"]),
    join: "-",
    separator: "[-_]?",
    reason: "retired assistant plugin",
  }),
  Object.freeze({
    words: Object.freeze(["ms", "graph"]),
    join: "-",
    separator: "[-_]?",
    reason: "retired mail and calendar plugin",
  }),
  Object.freeze({
    words: Object.freeze(["mcp", "ep"]),
    join: "_",
    separator: "[-_]?",
    reason: "tool-name prefix of the retired portal plugin",
  }),
]);

export function retiredPluginId(entry) {
  return entry.words.join(entry.join);
}

const capitalize = (word) => word[0].toUpperCase() + word.slice(1);
const anyCase = (word) => [...word].map((letter) => `[${letter}${letter.toUpperCase()}]`).join("");

// Match delimited ids and capitalized identifier parts without matching longer unrelated words.
export function retiredPluginPattern(entry) {
  const { words, separator } = entry;
  const lower = words.map(anyCase).join(separator);
  const capitalized = words.map(capitalize).join(separator);
  const capitals = words.map((word) => word.toUpperCase()).join(separator);
  return new RegExp(
    `(?:(?<![A-Za-z])${lower}|(?<=[a-z0-9])${capitalized}|(?<=[a-z0-9])${capitals})(?![a-z])`,
    "u",
  );
}

export const RETIRED_PLUGIN_PATTERNS = Object.freeze(
  RETIRED_PLUGIN_IDS.map((entry) => Object.freeze([retiredPluginId(entry), retiredPluginPattern(entry)])),
);

export function retiredPluginIdsIn(text) {
  return RETIRED_PLUGIN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}
