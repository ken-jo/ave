import '../../../../../test/renderer/setup.js';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import { makeMockAveApi } from '../../../../../test/renderer/mock-ave-api.js';
import type { GraphSnapshot } from '../../../../shared/memory-map.js';
import type { AveApi } from '../../types.js';
import { MemoryView } from '../MemoryView.js';

const renderer = vi.hoisted(() => ({ update: vi.fn(), zoom: vi.fn(), fit: vi.fn(), destroy: vi.fn(), callbacks: null as null | { onSelect: (id: string) => void; onError: () => void } }));
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
  it('allows building a provider map without a local model installed', async () => {
    const { map, props } = setup(); map.get.mockResolvedValue({ ok: true, value: null });
    map.settingsGet.mockResolvedValue({ ok: true, value: { source: 'provider', providerAvailable: true, providers: [], namespace: { ...SNAPSHOT.model.namespace, source: 'provider', providerId: 'configured' } } });
    render(<MemoryView {...props} />);
    await screen.findByText('아직 지도가 없습니다. 사용 가능한 메모리로 지도를 만드세요.');
    fireEvent.click(screen.getAllByRole('button', { name: '지도 다시 만들기' })[0]!);
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
    act(() => renderer.callbacks!.onSelect('a'));
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
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, points: Array.from({ length: 25 }, (_, i) => ({ ...SNAPSHOT.points[0]!, memoryId: String(i), title: `Memory ${i}` })), edges: [] } });
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
    act(() => renderer.callbacks!.onError());
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
    fireEvent.click(screen.getAllByRole('button', { name: '지도 다시 만들기' })[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('메모리 지도를 만들 수 없습니다.');
    map.build.mockResolvedValue({ ok: true, value: SNAPSHOT });
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' })); await ready();
  });
  it('shows build progress and cancels, renders stale and loading states', async () => {
    const { map, props } = setup();
    map.build.mockImplementation(() => new Promise(() => {}));
    const view = render(<MemoryView {...props} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: '지도 다시 만들기' }));
    act(() => map.onProgress.mock.calls[0]![0]({ jobId: 'job', phase: 'embedding', completed: 2, total: 3 }));
    expect(screen.getByText('임베딩 2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지도 생성 취소' }));
    await waitFor(() => expect(map.cancel).toHaveBeenCalledOnce()); view.unmount();
    map.get.mockResolvedValue({ ok: true, value: { ...SNAPSHOT, status: 'stale' } });
    render(<MemoryView {...props} />);
    expect(screen.getByText('메모리 지도 불러오는 중…')).toBeTruthy();
    expect(await screen.findByText('메모리가 변경되었습니다. 지도를 다시 만드세요.')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: '질문' }));
    const citation = await screen.findByRole('button', { name: '소스 7: Alpha memory' });
    expect(map.retrieve.mock.calls[0]![0]).toMatchObject({ question: 'What did I save?', scope: { projectRoot: 'C:/workspace/alpha', projectName: 'Alpha', includeUnscoped: false }, filters: { sources: ['user'] }, snapshotId: 'snapshot' });
    expect(map.retrieve.mock.calls[0]![0].queryId).toBeTruthy();
    expect(renderer.update.mock.lastCall![3]).toEqual(new Set(['a']));
    fireEvent.click(citation); expect(await screen.findByText('Source quote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '소스 상세 닫기' }));
    fireEvent.click(screen.getByRole('button', { name: '필터 초기화' }));
    expect(screen.queryByText('A grounded excerpt')).toBeNull();
    expect(question).toHaveValue(''); expect(renderer.update.mock.lastCall![3]).toEqual(new Set());
  });
  it('marks a live snapshot stale when the host invalidates it and clears open sources', async () => {
    const { map, props, api } = setup();
    render(<MemoryView {...props} />); await ready();
    act(() => renderer.callbacks!.onSelect('a')); await screen.findByText('Source quote');
    map.get.mockResolvedValue({ ok: true, value: null });
    map.modelStatus.mockResolvedValue({ ok: true, value: { status: 'ready', receivedBytes: 1, totalBytes: 1, completedFiles: 4, totalFiles: 4 } });
    const save = vi.mocked(api.onMemorySaveResult).mock.calls[0]![0];
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
    view.rerender(<MemoryView {...props} project={{ projectRoot: 'C:/workspace/other', projectName: 'Other' }} />);
    await waitFor(() => expect(renderer.update.mock.lastCall![0].snapshotId).toBe('new-scope'));
    await act(async () => finish({ ok: true, value: SNAPSHOT }));
    expect(renderer.update.mock.lastCall![0].snapshotId).toBe('new-scope');
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
      expect(screen.getByRole('group', { name: /메모리 지도 —/ })).toBeTruthy();
      const count = map.get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(map.get).toHaveBeenCalledTimes(count);
    } finally { view?.unmount(); vi.useRealTimers(); }
  });
});
