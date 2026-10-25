/** Keep UUID validation independent of the Node-only minter so renderer contracts can share it. */

/**
 * An RFC 9562 UUID without anchors, for composing into larger patterns
 * (a backup-directory name, a staged image file name).
 */
export const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Accept RFC 9562 versions 1–8 and variant 10xx in either case; peers and persisted IDs need not be v4. */
export const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
