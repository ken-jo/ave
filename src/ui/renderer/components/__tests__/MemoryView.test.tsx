import '../../../../../test/renderer/setup.js';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import { ko } from '../../../../i18n/messages/ko.js';
import { makeMockAveApi } from '../../../../../test/renderer/mock-ave-api.js';
import type { GraphSnapshot } from '../../../../shared/memory-map.js';
import type { AveApi } from '../../types.js';
import type { MemoryGraphRenderer } from '../memory-graph-renderer.js';
import { MemoryView } from '../MemoryView.js';

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

describe('memory map view', () => {
  it('links to the switch and keeps local rebuild disabled without duplicating the off notice', async () => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    try {
      const { map, props } = setup();
      map.modelStatus.mockResolvedValue({ ok: false, error: 'local-inference-disabled' });
      render(<MemoryView {...props} />);
      expect(await screen.findByRole('button', { name: '메모리 임베딩 설정' })).toBeEnabled();
      expect(screen.queryByText(ko['memoryMap.error.local-inference-disabled'])).toBeNull();
      expect(screen.getByRole('button', { name: '지도 다시 만들기' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '메모리 임베딩 설정' })).toBeEnabled();
      expect(map.build).not.toHaveBeenCalled();
    } finally {
      userAgent.mockRestore();
    }
  });

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
  it('shows the cancellation refusal after ignoring the superseded build reply', async () => {
    const { map, props } = setup();
    const build = Promise.withResolvers<Awaited<ReturnType<typeof map.build>>>();
    map.build.mockReturnValue(build.promise);
    map.cancel.mockResolvedValue({ ok: false, error: 'build-exit-unconfirmed' });
    render(<MemoryView {...props} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
    fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
    await act(async () => build.resolve({ ok: false, error: 'request-stale' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('메모리 지도 작업 프로세스가 종료됐는지 확인할 수 없습니다.');
    expect(map.get).toHaveBeenCalledOnce();
  });
  it.each(['container', 'unconfined', 'account'] as const)('shows the Windows %s Cancel refusal after a memory-save refresh', async () => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    try {
      const { map, props, api } = setup();
      const cancel = Promise.withResolvers<Awaited<ReturnType<typeof map.cancel>>>();
      map.cancel.mockReturnValue(cancel.promise);
      map.build.mockImplementation(() => new Promise(() => {}));
      render(<MemoryView {...props} />); await ready();
      fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
      fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
      const save = vi.mocked(api.onMemorySaveResult).mock.calls[0][0];
      act(() => save({} as Parameters<typeof save>[0]));
      await waitFor(() => expect(map.get).toHaveBeenCalledTimes(2));
      await act(async () => cancel.resolve({ ok: false, error: 'build-exit-unconfirmed' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.build-exit-unconfirmed']);
    } finally {
      userAgent.mockRestore();
    }
  });
  it.each(['started', 'resumed'] as const)('retries Cancel for the %s Windows build after the view sees a newer build', async source => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows');
    try {
      const { map, props, api } = setup();
      const firstId = '11111111-1111-4111-8111-111111111111';
      const secondId = '22222222-2222-4222-8222-222222222222';
      const firstCancel = Promise.withResolvers<Awaited<ReturnType<typeof map.cancel>>>();
      const refusal = { ok: false, error: 'build-exit-unconfirmed' } as const;
      map.cancel.mockReturnValueOnce(firstCancel.promise).mockResolvedValueOnce(refusal).mockResolvedValueOnce({ ok: true, value: null });
      map.build.mockImplementation(() => new Promise(() => {}));
      if (source === 'resumed') map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'building', snapshotId: firstId } });
      render(<MemoryView {...props} />);
      if (source === 'started') {
        await ready();
        fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
      }
      fireEvent.click(await screen.findByRole('button', { name: '지도 생성 취소' }));
      map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'building', snapshotId: secondId } });
      const save = vi.mocked(api.onMemorySaveResult).mock.calls[0][0];
      act(() => save({} as Parameters<typeof save>[0]));
      await waitFor(() => expect(map.get).toHaveBeenCalledTimes(2));
      await act(async () => firstCancel.resolve(refusal));
      expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.build-exit-unconfirmed']);

      fireEvent.click(screen.getByRole('button', { name: ko['memoryMap.retryCancel'] }));
      expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.build-exit-unconfirmed']);
      const displayedId = source === 'started' ? map.build.mock.calls[0]?.[1] : firstId;
      expect(displayedId).toBeTruthy();
      expect(map.cancel.mock.calls).toEqual([[displayedId], [displayedId]]);
      expect(map.build).toHaveBeenCalledTimes(source === 'started' ? 1 : 0);

      const progress = map.onProgress.mock.calls.at(-1)?.[0];
      assert.ok(progress);
      act(() => {
        progress({ jobId: firstId, phase: 'embedding', completed: 1, total: 2 });
        progress({ jobId: secondId, phase: 'embedding', completed: 2, total: 3 });
      });
      expect(screen.getByText('임베딩 2 / 3')).toBeTruthy();
      map.get.mockResolvedValue({ ok: true, value: SNAPSHOT });
      fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
      await waitFor(() => expect(map.cancel).toHaveBeenLastCalledWith(secondId));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    } finally {
      userAgent.mockRestore();
    }
  });
  it.each(['Macintosh', 'Linux'])('keeps resumed-build polling while Cancel is pending on %s', async platform => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform);
    vi.useFakeTimers();
    try {
      const { map, props } = setup();
      const cancel = Promise.withResolvers<Awaited<ReturnType<typeof map.cancel>>>();
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
