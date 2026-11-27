import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs.js';
import { useTranslation } from '../../../i18n/react.js';
import { MEMORY_MAP_ERROR_KEYS } from '../../../shared/memory-map-errors.js';
import type { MemoryEmbeddingSettings, MemoryFacets, MemoryMapError, MemoryMapFilters, MemoryMapProgress, MemoryMapScope, MemoryMapSource } from '../../../shared/memory-map.js';
import type { MemoryModelStatus } from '../../../shared/memory-model.js';
import type { MemoryDetailResult } from '../../../shared/memory-detail.js';
import { stripTopHeading } from '../hooks/use-memory-search.js';
import { MemorySearchPanel, type MemorySearchPanelProps } from './MemorySearchPanel.js';
import { MemoryDetailContent } from './MemoryDetailContent.js';
import { MemoryMapCanvas } from './MemoryMapCanvas.js';
import { MemoryQuestionBox } from './MemoryQuestionBox.js';
import { reduceView, selectBuildView } from './memory-build-view-win32.js';
import { MEMORY_SOURCE_TOKENS } from './memory-graph-renderer.js';

const CARD_PAGE_SIZE = 24;
const BUILD_STATUS_REFRESH_MS = 1500;
const EMPTY_FACETS: MemoryFacets = { sources: [], projects: [], playbooks: [] };
type ViewProps = MemorySearchPanelProps & { onOpenEmbeddingSettings: () => void };
type MapState = 'loading' | 'unconfigured' | 'unavailable' | 'building' | 'failed' | 'empty' | 'ready' | 'stale';

function stateForError(error: MemoryMapError): MapState {
  if (error === 'graph-stale') return 'stale';
  if (error === 'model-unconfigured') return 'unconfigured';
  if (error === 'local-inference-disabled' || error === 'local-runtime-unavailable') return 'unavailable';
  return 'failed';
}

export function MemoryViewWin32(props: ViewProps) {
  const project = props.project;
  const scope = useMemo(() => project?.projectRoot ? { projectRoot: project.projectRoot, projectName: project.projectName,
    includeUnscoped: project.isDefault === true } : undefined, [project?.projectRoot, project?.projectName, project?.isDefault]);
  return <MemoryBuildScope key={JSON.stringify(scope)} {...props} scope={scope} />;
}

