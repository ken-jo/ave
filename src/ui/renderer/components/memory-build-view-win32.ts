import type { MemoryBuildView } from '../../../shared/memory-map.js';

interface ViewState {
  frame: MemoryBuildView;
  retiredInstances: ReadonlySet<string>;
  hadReady: boolean;
}

export function reduceView(previous: ViewState | null, frame: MemoryBuildView): ViewState {
  if (previous && (previous.retiredInstances.has(frame.instance)
    || (previous.frame.instance === frame.instance && previous.frame.revision >= frame.revision))) return previous;

  const retiredInstances = new Set(previous?.retiredInstances);
  if (previous && previous.frame.instance !== frame.instance) retiredInstances.add(previous.frame.instance);
  return { frame, retiredInstances, hadReady: previous?.hadReady === true || frame.snapshot?.status === 'ready' };
}

export function selectBuildView(frame: MemoryBuildView | undefined) {
  const builds = frame?.builds ?? [];
  const active = builds.find(row => row.phase === 'admitting' || row.phase === 'running');
  const snapshot = frame?.snapshot;
  return {
    active,
    snapshot: active ? (snapshot?.status === 'building' && snapshot.snapshotId === active.id ? snapshot : null)
      : snapshot?.status === 'building' ? null : snapshot ?? null,
    refusals: builds.filter(row => row.phase === 'exit-unconfirmed'),
    polling: active !== undefined || builds.some(row => row.phase === 'stopping'),
    outcome: builds[0]?.outcome,
  };
}
