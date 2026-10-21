/**
 * Test fixture: an official marketplace no test can reach.
 *
 * A registry opened without `official` uses the live public repository
 * (`OFFICIAL_MARKETPLACE`), so a test's outcome would follow whatever that
 * repository publishes and would need the network. This stand-in keeps the id
 * and auth of the real one but points at a closed loopback port (9, discard),
 * so every fetch of it fails at once, offline or not.
 */
import { OFFICIAL_MARKETPLACE, type OfficialMarketplace } from "../../sources/official.js";

export const UNREACHABLE_OFFICIAL: OfficialMarketplace = Object.freeze({
  ...OFFICIAL_MARKETPLACE,
  url: "http://127.0.0.1:9/official-unpublished",
  mirrors: Object.freeze([]),
});
