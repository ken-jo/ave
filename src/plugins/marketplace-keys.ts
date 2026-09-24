/**
 * Host-owned marketplace trust anchors.
 *
 * Plugin authors consume @ave/plugin-sdk for type contracts only. Runtime
 * trust roots belong to the Ave host, matching IDE/browser marketplace
 * models where the client owns verification and the SDK never carries keys.
 */
import type { PublicKeyInput } from "./envelope-verifier.js";

// `prod-v1` is the sole trust anchor. Values are base64 of the raw 32-byte
// ed25519 public key.
//
// `poc-v1` was removed here. Its PRIVATE half is public — it shipped in the
// marketplace repo's test fixtures and was exposed again in a merged public PR
// — so while it stayed in this map anyone able to serve an artifact could sign
// one that every Ave build accepted. `verifyEnvelope` accepts ANY key in this
// map, which is what made a single burned anchor sufficient.
//
// It could only be dropped once nothing installable still needed it. The
// catalog was re-signed to `prod-v1` (804 of 860 version rows); the 56 that
// remain on `poc-v1` have no artifact file on disk at all — archived plugins
// (`email`, `calendar`) and pre-rename versions (`pageindex`,
// `vega-early`) — so their download 404s before any signature check runs.
// Verified against the production database and storage before this change.
//
// Adding a second anchor again is a rotation, not a convenience: ship both for
// an overlap window, re-sign the catalog head, then remove the old one.
export const MARKETPLACE_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "prod-v1": "JnmneLJZ3G9TiC+JU0naTDlOdIHC07PB+BToCIarL8E=",
});

/**
 * Trust roots for the plugin ADMISSION CATALOG (`plugins/admission/`) — the
 * signed document that binds `slug@version → sha256 + publisher` and is the
 * authority for whether an artifact may be installed at all.
 *
 * A THIRD, SEPARATE domain, and both separations are load-bearing:
 *
 * - Not `MARKETPLACE_PUBLIC_KEYS`. The catalog and the per-artifact envelope
 *   are verified conjunctively while both exist, and the entire value of that
 *   overlap is that one compromised key is not sufficient. Sharing the anchor
 *   would collapse the conjunction back to a single key.
 * - Not the whitelist/revocation domain. Compromising an admission key means
 *   admitting arbitrary bytes under arbitrary slugs — the same power that
 *   compromising the artifact key has today. The revocation document is what
 *   a defender reaches for when exactly that has happened, so it cannot be
 *   signed by the key under suspicion; sharing would hand the same attacker
 *   the ability to un-revoke.
 *
 * Retirement works by REMOVAL, not by annotation: `verifyEnvelope` accepts any
 * key in the map it is handed, so a key that stays in this map stays an
 * admission authority no matter what a comment says about it. Rotation is
 * O(1) here — add the new id, re-sign the ONE document, drop the old id after
 * one catalog TTL — which is the property the per-artifact envelope lacks,
 * where retiring an anchor cost a re-sign of 804 of 860 version rows.
 *
 * EMPTY TODAY, and that is the fail-closed state rather than a placeholder:
 * `admission-registry.ts` refuses every install while this map is empty, and
 * says so with a distinct reason instead of reporting a signature failure.
 * The issuance keypair is generated and held by the operator of
 * `former_org/marketplace-whitelist` as a workflow-scoped secret — the same
 * custody model as `WHITELIST_SIGNING_KEY` — so the public half arrives here
 * in the commit that publishes the first catalog and flips
 * `ADMISSION_ENFORCEMENT` to `"enforce"`. Provisioning a value here before
 * that document exists would put a trust anchor in the client for a signer
 * nobody holds.
 */
export const ADMISSION_PUBLIC_KEYS: Readonly<Record<string, PublicKeyInput>> = Object.freeze({});
