/** Stable partitioning keeps recency order within pinned and unpinned groups. */
export function sortWithPinnedFirst<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
): T[] {
  return [...items].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
}
