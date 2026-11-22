import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs.js';
import { useTranslation } from '../../../i18n/react.js';
import type { GraphSnapshot, MemoryFacets, MemoryMapError, MemoryMapFilters, MemoryMapProgress, MemoryMapSource } from '../../../shared/memory-map.js';
import type { MemoryDetailResult } from '../../../shared/memory-detail.js';
import { memoryProjectOptions, stripTopHeading } from '../hooks/use-memory-search.js';
import { MemorySearchPanel, type MemorySearchPanelProps } from './MemorySearchPanel.js';
import { MemoryDetailContent } from './MemoryDetailContent.js';
import { MemoryMapCanvas } from './MemoryMapCanvas.js';
import { MemoryQuestionBox } from './MemoryQuestionBox.js';
import { MEMORY_SOURCE_TOKENS } from './memory-graph-renderer.js';

const CARD_PAGE_SIZE = 24;
const BUILD_STATUS_REFRESH_MS = 1500;
type MapState = 'loading' | 'unconfigured' | 'unavailable' | 'building' | 'failed' | 'empty' | 'ready' | 'stale';
export function MemoryView(props: MemorySearchPanelProps & { onOpenEmbeddingSettings: () => void }) {
  const { api, project, onOpenSession, onOpenEmbeddingSettings } = props;
  const { t } = useTranslation();
  const scope = useMemo(() => memoryProjectOptions(project), [project?.projectRoot, project?.projectName, project?.isDefault]);
  const [tab, setTab] = useState(props.initialQuery ? 'manage' : 'map');
  const [state, setState] = useState<MapState>('loading');
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [facets, setFacets] = useState<MemoryFacets>({ sources: [], projects: [], playbooks: [] });
  const [filters, setFilters] = useState<MemoryMapFilters>({});
  const [error, setError] = useState<MemoryMapError | null>(null);
  const [progress, setProgress] = useState<MemoryMapProgress | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<MemoryDetailResult>();
  const [body, setBody] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [resumedBuild, setResumedBuild] = useState(false);
  const generation = useRef(0);
  const previousScope = useRef(scope);
  const hadSnapshot = useRef(false);
  const selectionReturn = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (props.initialQuery) setTab('manage'); }, [props.initialQuery]);
  useEffect(() => {
    if (previousScope.current !== scope) { hadSnapshot.current = false; previousScope.current = scope; }
    const current = ++generation.current;
    let active = true;
    setFacets({ sources: [], projects: [], playbooks: [] });
    setState('loading'); setSnapshot(null); setFilters({}); setSelected(null); setProgress(null); setError(null);
    setResumedBuild(false);
    const stop = api.memoryMap.onProgress(value => {
      if (active) { setProgress(value); setState(previous => previous === 'unavailable' ? previous : 'building'); }
    });
    void Promise.all([api.memoryMap.get(scope), api.memoryMap.facets(scope), api.memoryMap.modelStatus(), api.memoryMap.settingsGet()]).then(([graph, counts, model, settings]) => {
      if (!active || generation.current !== current) return;
      if (settings.ok && settings.value.source === 'local' && !model.ok && model.error === 'local-runtime-unavailable') {
        setState('unavailable');
        return;
      }
      if (!graph.ok) { setState(graph.error === 'graph-stale' ? 'stale' : 'failed'); setError(graph.error); return; }
      if (!counts.ok) { setState('failed'); setError(counts.error); return; }
      if (!settings.ok) { setState('failed'); setError(settings.error); return; }
      if (!model.ok && settings.value.source === 'local') { setState('failed'); setError(model.error); return; }
      setFacets(counts.value);
      setSnapshot(graph.value);
      setResumedBuild(graph.value?.status === 'building');
      if (graph.value?.status === 'ready') hadSnapshot.current = true;
      setState(graph.value ? graph.value.status === 'ready' && graph.value.points.length === 0 ? 'empty' : graph.value.status : (settings.value.source === 'provider' ? settings.value.providerAvailable : model.ok && model.value.status === 'ready') ? hadSnapshot.current ? 'stale' : 'empty' : 'unconfigured');
    }).catch(() => { if (active && generation.current === current) { setState('failed'); setError('graph-unavailable'); } });
    return () => { active = false; generation.current++; stop(); };
  }, [api, scope, reload]);
  useEffect(() => {
    if (state !== 'building' || !resumedBuild) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await api.memoryMap.get(scope);
        if (!active) return;
        if (!result.ok) { setState('failed'); setError(result.error); return; }
        setSnapshot(result.value);
        if (!result.value) { setState('empty'); return; }
        if (result.value.status !== 'building') {
          if (result.value.status === 'ready') hadSnapshot.current = true;
          setState(result.value.status === 'ready' && !result.value.points.length ? 'empty' : result.value.status);
          return;
        }
        timer = setTimeout(() => void refresh(), BUILD_STATUS_REFRESH_MS);
      } catch { if (active) { setState('failed'); setError('graph-unavailable'); } }
    };
    timer = setTimeout(() => void refresh(), BUILD_STATUS_REFRESH_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [api, scope, state, resumedBuild]);
  useEffect(() => api.onMemorySaveResult(() => { setReload(value => value + 1); }), [api]);
  const visiblePoints = useMemo(() => (snapshot?.points ?? []).filter(point =>
    (!filters.sources?.length || filters.sources.includes(point.sourceKind)) &&
    (!filters.projectIds?.length || !!point.projectId && filters.projectIds.includes(point.projectId))), [snapshot, filters]);
  const visible = useMemo(() => new Set(visiblePoints.map(point => point.memoryId)), [visiblePoints]);
  const linkCount = snapshot?.edges.filter(edge => visible.has(edge.a) && visible.has(edge.b)).length ?? 0;
  const selectedPoint = snapshot?.points.find(point => point.memoryId === selected);
  const selectedRevision = selectedPoint?.contentRevision;
  useEffect(() => { setPage(0); setSelected(null); }, [filters, snapshot]);
  useEffect(() => {
    if (!selected || !selectedRevision) return;
    let active = true;
    setDetail(undefined); setBody(null);
    closeButton.current?.focus();
    void api.memoryGetDetail(selected, scope, selectedRevision).then(result => {
      if (!active) return;
      if (result.ok && result.source?.contentRevision !== selectedRevision) {
        setDetail({ ok: false, error: 'not-found' });
        return;
      }
      setDetail(result);
      setBody(result.ok && result.source ? stripTopHeading(result.source.content) : null);
    }).catch(() => { if (active) setDetail({ ok: false, error: 'read-failed' }); });
    return () => { active = false; };
  }, [api, selected, scope, selectedRevision]);
  const handleSelect = useCallback((id: string) => {
    if (!visible.has(id)) return;
    selectionReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(id);
  }, [visible]);
  const handleClose = () => { setSelected(null); selectionReturn.current?.focus(); };
  const handleBuild = async () => {
    const current = ++generation.current;
    setResumedBuild(false); setState('building'); setError(null); setSelected(null); setProgress(null);
    try {
      const result = await api.memoryMap.build(scope);
      if (current !== generation.current) return;
      if (result.ok) { hadSnapshot.current = true; setSnapshot(result.value); setState(result.value.points.length ? 'ready' : 'empty'); }
      else if (result.error === 'local-runtime-unavailable') setState('unavailable');
      else { setState(result.error === 'graph-stale' ? 'stale' : 'failed'); setError(result.error); }
    } catch { if (current === generation.current) { setState('failed'); setError('graph-build-failed'); } }
  };
  const handleCancel = async () => {
    const current = ++generation.current;
    try {
      const result = await api.memoryMap.cancel();
      if (current !== generation.current) return;
      if (result.ok) setReload(value => value + 1); else { setState('failed'); setError(result.error); }
    } catch { if (current === generation.current) { setState('failed'); setError('graph-build-failed'); } }
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
      {tab !== 'manage' && <Button size="sm" variant="outline" disabled={state === 'building' || state === 'loading' || state === 'unconfigured' || state === 'unavailable'} onClick={() => void handleBuild()}>{t('memoryMap.rebuild')}</Button>}
    </div>
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
            <ul className="grid gap-2 @[700px]:grid-cols-2">{visiblePoints.slice(page * CARD_PAGE_SIZE, (page + 1) * CARD_PAGE_SIZE).map(point => <li key={point.memoryId}><button type="button" aria-label={`${point.title} ${t(`memoryMap.source.${point.sourceKind}`)}${point.projectName ? ` · ${point.projectName}` : ""}`} aria-pressed={selected === point.memoryId} onClick={() => handleSelect(point.memoryId)} className="h-full w-full space-y-2 rounded-lg border p-3 text-left hover:bg-muted aria-pressed:bg-accent"><span className="block break-words text-sm font-medium">{point.title}</span><span className="block text-xs text-muted-foreground">{t(`memoryMap.source.${point.sourceKind}`)}{point.projectName ? ` · ${point.projectName}` : ''}</span></button></li>)}</ul>
            <nav aria-label={t('memoryMap.pages')} className="mt-3 flex items-center justify-between gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t('memoryMap.previous')}</Button><span className="text-xs">{t('memoryMap.page', { page: page + 1, total: Math.max(1, Math.ceil(visiblePoints.length / CARD_PAGE_SIZE)) })}</span><Button size="sm" variant="outline" disabled={(page + 1) * CARD_PAGE_SIZE >= visiblePoints.length} onClick={() => setPage(value => value + 1)}>{t('memoryMap.next')}</Button></nav>
          </TabsContent>
          {!visiblePoints.length && <p role="status" className="pointer-events-none absolute inset-x-4 top-16 rounded bg-background p-3 text-sm">{t('memoryMap.noFiltered')}</p>}
        </> : <div className="space-y-3 p-6" role="status">
          <p className="text-sm">{t(state === 'unavailable' ? 'memoryMap.error.local-runtime-unavailable'
            : state === 'empty' && snapshot?.status === 'ready' ? 'memoryMap.noMemories' : `memoryMap.state.${state}`)}</p>
          {error && <p role="alert" className="text-xs text-destructive">{t(`memoryMap.error.${error}`)}</p>}
          {(state === 'unconfigured' || state === 'unavailable') && <Button size="sm" onClick={onOpenEmbeddingSettings}>{t('memoryMap.openSettings')}</Button>}
          {state === 'building' && <><p className="text-xs">{progress ? t(`memoryMap.phase.${progress.phase}`, { completed: progress.completed, total: progress.total }) : snapshot?.status === 'building' ? t('memoryMap.phase.embedding', { completed: snapshot.coverage.embedded, total: snapshot.coverage.eligible }) : t('memoryMap.preparing')}</p>{progress && <progress aria-label={t('memoryMap.state.building')} value={progress.completed} max={Math.max(1, progress.total)} />}<Button size="sm" variant="outline" onClick={() => void handleCancel()}>{t('memoryMap.cancelBuild')}</Button></>}
          {['failed', 'stale', 'empty'].includes(state) && <Button size="sm" onClick={() => void handleBuild()}>{t(state === 'failed' ? 'memoryMap.retry' : 'memoryMap.rebuild')}</Button>}
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
