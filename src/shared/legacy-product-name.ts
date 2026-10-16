/**
 * RETIREDNAME was the previous name of Ave (renamed 2026-10). The names below exist only
 * so the app can reject or ignore artifacts produced under the old name; never use
 * them for new code. `scripts/check-legacy-product-name.mjs` fails the build when
 * the old name appears in any tracked file outside its allowlist.
 */
import { RENAMED_EXTENSION_NAMESPACE } from "../plugins/public-contract.js";

/**
 * The old `extensions` key of a plugin manifest, refused by name. The literal
 * stays in `public-contract.ts` because that file is vendored byte-for-byte into
 * plugin repositories and cannot import anything; it is re-exported here so
 * callers outside the contract name it from one place.
 */
export const LEGACY_EXTENSION_NAMESPACE = RENAMED_EXTENSION_NAMESPACE;

/**
 * Prefix of the old `_meta` vendor keys (`pathFields`, `rawResult`, `category`,
 * `version`). The host no longer reads them: the manifest schema rejects them on a
 * tool and the MCP readers ignore them on a result.
 */
export const LEGACY_META_PREFIX = "xyz.retiredname/";

/** Prefix of the old environment variables; an external judge never receives one. */
export const LEGACY_ENV_PREFIX = "RETIREDNAME_";

/** The old project agents document; it is never adopted as the agents document. */
export const LEGACY_AGENTS_DOCUMENT = "RETIREDNAME.md";

/**
 * The token the retired locale generator wrapped protected text in. A catalog
 * value that still contains it is a translation defect, so the catalog checks
 * reject it.
 */
export const LEGACY_I18N_SENTINEL = "RETIREDNAMEKEEP";
