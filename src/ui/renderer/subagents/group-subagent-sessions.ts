/** Join spawn/resume segments by childSessionId, falling back to a spawn singleton; preserve first-seen order for
 * transcript concatenation. */
import type { SubAgentSpawn } from "./types.js";

export function groupSubAgentSessions(spawns: SubAgentSpawn[]): SubAgentSpawn[] {
  const buckets = new Map<string, SubAgentSpawn[]>();
  const order: string[] = [];
  for (const spawn of spawns) {
    const key = spawn.childSessionId ?? `solo:${spawn.spawnId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(spawn);
  }
  return order.map((key) => {
    const segments = buckets.get(key)!;
    // A singleton group is returned verbatim — no allocation, and reference identity is preserved so React can bail out of
    // re-rendering unchanged rows.
    if (segments.length === 1) return segments[0];
    const first = segments[0];
    const last = segments[segments.length - 1];
    // Identity (spawnId / title / childSessionId) comes from the FIRST segment
    // (one logical agent = one row + one name); live status / summary / error
    // come from the LATEST segment (`...last`); the transcript is the ordered
    // concat and the tool-call count is the sum across segments.
    return {
      ...last,
      spawnId: first.spawnId,
      title: first.title,
      ...(first.instructions ? { instructions: first.instructions } : {}),
      childSessionId: first.childSessionId,
      entries: segments.flatMap((segment) => segment.entries),
      toolCallCount: segments.reduce((sum, segment) => sum + segment.toolCallCount, 0),
    };
  });
}
