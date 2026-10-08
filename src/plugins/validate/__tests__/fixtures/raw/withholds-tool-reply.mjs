/** Answers everything through `tools/list`, and never answers `tools/call`. */
import { speak, WITHHOLD } from "./speak.mjs";

speak({ "tools/call": WITHHOLD });
