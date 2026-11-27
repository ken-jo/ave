import '../../../../../test/renderer/setup.js';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../../../../__tests__/support/deferred.js';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import { ko } from '../../../../i18n/messages/ko.js';
import { makeMockAveApi } from '../../../../../test/renderer/mock-ave-api.js';
import type { GraphSnapshot, MemoryBuildStatus, MemoryBuildView, MemoryMapApi } from '../../../../shared/memory-map.js';
import type { AveApi } from '../../types.js';
import type { MemoryGraphRenderer } from '../memory-graph-renderer.js';
import { MemoryView } from '../MemoryView.js';
import { MemoryViewWin32 } from '../MemoryViewWin32.js';

const renderer = vi.hoisted(() => ({ update: vi.fn<MemoryGraphRenderer['update']>(), zoom: vi.fn(), fit: vi.fn(), destroy: vi.fn(), callbacks: null as null | { onSelect: (id: string) => void; onError: () => void } }));
vi.mock('../memory-graph-renderer.js', () => ({
  MEMORY_SOURCE_TOKENS: { user: 'chart-1', assistant: 'chart-2', import: 'chart-3', capture: 'chart-4', unknown: 'chart-5' },
  createMemoryGraph: vi.fn((_container, callbacks) => { renderer.callbacks = callbacks; return renderer; }),
}));
vi.mock('../MemorySearchPanel.js', () => ({ MemorySearchPanel: () => <p>Manage existing memories</p> }));
const SNAPSHOT: GraphSnapshot = {
  snapshotId: 'snapshot', catalogRevision: 'catalog', authorizationScopeId: 'scope', status: 'ready',
  model: { id: 'local', revision: 'revision', dimensions: 384, preprocessingRevision: 'v1', namespace: { source: 'local', modelId: 'local', modelRevision: 'revision', preprocessingRevision: 'v1', dimensions: 384 } },
  projection: { algorithm: 'umap', dimensions: 2, version: 'v1', seed: 42, parameters: { nNeighbors: 2, minDist: 0.1, nEpochs: 200 } },
  coverage: { eligible: 3, embedded: 3, pending: 0, excluded: 0 },
  points: [
    { memoryId: 'a', contentRevision: 'r', title: 'Alpha memory', sourceKind: 'user', projectId: 'alpha', projectName: 'Alpha', x: 0, y: 0 },
    { memoryId: 'b', contentRevision: 'r', title: 'Beta memory', sourceKind: 'assistant', projectId: 'beta', projectName: 'Beta', x: 1, y: 0 },
    { memoryId: 'c', contentRevision: 'r', title: 'Global memory', sourceKind: 'assistant', x: 0, y: 1 },
  ],
  edges: [{ a: 'a', b: 'b', similarity: 0.82, kind: 'semantic-neighbour' }, { a: 'b', b: 'c', similarity: 0.81, kind: 'semantic-neighbour' }],
};
function setup() {
  const map = createMemoryMapApi();
  map.get.mockResolvedValue({ ok: true, value: SNAPSHOT });
  map.facets.mockResolvedValue({ ok: true, value: { sources: [{ sourceKind: 'user', count: 1 }, { sourceKind: 'assistant', count: 2 }], projects: [{ projectId: 'alpha', name: 'Alpha', count: 1 }, { projectId: 'beta', name: 'Beta', count: 1 }], playbooks: [] } });
  const { api: mockApi } = makeMockAveApi();
  const api = Object.assign(mockApi, { memoryMap: map, memoryGetDetail: vi.fn(async () => ({ ok: true, origin: { status: 'resolved', sessionId: 'source', title: 'Original source', quote: 'Source quote' }, source: { content: '# Alpha\n\nCurrent body', contentRevision: 'r' }, history: { entries: [] }, usage: { entries: [] } })), memoryGetSummaries: vi.fn(async () => ({ ok: true, notes: [{ id: 'a', content: '# Alpha\n\nCurrent body' }], entries: [], scopeCounts: { project: 1, global: 0, defaultProject: 0, defaultProjectApplicable: false } })) }) as unknown as AveApi;
  const props = { api, onAskAveToFix: vi.fn(async () => true), onOpenEmbeddingSettings: vi.fn(), onOpenSession: vi.fn() };
  return { map, api, props };
}
function selectTab(name: string) { fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false }); }
async function ready() { await screen.findByText('메모리 3 · 연결 2'); }

