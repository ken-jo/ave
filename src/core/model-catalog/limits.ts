/** Maximum catalog bytes accepted from a download or an on-disk copy. */
export const MODEL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

/** Keep the pending and current copies plus the newest remaining entries. */
export const MODEL_CATALOG_CACHE_MAX_ENTRIES = 5;

/** Pointer read/write cap, also bounding reads of attempt state. */
export const MODEL_CATALOG_POINTER_MAX_BYTES = 64 * 1024;
