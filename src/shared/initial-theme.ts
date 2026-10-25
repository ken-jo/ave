/** Prime only first-paint fields; font overrides are explicit top-level fields outside plugin token filtering. */

export const INITIAL_THEME_ARG_PREFIX = "--ave-initial-theme=";

/** Cap argv payload size; oversized primes omit the argument and use asynchronous settings hydration. */
export const INITIAL_THEME_ARG_MAX_BYTES = 16_384;

export interface InitialThemePrime {
  bundleId: string;
  shell: "light" | "dark";
  tokens?: Record<string, string>;
  /** Apply at frame zero; omit when no size override is stored. */
  fontSizeScale?: number;
  /** Apply at frame zero; omit for the default system stack. */
  fontFamily?: string;
}