const FIRST_BUILD = '11111111-1111-4111-8111-111111111111';
const SECOND_BUILD = '22222222-2222-4222-8222-222222222222';
const REFUSAL = { ok: false, error: 'build-exit-unconfirmed' } as const;
const CANCELLED = { ok: true, value: null } as const;
const buildRow = (id: string, phase: MemoryBuildStatus['phase']): MemoryBuildStatus => ({ id, phase });
const cancelButton = () => screen.findByRole('button', { name: ko['memoryMap.cancelBuild'] });
const retryButton = () => screen.findByRole('button', { name: ko['memoryMap.retryCancel'] });

function setupWindows(snapshot: GraphSnapshot | null = SNAPSHOT, builds: MemoryBuildStatus[] = []) {
  const f = setup();
  let view: MemoryBuildView = { instance: 'host', revision: 1, snapshot, builds };
  const buildView = vi.fn<NonNullable<MemoryMapApi['buildView']>>(async () => ({ ok: true, value: view }));
  Object.assign(f.map, { buildView });
  const publish = (nextSnapshot: GraphSnapshot | null, ...nextBuilds: MemoryBuildStatus[]) => {
    view = { ...view, revision: view.revision + 1, snapshot: nextSnapshot, builds: nextBuilds };
  };
  const save = () => {
    const callback = vi.mocked(f.api.onMemorySaveResult).mock.calls.at(-1)?.[0];
    assert.ok(callback);
    act(() => callback({} as Parameters<typeof callback>[0]));
  };
  return { ...f, buildView, publish, save };
}

