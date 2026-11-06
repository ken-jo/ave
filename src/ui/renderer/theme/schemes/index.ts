import { SCHEMES } from "./catalog.js";
export { SCHEMES } from "./catalog.js";

/** Catalog IDs are an internal contract: invalid selections never silently change the scheme. */
export function requireScheme(id: string) {
  const scheme = SCHEMES.find((candidate) => candidate.id === id);
  if (!scheme) throw new Error(`Unknown color scheme: ${id}`);
  return scheme;
}
