import { statSync } from "node:fs";

// Prefer readiness signals because skip-write builds may leave output timestamps unchanged.
// Poll mtime only for watchers that always rewrite their first output.
export async function waitForFirstBuild(watcher, since, timeoutMs, sleepMs = 100) {
  if (watcher.readyPromise) {
    const timeout = new Promise((r) => setTimeout(() => r("__timeout__"), timeoutMs));
    const result = await Promise.race([watcher.readyPromise.then(() => "__ready__"), timeout]);
    return result === "__ready__";
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = statSync(watcher.output);
      if (st.mtimeMs >= since) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  return false;
}

export async function waitForAllFirstBuilds(
  watchers,
  since,
  log,
  options = {},
) {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const sleepMs = options.sleepMs ?? 100;
  const remaining = new Set(watchers.map((w) => w.tag));
  const list = () =>
    watchers.filter((w) => remaining.has(w.tag)).map((w) => w.tag).join(" ");

  log(
    "progress",
    `waiting for first build (${watchers.length} watcher${watchers.length === 1 ? "" : "s"}): ${list()}`,
  );

  const results = await Promise.all(
    watchers.map(async (w) => {
      const wStart = Date.now();
      const ok = await waitForFirstBuild(w, since, timeoutMs, sleepMs);
      const elapsedSec = ((Date.now() - wStart) / 1000).toFixed(1);
      if (ok) {
        remaining.delete(w.tag);
        const left = remaining.size;
        if (left === 0) {
          log("progress", `OK ${w.tag} (${elapsedSec}s) — all watchers ready`);
        } else {
          log("progress", `OK ${w.tag} (${elapsedSec}s) — ${left} remaining: ${list()}`);
        }
      } else {
        log(
          "progress",
          `FAIL ${w.tag} timeout after ${elapsedSec}s — ${w.label} (${w.output})`,
        );
      }
      return { tag: w.tag, ok, elapsedSec };
    }),
  );
  return results.every((r) => r.ok);
}
