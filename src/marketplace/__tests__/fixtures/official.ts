/** A closed loopback endpoint prevents tests from contacting the live official repository. */
import { OFFICIAL_MARKETPLACE, type OfficialMarketplace } from "../../sources/official.js";

export const UNREACHABLE_OFFICIAL: OfficialMarketplace = Object.freeze({
  ...OFFICIAL_MARKETPLACE,
  url: "http://127.0.0.1:9/official-unpublished",
  mirrors: Object.freeze([]),
});