describe('Windows memory map build view', () => {
  it('links to the switch and keeps local rebuild disabled without duplicating the off notice', async () => {
    const { map, props } = setupWindows();
    map.modelStatus.mockResolvedValue({ ok: false, error: 'local-inference-disabled' });
    render(<MemoryViewWin32 {...props} />);
    expect(await screen.findByRole('button', { name: ko['memoryMap.openSettings'] })).toBeEnabled();
    expect(screen.queryByText(ko['memoryMap.error.local-inference-disabled'])).toBeNull();
    expect(screen.getByRole('button', { name: ko['memoryMap.rebuild'] })).toBeDisabled();
    expect(map.build).not.toHaveBeenCalled();
  });

  it('keeps a pre-takeover build cancellable through refresh and observes settlement', async () => {
    vi.useFakeTimers();
    const { map, props, publish, save } = setupWindows();
    const build = deferred<Awaited<ReturnType<typeof map.build>>>();
    map.build.mockImplementation((_scope, id) => {
      assert.ok(id);
      publish(SNAPSHOT, buildRow(id, 'admitting'));
      return build.promise;
    });
    const ui = render(<MemoryViewWin32 {...props} />);
    try {
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: ko['memoryMap.rebuild'] }));
      await act(async () => {});
      save();
      await act(async () => {});
      expect(screen.getByRole('button', { name: ko['memoryMap.cancelBuild'] })).toBeEnabled();
      const id = map.build.mock.calls[0][1];
      assert.ok(id);
      publish({ ...SNAPSHOT, status: 'building', snapshotId: id }, buildRow(id, 'running'));
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      const progress = map.onProgress.mock.calls.at(-1)?.[0];
      assert.ok(progress);
      act(() => progress({ jobId: id, phase: 'embedding', completed: 1, total: 3 }));
      publish(SNAPSHOT, { ...buildRow(id, 'stopped'), outcome: { kind: 'ready' } });
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(screen.queryByRole('button', { name: ko['memoryMap.cancelBuild'] })).toBeNull();
      selectTab(ko['memoryMap.cards']);
      expect(screen.getByText('Alpha memory')).toBeVisible();
      expect(map.get).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      build.resolve({ ok: true, value: SNAPSHOT });
      vi.useRealTimers();
    }
  });

  it('keeps a newer ready graph visible when Retry for an older exit refuses', async () => {
    const { map, props, publish, save } = setupWindows({ ...SNAPSHOT, status: 'building', snapshotId: FIRST_BUILD }, [buildRow(FIRST_BUILD, 'running')]);
    const pending = deferred<Awaited<ReturnType<typeof map.cancel>>>();
    map.cancel.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(REFUSAL);
    const view = render(<MemoryViewWin32 {...props} />);
    fireEvent.click(await cancelButton());
    publish(SNAPSHOT, buildRow(SECOND_BUILD, 'stopped'), buildRow(FIRST_BUILD, 'stopping'));
    save();
    selectTab(ko['memoryMap.cards']);
    await screen.findByText('Alpha memory');
    publish(SNAPSHOT, buildRow(SECOND_BUILD, 'stopped'), buildRow(FIRST_BUILD, 'exit-unconfirmed'));
    await act(async () => pending.resolve(REFUSAL));
    fireEvent.click(await retryButton());
    await waitFor(() => expect(map.cancel.mock.calls).toEqual([[FIRST_BUILD], [FIRST_BUILD]]));
    await waitFor(() => expect(screen.getByRole('button', { name: ko['memoryMap.retryCancel'] })).toBeEnabled());
    expect(screen.getByText('Alpha memory')).toBeVisible();
    view.unmount();
    render(<MemoryViewWin32 {...props} />);
    expect(await retryButton()).toBeEnabled();
  });

  it.each(['container', 'unconfined', 'account', 'projection'] as const)('shows the Windows %s Cancel refusal after a memory-save refresh', async () => {
    const { map, props, publish, save } = setupWindows({ ...SNAPSHOT, status: 'building', snapshotId: FIRST_BUILD }, [buildRow(FIRST_BUILD, 'running')]);
    const cancel = deferred<Awaited<ReturnType<typeof map.cancel>>>();
    map.cancel.mockReturnValueOnce(cancel.promise);
    render(<MemoryViewWin32 {...props} />);
    fireEvent.click(await cancelButton());
    publish(SNAPSHOT, buildRow(FIRST_BUILD, 'stopping'));
    save();
    await ready();
    publish(SNAPSHOT, buildRow(FIRST_BUILD, 'exit-unconfirmed'));
    await act(async () => cancel.resolve(REFUSAL));
    expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.build-exit-unconfirmed']);
  });

  it.each(['started', 'resumed'] as const)('retries Cancel for the %s Windows build after the view sees a newer build', async source => {
    const firstSnapshot = { ...SNAPSHOT, status: 'building' as const, snapshotId: FIRST_BUILD };
    const { map, props, publish, save } = source === 'started' ? setupWindows() : setupWindows(firstSnapshot, [buildRow(FIRST_BUILD, 'running')]);
    const pendingBuild = deferred<Awaited<ReturnType<typeof map.build>>>();
    const firstCancel = deferred<Awaited<ReturnType<typeof map.cancel>>>();
    let firstId = FIRST_BUILD;
    if (source === 'started') map.build.mockImplementationOnce((_scope, id) => {
      assert.ok(id);
      firstId = id;
      publish({ ...firstSnapshot, snapshotId: id }, buildRow(id, 'running'));
      return pendingBuild.promise;
    });
    map.cancel.mockReturnValueOnce(firstCancel.promise).mockResolvedValueOnce(REFUSAL).mockImplementationOnce(async () => {
      publish(SNAPSHOT, buildRow(SECOND_BUILD, 'stopped'), buildRow(firstId, 'exit-unconfirmed'));
      return CANCELLED;
    }).mockImplementationOnce(async () => {
      publish(SNAPSHOT, buildRow(SECOND_BUILD, 'stopped'));
      return CANCELLED;
    });
    render(<MemoryViewWin32 {...props} />);
    if (source === 'started') {
      await ready();
      fireEvent.click(screen.getByRole('button', { name: ko['memoryMap.rebuild'] }));
    }
    fireEvent.click(await cancelButton());
    publish({ ...firstSnapshot, snapshotId: SECOND_BUILD }, buildRow(SECOND_BUILD, 'running'), buildRow(firstId, 'exit-unconfirmed'));
    save();
    await act(async () => firstCancel.resolve(REFUSAL));
    fireEvent.click(await retryButton());
    await waitFor(() => expect(map.cancel.mock.calls).toEqual([[firstId], [firstId]]));
    expect(map.build).toHaveBeenCalledTimes(source === 'started' ? 1 : 0);
    const progress = map.onProgress.mock.calls.at(-1)?.[0];
    assert.ok(progress);
    act(() => {
      progress({ jobId: SECOND_BUILD, phase: 'embedding', completed: 2, total: 3 });
      progress({ jobId: firstId, phase: 'embedding', completed: 1, total: 2 });
    });
    expect(screen.getByText('임베딩 2 / 3')).toBeTruthy();
    await act(async () => pendingBuild.resolve({ ok: false, error: 'request-stale' }));
    fireEvent.click(await cancelButton());
    await ready();
    expect(screen.getByRole('alert')).toHaveTextContent(ko['memoryMap.error.build-exit-unconfirmed']);
    map.build.mockImplementationOnce(async (_scope, id) => {
      assert.ok(id);
      publish(SNAPSHOT, { ...buildRow(id, 'stopped'), outcome: { kind: 'failed', code: 'graph-build-failed' } }, buildRow(firstId, 'exit-unconfirmed'));
      return { ok: false, error: 'graph-build-failed' };
    });
    fireEvent.click(screen.getByRole('button', { name: ko['memoryMap.rebuild'] }));
    save();
    await ready();
    fireEvent.click(await retryButton());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(map.cancel.mock.calls).toEqual([[firstId], [firstId], [SECOND_BUILD], [firstId]]);
  });

  it('keeps both Windows refusals bound to their own Retry controls', async () => {
    const { map, props, publish } = setupWindows(SNAPSHOT, [buildRow(SECOND_BUILD, 'exit-unconfirmed'), buildRow(FIRST_BUILD, 'exit-unconfirmed')]);
    const second = deferred<Awaited<ReturnType<typeof map.cancel>>>();
    map.cancel.mockReturnValueOnce(second.promise).mockImplementationOnce(async () => {
      publish(SNAPSHOT, buildRow(SECOND_BUILD, 'exit-unconfirmed'));
      return CANCELLED;
    });
    render(<MemoryViewWin32 {...props} />);
    await ready();
    const [retrySecond, retryFirst] = screen.getAllByRole('button', { name: ko['memoryMap.retryCancel'] });
    fireEvent.click(retrySecond);
    expect(retrySecond).toBeDisabled();
    expect(retryFirst).toBeEnabled();
    fireEvent.click(retryFirst);
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    publish(SNAPSHOT);
    await act(async () => second.resolve(CANCELLED));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(map.cancel.mock.calls).toEqual([[SECOND_BUILD], [FIRST_BUILD]]);
    expect(map.build).not.toHaveBeenCalled();
  });
});

