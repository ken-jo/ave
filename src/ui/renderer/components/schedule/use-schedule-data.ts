// One project's schedule items, their occurrences and runs in a range, and which items are running right now. The schedule
// panel and the work board's schedule cards read the same data, so they never disagree about an item's state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AveApi } from "../../types.js";
import type { InvalidRoutine, RoutineOccurrence, RoutineRecord, RoutineRun } from "../../../../shared/routines-types.js";

/** How often an open view re-reads: a skipped occurrence has no fired event. */
const SCHEDULE_REFRESH_MS = 30_000;

export interface ScheduleData {
  records: RoutineRecord[];
  invalid: InvalidRoutine[];
  occurrences: RoutineOccurrence[];
  runs: RoutineRun[];
  loaded: boolean;
  /** routineId → firedAt of the run in progress. */
  running: ReadonlyMap<string, string>;
  refresh: () => Promise<void>;
}

export function useScheduleData(
  api: AveApi,
  projectRoot: string | undefined,
  range: { from: Date; to: Date },
  enabled = true,
): ScheduleData {
  const [records, setRecords] = useState<RoutineRecord[]>([]);
  const [invalid, setInvalid] = useState<InvalidRoutine[]>([]);
  const [occurrences, setOccurrences] = useState<RoutineOccurrence[]>([]);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState<Map<string, string>>(() => new Map());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const fromIso = range.from.toISOString();
  const toIso = range.to.toISOString();

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(async () => {
    if (!enabledRef.current) return;
    const filter = projectRoot ? { projectRoot } : undefined;
    const [list, occ] = await Promise.all([
      api.listRoutines(filter),
      api.listRoutineOccurrences({ ...filter, from: fromIso, to: toIso }),
    ]);
    if (!mounted.current) return;
    setRecords(list.routines);
    setInvalid(list.invalid);
    if (occ.ok) {
      setOccurrences(occ.occurrences);
      setRuns(occ.runs);
      // The host's list of runs in progress is the truth; events only keep it current between reads.
      setRunning(new Map(occ.running.map((r) => [r.routineId, r.firedAt])));
    }
    setLoaded(true);
  }, [api, projectRoot, fromIso, toIso]);

  // Fetching follows `enabled`; a hidden view reads again when it is shown.
  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = setInterval(() => void refresh(), SCHEDULE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, enabled]);

  // Running events are always followed, so a run that ends while the view is hidden does not leave a stale running state.
  useEffect(() => {
    const stopped = (routineId: string) => {
      setRunning((prev) => { const next = new Map(prev); next.delete(routineId); return next; });
      void refresh();
    };
    const unsubs = [
      api.onRoutineFired?.(() => void refresh()),
      api.onRoutineRunningStarted?.(({ routineId, firedAt }) => {
        setRunning((prev) => new Map(prev).set(routineId, firedAt));
        void refresh();
      }),
      api.onRoutineRunningFinished?.((routineId) => stopped(routineId)),
      api.onRoutineFailed?.(({ routineId }) => stopped(routineId)),
    ];
    return () => { for (const unsub of unsubs) unsub?.(); };
  }, [api, refresh]);

  return { records, invalid, occurrences, runs, loaded, running, refresh };
}
