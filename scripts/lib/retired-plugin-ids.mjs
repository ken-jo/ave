/**
 * retired-plugin-ids.mjs — the one list of plugin ids that left the project.
 *
 * These plugins (and one tool-name prefix) were retired with the project's
 * independence; none is in the current marketplace catalog. Every reader takes
 * the list from here: `scripts/check-retired-name.mjs` fails CI when a tracked
 * file carries one, and the host-source and tour audits under `src/` reuse the
 * same patterns. Add an id here, not in a reader.
 *
 * Each id is stored as its words, so this file never spells one and the gate
 * does not flag its own list. `join` is the id's canonical separator.
 * `separator` is what the pattern accepts between the words: `-`, `_` or
 * nothing by default (`a-b`, `a_b`, `ab`, `aB`), or exactly nothing where a
 * separated spelling is an ordinary word pair in code.
 *
 * Deliberately not listed, because the words are ordinary and current code
 * uses them in their plain sense: the generic stand-ins older design records
 * use for retired plugins (`mail`, `portal`, `assistant`, `git`), `weather`
 * (the standard MCP tool example, and a live catalog skill), `tasks`, `email`,
 * `calendar`, `x`, `ep`, and `proactive` (the live `imported-from-proactive`
 * envelope tag). A spaced product name in prose is not an id and is not
 * matched either.
 */

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
    // The underscored spelling is the external indexing library's page_index()
    // API, exported by its package initializer, rather than the retired plugin id.
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

/** The id as the retired plugin spelled it. */
export function retiredPluginId(entry) {
  return entry.words.join(entry.join);
}

const capitalize = (word) => word[0].toUpperCase() + word.slice(1);
const anyCase = (word) => [...word].map((letter) => `[${letter}${letter.toUpperCase()}]`).join("");

/**
 * For words `a`, `b`: the id in any case after a non-letter (`a-b`, `@x/a_b`),
 * or inside an identifier after a lower-case letter or digit when each word is
 * Capitalized or in capitals (`migrateABBoard`, `sourceA_B`). It never matches when a
 * lower-case letter follows, so a longer word that merely starts with the id
 * stays clean. Case-sensitive on purpose, like the product-name pattern.
 */
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

/** `[id, pattern]` for every retired id, in list order. */
export const RETIRED_PLUGIN_PATTERNS = Object.freeze(
  RETIRED_PLUGIN_IDS.map((entry) => Object.freeze([retiredPluginId(entry), retiredPluginPattern(entry)])),
);

/** The retired ids `text` carries, in list order. */
export function retiredPluginIdsIn(text) {
  return RETIRED_PLUGIN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
}