describe('memory map view', () => {
  it.each([null, SNAPSHOT])('disables local build on first open with an unsupported local runtime and snapshot %#', async snapshot => {
    const { map, props } = setup();
    map.get.mockResolvedValue({ ok: true, value: snapshot });
    map.modelStatus.mockResolvedValue({ ok: false, error: 'local-runtime-unavailable' });
    render(<MemoryView {...props} />);
    expect(await screen.findByText("로컬 모델을 네트워크에서 차단하는 OS 샌드박스가 활성화되어 있지 않아 로컬 임베딩을 사용할 수 없습니다.")).toBeTruthy();
    expect(screen.getByRole('button', { name: '지도 다시 만들기' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '메모리 임베딩 설정' }));
    expect(props.onOpenEmbeddingSettings).toHaveBeenCalledOnce();
    expect(map.build).not.toHaveBeenCalled();
  });
  it('keeps build disabled when refreshing after a local runtime refusal', async () => {
    const { api, map, props } = setup();
    const refusal = { ok: false, error: 'local-runtime-unavailable' } as const;
    map.build.mockResolvedValue(refusal);
    render(<MemoryView {...props} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
    expect(await screen.findByText("로컬 모델을 네트워크에서 차단하는 OS 샌드박스가 활성화되어 있지 않아 로컬 임베딩을 사용할 수 없습니다.")).toBeTruthy();
    expect(screen.getByRole('button', { name: '지도 다시 만들기' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();

    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'failed' } });
    map.modelStatus.mockResolvedValue(refusal);
    const save = vi.mocked(api.onMemorySaveResult).mock.calls[0]?.[0];
    if (!save) throw new Error('Missing memory save subscription');
    act(() => save({} as Parameters<typeof save>[0]));
    await waitFor(() => expect(map.modelStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("로컬 모델을 네트워크에서 차단하는 OS 샌드박스가 활성화되어 있지 않아 로컬 임베딩을 사용할 수 없습니다.")).toBeTruthy();
    expect(screen.getByRole('button', { name: '지도 다시 만들기' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '다시 시도' })).toBeNull();
    expect(map.build).toHaveBeenCalledOnce();
  });
  it('allows building a provider map without a local model installed', async () => {
    const { map, props } = setup(); map.get.mockResolvedValue({ ok: true, value: null });
    map.modelStatus.mockResolvedValue({ ok: false, error: 'local-runtime-unavailable' });
    map.settingsGet.mockResolvedValue({ ok: true, value: { source: 'provider', providerAvailable: true, providers: [], namespace: { ...SNAPSHOT.model.namespace, source: 'provider', providerId: 'configured' } } });
    render(<MemoryView {...props} />);
    await screen.findByText('아직 지도가 없습니다. 사용 가능한 메모리로 지도를 만드세요.');
    fireEvent.click(screen.getAllByRole('button', { name: '지도 다시 만들기' })[0]);
    await waitFor(() => expect(map.build).toHaveBeenCalledOnce());
  });
  it('uses OR within facets, AND across them and counts only induced links', async () => {
    const { props } = setup(); render(<MemoryView {...props} />); await ready();
    const filters = screen.getByRole('complementary', { name: '메모리 필터' });
    expect(within(filters).queryByText(/playbook/i)).toBeNull();
    fireEvent.click(within(filters).getByRole('button', { name: '어시스턴트 2' }));
    expect(screen.getByText('메모리 2 · 연결 1')).toBeTruthy();
    fireEvent.click(within(filters).getByRole('button', { name: '사용자 1' }));
    expect(screen.getByText('메모리 3 · 연결 2')).toBeTruthy();
    fireEvent.click(within(filters).getByRole('button', { name: 'Alpha 1' }));
    expect(screen.getByText('메모리 1 · 연결 0')).toBeTruthy();
    fireEvent.click(within(filters).getByRole('button', { name: '사용자 1' }));
    expect(screen.getByText('메모리 0 · 연결 0')).toBeTruthy();
    expect(screen.getByText('필터에 일치하는 메모리가 없습니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));
    expect(screen.getByText('메모리 3 · 연결 2')).toBeTruthy();
  });
  it('opens the same source detail from a point and a card, closes with Escape and preserves the map', async () => {
    const { props, api } = setup(); render(<MemoryView {...props} />); await ready();
    act(() => { const callbacks = renderer.callbacks; assert.ok(callbacks); callbacks.onSelect('a'); });
    expect(await screen.findByText('Source quote')).toBeTruthy();
    expect(screen.getByText('Current body')).toBeTruthy();
    expect(api.memoryGetDetail).toHaveBeenCalledWith('a', undefined, 'r');
    expect(api.memoryGetSummaries).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('complementary', { name: '메모리 소스 상세' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '메모리 소스 상세' })).toBeNull();
    selectTab('메모리 카드');
    const card = screen.getByRole('button', { name: 'Alpha memory 사용자 · Alpha' }); card.focus(); fireEvent.click(card);
    expect(await screen.findByText('Source quote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '소스 상세 닫기' }));
    expect(document.activeElement).toBe(card);
    selectTab('검색 및 관리');
    expect(screen.getByText('Manage existing memories')).toBeTruthy();
  });
  it('paginates the accessible card list', async () => {
    const { map, props } = setup();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, points: Array.from({ length: 25 }, (_, i) => ({ ...SNAPSHOT.points[0], memoryId: String(i), title: `Memory ${i}` })), edges: [] } });
    render(<MemoryView {...props} />);
    await screen.findByText('메모리 25 · 연결 0'); selectTab('메모리 카드');
    expect(screen.getAllByRole('listitem')).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('2 / 2')).toBeTruthy();
  });
  it('shows context loss, allows cards, exposes zoom and tears the renderer down', async () => {
    const { props } = setup(); const view = render(<MemoryView {...props} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '확대' })); expect(renderer.zoom).toHaveBeenCalledWith(1.5);
    fireEvent.click(screen.getByRole('button', { name: '지도 맞추기' })); expect(renderer.fit).toHaveBeenCalled();
    act(() => { const callbacks = renderer.callbacks; assert.ok(callbacks); callbacks.onError(); });
    expect(screen.getByRole('alert')).toHaveTextContent('메모리 카드');
    selectTab('메모리 카드'); expect(screen.getByText('Alpha memory')).toBeTruthy();
    view.unmount(); expect(renderer.destroy).toHaveBeenCalled();
  });
  it('routes unconfigured setup to settings, shows empty maps and handles failed build retry', async () => {
    const { map, props } = setup(); map.get.mockResolvedValue({ ok: true, value: null });
    const view = render(<MemoryView {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '메모리 임베딩 설정' })); expect(props.onOpenEmbeddingSettings).toHaveBeenCalledOnce();
    view.unmount();
    map.modelStatus.mockResolvedValue({ ok: true, value: { status: 'ready', receivedBytes: 1, totalBytes: 1, completedFiles: 4, totalFiles: 4 } });
    render(<MemoryView {...props} />);
    await screen.findByText('아직 지도가 없습니다. 사용 가능한 메모리로 지도를 만드세요.');
    fireEvent.click(screen.getAllByRole('button', { name: '지도 다시 만들기' })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent('메모리 지도를 만들 수 없습니다.');
    map.build.mockResolvedValue({ ok: true, value: SNAPSHOT });
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' })); await ready();
  });
  it('shows build progress and cancels, renders stale and loading states', async () => {
    const { map, props } = setup();
    map.build.mockImplementation(() => new Promise(() => {}));
    const view = render(<MemoryView {...props} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
    act(() => map.onProgress.mock.calls[0][0]({ jobId: 'job', phase: 'embedding', completed: 2, total: 3 }));
    expect(screen.getByText('임베딩 2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
    await waitFor(() => expect(map.cancel).toHaveBeenCalledOnce()); view.unmount();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'stale' } });
    render(<MemoryView {...props} />);
    expect(screen.getByText('메모리 지도 불러오는 중…')).toBeTruthy();
    expect(await screen.findByText('메모리가 변경되었습니다. 지도를 다시 만드세요.')).toBeTruthy();
  });
  it.each(['Macintosh', 'Linux'])('keeps resumed-build polling while Cancel is pending on %s', async platform => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
    vi.useFakeTimers();
    try {
      const { map, props } = setup();
      const cancel = deferred<Awaited<ReturnType<typeof map.cancel>>>();
      map.cancel.mockReturnValue(cancel.promise);
      map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'building' } });
      render(<MemoryView {...props} />);
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      expect(map.get).toHaveBeenCalledTimes(2);
      await act(async () => cancel.resolve({ ok: true, value: null }));
      expect(map.get).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      userAgent.mockRestore();
    }
  });
  it('asks within current filters, highlights matches, opens host-numbered citations and clears on filter change', async () => {
    const { map, props } = setup();
    map.retrieve.mockImplementation(async request => ({ ok: true, value: {
      snapshotId: request.snapshotId, catalogRevision: 'catalog', queryId: request.queryId,
      matches: [{ memoryId: 'a', contentRevision: 'r', excerpt: 'A grounded excerpt', score: 0.9, citation: 7 }],
      answerParts: [{ text: 'A grounded excerpt', sourceMemoryIds: ['a'], citation: 7 }],
    } }));
    render(<MemoryView {...props} project={{ projectRoot: 'C:/workspace/alpha', projectName: 'Alpha' }} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '사용자 1' }));
    const question = screen.getByRole('textbox', { name: '메모리에 물어보세요…' });
    fireEvent.change(question, { target: { value: 'What did I save?' } });
    const beforeSubmit = renderer.update.mock.calls.length;
    // Flush the retrieval reply and the canvas effect that delivers its matches.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '질문' }));
      await map.retrieve.mock.results[0].value;
    });
    const citation = screen.getByRole('button', { name: '소스 7: Alpha memory' });
    expect(map.retrieve.mock.calls[0][0]).toMatchObject({ question: 'What did I save?', scope: { projectRoot: 'C:/workspace/alpha', projectName: 'Alpha', includeUnscoped: false }, filters: { sources: ['user'] }, snapshotId: 'snapshot' });
    expect(map.retrieve.mock.calls[0][0].queryId).toBeTruthy();
    const matchedAt = renderer.update.mock.calls.slice(beforeSubmit).findIndex(([, , , matches]) => matches?.has('a'));
    expect(matchedAt).toBeGreaterThanOrEqual(0);
    fireEvent.click(citation); expect(await screen.findByText('Source quote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '소스 상세 닫기' }));
    const updatesWithMatches = renderer.update.mock.calls.slice(beforeSubmit + matchedAt);
    expect(updatesWithMatches.map(([, , selected]) => selected)).toContain('a');
    for (const [, , , matches] of updatesWithMatches) expect(matches).toEqual(new Set(['a']));

    const beforeClear = renderer.update.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '필터 초기화' })); });
    expect(screen.queryByText('A grounded excerpt')).toBeNull();
    expect(question).toHaveValue('');
    const filterUpdates = renderer.update.mock.calls.slice(beforeClear);
    const clearedAt = filterUpdates.findIndex(([, , , matches]) => matches?.size === 0);
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    for (const [, , , matches] of filterUpdates.slice(clearedAt)) expect(matches).toEqual(new Set());
  });
  it('marks a live snapshot stale when the host invalidates it and clears open sources', async () => {
    const { map, props, api } = setup();
    render(<MemoryView {...props} />); await ready();
    act(() => { const callbacks = renderer.callbacks; assert.ok(callbacks); callbacks.onSelect('a'); }); await screen.findByText('Source quote');
    map.get.mockResolvedValue({ ok: true, value: null });
    map.modelStatus.mockResolvedValue({ ok: true, value: { status: 'ready', receivedBytes: 1, totalBytes: 1, completedFiles: 4, totalFiles: 4 } });
    const save = vi.mocked(api.onMemorySaveResult).mock.calls[0][0];
    act(() => save({} as Parameters<typeof save>[0]));
    expect(await screen.findByText('메모리가 변경되었습니다. 지도를 다시 만드세요.')).toBeTruthy();
    expect(screen.queryByText('Source quote')).toBeNull();
  });
  it('distinguishes an empty built snapshot and shows counts for a resumed build', async () => {
    const { map, props } = setup();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, points: [], edges: [] } });
    const view = render(<MemoryView {...props} />);
    expect(await screen.findByText('아직 사용 가능한 메모리가 없습니다. 메모리를 저장한 뒤 지도를 다시 만드세요.')).toBeTruthy();
    view.unmount();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'building', coverage: { eligible: 3, embedded: 2, pending: 1, excluded: 0 } } });
    render(<MemoryView {...props} />);
    expect(await screen.findByText('임베딩 2 / 3')).toBeTruthy();
  });
  it('drops old graph reads when the active scope changes', async () => {
    const { map, props } = setup();
    let finish!: (value: Awaited<ReturnType<typeof map.get>>) => void;
    map.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<MemoryView {...props} />);
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, snapshotId: 'new-scope' } });
    const beforeScopeChange = renderer.update.mock.calls.length;
    await act(async () => {
      view.rerender(<MemoryView {...props} project={{ projectRoot: 'C:/workspace/other', projectName: 'Other' }} />);
    });
    expect(renderer.update.mock.calls.slice(beforeScopeChange).map(([snapshot]) => snapshot.snapshotId)).toContain('new-scope');
    const beforeStaleReply = renderer.update.mock.calls.length;
    await act(async () => finish({ ok: true, value: SNAPSHOT }));
    expect(renderer.update.mock.calls.slice(beforeStaleReply).map(([snapshot]) => snapshot.snapshotId)).not.toContain(SNAPSHOT.snapshotId);
  });
  it('observes the completion of a build that was running when this view mounted', async () => {
    const { map, props } = setup();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'building' } });
    vi.useFakeTimers();
    let view: ReturnType<typeof render> | undefined;
    try {
      await act(async () => { view = render(<MemoryView {...props} />); });
      expect(screen.getByText('메모리 지도 만드는 중…')).toBeTruthy();
      map.get.mockResolvedValue({ ok: true, value: SNAPSHOT });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(screen.getByRole('region', { name: /메모리 지도 —/ })).toBeTruthy();
      const count = map.get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(map.get).toHaveBeenCalledTimes(count);
    } finally { view?.unmount(); vi.useRealTimers(); }
  });
});