function MemoryBuildScope(props: ViewProps & { scope?: MemoryMapScope }) {
  const { api, scope, onOpenSession, onOpenEmbeddingSettings } = props;
  const { t } = useTranslation();
  const [tab, setTab] = useState(props.initialQuery ? 'manage' : 'map');
  const [view, applyView] = useReducer(reduceView, null);
  const [viewError, setViewError] = useState<MemoryMapError | null>(null);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [availability, setAvailability] = useState<{ settings?: MemoryEmbeddingSettings; model?: MemoryModelStatus; error?: MemoryMapError }>();
  const [filters, setFilters] = useState<MemoryMapFilters>({});
  const [progress, setProgress] = useState<MemoryMapProgress | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MemoryDetailResult>();
  const [body, setBody] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [buildPending, setBuildPending] = useState<string>();
  const [cancelPending, setCancelPending] = useState<ReadonlySet<string>>(() => new Set());
  const requestSync = useRef<() => void>(() => {});
  const displayedId = useRef<string | undefined>(undefined);
  const selectionReturn = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const denied = viewError === 'project-not-allowed' || viewError === 'unauthorized-frame';
  const { active, snapshot, refusals, outcome, polling } = selectBuildView(denied ? undefined : view?.frame);
  const activeId = active?.id;
  const shownProgress = progress?.jobId === activeId ? progress : null;

  useEffect(() => { if (props.initialQuery) setTab('manage'); }, [props.initialQuery]);
  useEffect(() => { displayedId.current = activeId; setProgress(null); }, [activeId]);
  useEffect(() => {
    let mounted = true;
    let reading = false;
    let queued = false;
    let readingMetadata = false;
    const readViews = async () => {
      reading = true;
      while (mounted && queued) {
        queued = false;
        try {
          const result = await api.memoryMap.buildView?.(scope);
          if (!mounted) break;
          if (result?.ok) { applyView(result.value); setViewError(null); }
          else setViewError(result?.error ?? 'graph-unavailable');
        } catch { if (mounted) setViewError('graph-unavailable'); }
      }
      reading = false;
    };
    const readMetadata = async () => {
      readingMetadata = true;
      try {
        const [counts, model, settings] = await Promise.all([api.memoryMap.facets(scope), api.memoryMap.modelStatus(), api.memoryMap.settingsGet()]);
        if (!mounted) return;
        if (counts.ok) setFacets(counts.value);
        setAvailability({
          settings: settings.ok ? settings.value : undefined,
          model: model.ok ? model.value : undefined,
          error: !settings.ok ? settings.error : settings.value.source === 'local' && !model.ok ? model.error : !counts.ok ? counts.error : undefined,
        });
      } catch { if (mounted) setAvailability({ error: 'graph-unavailable' }); }
      finally { readingMetadata = false; }
    };
    const sync = () => {
      if (!mounted) return;
      queued = true;
      if (!reading) void readViews();
      if (!readingMetadata) void readMetadata();
    };
    requestSync.current = sync;
    const stopProgress = api.memoryMap.onProgress(value => {
      if (!mounted) return;
      if (value.jobId === displayedId.current) setProgress(value);
      sync();
    });
    const stopSaves = api.onMemorySaveResult(sync);
    sync();
    return () => { mounted = false; stopProgress(); stopSaves(); };
  }, [api, scope]);
  const needsPoll = polling || buildPending !== undefined;
  useEffect(() => {
    if (!needsPoll) return;
    const timer = setInterval(() => requestSync.current(), BUILD_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [needsPoll]);

  const failedBuild = outcome?.kind === 'failed' ? outcome.code : undefined;
  const error = denied ? viewError : availability?.error ?? (view === null ? viewError : null)
    ?? (snapshot?.status === 'ready' ? null : failedBuild ?? null);
  let state: MapState;
  if (active) state = 'building';
  else if (error) state = stateForError(error);
  else if (!view || !availability) state = 'loading';
  else if (snapshot?.status === 'ready') state = snapshot.points.length ? 'ready' : 'empty';
  else if (snapshot && snapshot.status !== 'building') state = snapshot.status;
  else if (availability.settings?.source === 'provider' ? availability.settings.providerAvailable : availability.model?.status === 'ready') {
    state = view.hadReady ? 'stale' : 'empty';
  } else state = 'unconfigured';

  const visiblePoints = useMemo(() => (snapshot?.points ?? []).filter(point =>
    (!filters.sources?.length || filters.sources.includes(point.sourceKind)) &&
    (!filters.projectIds?.length || !!point.projectId && filters.projectIds.includes(point.projectId))), [snapshot, filters]);
  const visible = useMemo(() => new Set(visiblePoints.map(point => point.memoryId)), [visiblePoints]);
  const linkCount = snapshot?.edges.filter(edge => visible.has(edge.a) && visible.has(edge.b)).length ?? 0;
  const selectedPoint = snapshot?.points.find(point => point.memoryId === selected);
  const selectedRevision = selectedPoint?.contentRevision;
  const snapshotId = snapshot?.snapshotId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new graph identity or filters reset local selection.
  useEffect(() => { setPage(0); setSelected(null); }, [filters, snapshotId]);
  useEffect(() => {
    if (!selected || !selectedRevision) return;
    let mounted = true;
    setDetail(undefined); setBody(null);
    closeButton.current?.focus();
    void api.memoryGetDetail(selected, scope, selectedRevision).then(result => {
      if (!mounted) return;
      if (result.ok && result.source?.contentRevision !== selectedRevision) { setDetail({ ok: false, error: 'not-found' }); return; }
      setDetail(result);
      setBody(result.ok && result.source ? stripTopHeading(result.source.content) : null);
    }).catch(() => { if (mounted) setDetail({ ok: false, error: 'read-failed' }); });
    return () => { mounted = false; };
  }, [api, selected, scope, selectedRevision]);
  const handleSelect = useCallback((id: string) => {
    if (!visible.has(id)) return;
    selectionReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(id);
  }, [visible]);
  const handleClose = () => { setSelected(null); selectionReturn.current?.focus(); };
  const handleBuild = async () => {
    if (buildPending) return;
    const id = crypto.randomUUID();
    setBuildPending(id);
    try {
      const result = api.memoryMap.build(scope, id);
      requestSync.current();
      await result;
    } catch { /* The host view supplies the outcome. */ }
    finally { setBuildPending(undefined); requestSync.current(); }
  };
  const handleCancel = async (id: string) => {
    if (cancelPending.has(id)) return;
    setCancelPending(previous => new Set(previous).add(id));
    try {
      const result = api.memoryMap.cancel(id);
      requestSync.current();
      await result;
    } catch { /* The host view supplies the outcome. */ }
    finally {
      setCancelPending(previous => { const next = new Set(previous); next.delete(id); return next; });
      requestSync.current();
    }
  };
  const toggleSource = (source: MemoryMapSource) => setFilters(previous => ({ ...previous, sources: previous.sources?.includes(source) ? previous.sources.filter(value => value !== source) : [...previous.sources ?? [], source] }));
  const toggleProject = (id: string) => setFilters(previous => ({ ...previous, projectIds: previous.projectIds?.includes(id) ? previous.projectIds.filter(value => value !== id) : [...previous.projectIds ?? [], id] }));
  return <Tabs data-testid="memory-view" value={tab} onValueChange={setTab} className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <TabsList aria-label={t('memoryMap.views')}>
        <TabsTrigger value="map">{t('memoryMap.map')}</TabsTrigger>
        <TabsTrigger value="cards">{t('memoryMap.cards')}</TabsTrigger>
        <TabsTrigger value="manage">{t('memoryMap.manage')}</TabsTrigger>
      </TabsList>
      {tab !== 'manage' && <Button size="sm" variant="outline" disabled={!!buildPending || ['building', 'loading', 'unconfigured', 'unavailable'].includes(state)} onClick={() => void handleBuild()}>{t('memoryMap.rebuild')}</Button>}
    </div>
    {tab !== 'manage' && refusals.map(({ id }) => <div key={id} className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-xs text-destructive">{t('memoryMap.error.build-exit-unconfirmed')}{refusals.length > 1 && <> <code>{id}</code></>}</p>
      <Button size="sm" variant="outline" disabled={cancelPending.has(id)} onClick={() => void handleCancel(id)}>{t('memoryMap.retryCancel')}</Button>
    </div>)}
    {tab !== 'manage' && <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border @[640px]:flex-row">
      <aside aria-label={t('memoryMap.filters')} className="w-full shrink-0 space-y-4 overflow-auto border-b p-3 @[640px]:w-48 @[640px]:border-b-0 @[640px]:border-r">
        <p role="status" className="text-xs font-medium">{t('memoryMap.totals', { memories: visiblePoints.length, links: linkCount })}</p>
        <fieldset className="space-y-1"><legend className="mb-2 text-xs font-semibold">{t('memoryMap.sources')}</legend>
          {facets.sources.map(source => <button type="button" key={source.sourceKind} aria-label={`${t(`memoryMap.source.${source.sourceKind}`)} ${source.count}`} aria-pressed={filters.sources?.includes(source.sourceKind) ?? false} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted aria-pressed:bg-accent" onClick={() => toggleSource(source.sourceKind)}>
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${MEMORY_SOURCE_TOKENS[source.sourceKind]})` }} />
            <span className="flex-1">{t(`memoryMap.source.${source.sourceKind}`)}</span><span>{source.count}</span>
          </button>)}
        </fieldset>
        {facets.projects.length > 0 && <fieldset><legend className="mb-2 text-xs font-semibold">{t('memoryMap.projects')}</legend><div className="flex flex-wrap gap-1">{facets.projects.map(project => <button type="button" key={project.projectId} aria-pressed={filters.projectIds?.includes(project.projectId) ?? false} className="max-w-full truncate rounded-full border px-2 py-1 text-xs aria-pressed:bg-accent" onClick={() => toggleProject(project.projectId)}>{project.name} {project.count}</button>)}</div></fieldset>}
        <Button size="sm" variant="ghost" onClick={() => setFilters({})}>{t('memoryMap.clearFilters')}</Button>
        <p className="text-xs text-muted-foreground">{t('memoryMap.filterHint')}</p>
      </aside>
      <div className="relative min-h-80 min-w-0 flex-1 bg-background">
        {state === 'ready' && snapshot ? <>
          <TabsContent value="map" className="absolute inset-0 m-0">
            <MemoryMapCanvas snapshot={snapshot} visible={visible} selected={selected} matched={matched} onSelect={handleSelect} />
            <div className="pointer-events-none absolute inset-x-3 bottom-3 max-h-[60%]"><MemoryQuestionBox api={api.memoryMap} snapshot={snapshot} scope={scope} filters={filters} onMatches={setMatched} onSelect={handleSelect} /></div>
          </TabsContent>
          <TabsContent value="cards" className="absolute inset-0 m-0 flex flex-col overflow-auto p-3">
            <ul className="grid gap-2 @[700px]:grid-cols-2">{visiblePoints.slice(page * CARD_PAGE_SIZE, (page + 1) * CARD_PAGE_SIZE).map(point => <li key={point.memoryId}><button type="button" aria-label={`${point.title} ${t(`memoryMap.source.${point.sourceKind}`)}${point.projectName ? ` · ${point.projectName}` : ''}`} aria-pressed={selected === point.memoryId} onClick={() => handleSelect(point.memoryId)} className="h-full w-full space-y-2 rounded-lg border p-3 text-left hover:bg-muted aria-pressed:bg-accent"><span className="block break-words text-sm font-medium">{point.title}</span><span className="block text-xs text-muted-foreground">{t(`memoryMap.source.${point.sourceKind}`)}{point.projectName ? ` · ${point.projectName}` : ''}</span></button></li>)}</ul>
            <nav aria-label={t('memoryMap.pages')} className="mt-3 flex items-center justify-between gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('memoryMap.previous')}</Button><span className="text-xs">{t('memoryMap.page', { page: page + 1, total: Math.max(1, Math.ceil(visiblePoints.length / CARD_PAGE_SIZE)) })}</span><Button size="sm" variant="outline" disabled={(page + 1) * CARD_PAGE_SIZE >= visiblePoints.length} onClick={() => setPage(value => value + 1)}>{t('memoryMap.next')}</Button></nav>
          </TabsContent>
          {!visiblePoints.length && <p role="status" className="pointer-events-none absolute inset-x-4 top-16 rounded bg-background p-3 text-sm">{t('memoryMap.noFiltered')}</p>}
        </> : <div className="space-y-3 p-6" role="status">
          {error !== 'local-inference-disabled' && <p className="text-sm">{t(state === 'unavailable' && error ? MEMORY_MAP_ERROR_KEYS[error]
            : state === 'empty' && snapshot?.status === 'ready' ? 'memoryMap.noMemories' : `memoryMap.state.${state}`)}</p>}
          {error && state === 'failed' && <p role="alert" className="text-xs text-destructive">{t(MEMORY_MAP_ERROR_KEYS[error])}</p>}
          {(state === 'unconfigured' || state === 'unavailable') && <Button size="sm" onClick={onOpenEmbeddingSettings}>{t('memoryMap.openSettings')}</Button>}
          {activeId && <><p className="text-xs">{shownProgress ? t(`memoryMap.phase.${shownProgress.phase}`, { completed: shownProgress.completed, total: shownProgress.total }) : snapshot?.status === 'building' ? t('memoryMap.phase.embedding', { completed: snapshot.coverage.embedded, total: snapshot.coverage.eligible }) : t('memoryMap.preparing')}</p>{shownProgress && <progress aria-label={t('memoryMap.state.building')} value={shownProgress.completed} max={Math.max(1, shownProgress.total)} />}<Button size="sm" variant="outline" disabled={cancelPending.has(activeId)} onClick={() => void handleCancel(activeId)}>{t('memoryMap.cancelBuild')}</Button></>}
          {['failed', 'stale', 'empty'].includes(state) && <Button size="sm" disabled={!!buildPending} onClick={() => void handleBuild()}>{t(state === 'failed' ? 'memoryMap.retry' : 'memoryMap.rebuild')}</Button>}
        </div>}
        {selectedPoint && state === 'ready' && <aside aria-label={t('memoryMap.detail')} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); handleClose(); } }} className="absolute inset-y-0 right-0 z-10 w-full max-w-sm space-y-4 overflow-auto border-l bg-background p-4 shadow-lg">
          <Button ref={closeButton} size="sm" variant="outline" onClick={handleClose}>{t('memoryMap.closeDetail')}</Button>
          <h2 className="break-words text-base font-semibold">{selectedPoint.title}</h2>
          {body !== null && <p className="whitespace-pre-wrap break-words text-sm">{body}</p>}
          <MemoryDetailContent key={selectedPoint.memoryId} detail={detail} onOpenSession={onOpenSession} />
        </aside>}
      </div>
    </div>}
    <TabsContent value="manage" className="m-0 flex min-h-0 flex-1 flex-col"><MemorySearchPanel {...props} /></TabsContent>
  </Tabs>;
}
