import '../../../../../test/renderer/setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import type { GraphSnapshot, MemoryMapApi, RetrievalAnswer } from '../../../../shared/memory-map.js';
import { MemoryQuestionBox } from '../MemoryQuestionBox.js';

const SNAPSHOT = { snapshotId: 's', catalogRevision: 'catalog', points: [{ memoryId: 'a', title: 'Current memory', sourceKind: 'user', contentRevision: 'r' }] } as GraphSnapshot;
type Reply = Awaited<ReturnType<MemoryMapApi['retrieve']>>;
function answer(queryId: string, text = 'Current excerpt'): RetrievalAnswer {
  return { snapshotId: 's', catalogRevision: 'catalog', queryId, matches: [{ memoryId: 'a', contentRevision: 'r', excerpt: text, score: 0.9, citation: 3 }], answerParts: [{ text, sourceMemoryIds: ['a'], citation: 3 }] };
}
function submit(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '질문' }));
}
describe('memory questions', () => {
  it('creates fresh ids, drops superseded answers and reports no matches', async () => {
    const api = createMemoryMapApi(); const onMatches = vi.fn();
    const replies: ((value: Reply) => void)[] = [];
    api.retrieve.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    render(<MemoryQuestionBox api={api} snapshot={SNAPSHOT} filters={{}} onMatches={onMatches} onSelect={vi.fn()} />);
    submit('first'); submit('second');
    const [first, second] = api.retrieve.mock.calls.map(row => row[0]);
    expect(first.queryId).not.toBe(second.queryId);
    await act(async () => replies[1]({ ok: true, value: answer(second.queryId) }));
    expect(screen.getByText('Current excerpt')).toBeTruthy();
    await act(async () => replies[0]({ ok: true, value: answer(first.queryId, 'Obsolete excerpt') }));
    expect(screen.queryByText('Obsolete excerpt')).toBeNull();
    expect(onMatches).toHaveBeenLastCalledWith(new Set(['a']));
    submit('third');
    await act(async () => replies[2]({ ok: true, value: { ...answer(api.retrieve.mock.calls[2][0].queryId), matches: [], answerParts: [] } }));
    expect(screen.getByText('일치하는 메모리가 없습니다. 다른 질문을 하거나 필터를 변경하세요.')).toBeTruthy();
  });
  it('clears on filters and ignores an in-flight reply after filter or snapshot changes', async () => {
    const api = createMemoryMapApi(); const onMatches = vi.fn(); const onSelect = vi.fn();
    let resolve!: (value: Reply) => void;
    api.retrieve.mockImplementation(() => new Promise(done => { resolve = done; }));
    const props = { api, snapshot: SNAPSHOT, filters: {}, onMatches, onSelect };
    const view = render(<MemoryQuestionBox {...props} />); submit('old scope');
    const queryId = api.retrieve.mock.calls[0][0].queryId;
    view.rerender(<MemoryQuestionBox {...props} filters={{ sources: ['assistant'] }} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    await act(async () => resolve({ ok: true, value: answer(queryId, 'Stale scope') }));
    expect(screen.queryByText('Stale scope')).toBeNull();
    expect(onMatches).toHaveBeenLastCalledWith(new Set());
    submit('old snapshot'); const second = api.retrieve.mock.calls[1][0].queryId;
    view.rerender(<MemoryQuestionBox {...props} snapshot={{ ...SNAPSHOT, snapshotId: 'new' }} />);
    await act(async () => resolve({ ok: true, value: answer(second, 'Stale snapshot') }));
    expect(screen.queryByText('Stale snapshot')).toBeNull();
  });
  it.each(['snapshot', 'catalog', 'query', 'content', 'membership'] as const)('rejects a mismatched %s identity', async kind => {
    const api = createMemoryMapApi(); const onMatches = vi.fn();
    api.retrieve.mockImplementation(async request => {
      const value = answer(request.queryId, 'Invalid answer');
      if (kind === 'snapshot') value.snapshotId = 'other';
      if (kind === 'catalog') value.catalogRevision = 'other';
      if (kind === 'query') value.queryId = 'other';
      if (kind === 'content') value.matches[0].contentRevision = 'old';
      if (kind === 'membership') value.matches[0].memoryId = 'unknown';
      return { ok: true, value };
    });
    render(<MemoryQuestionBox api={api} snapshot={SNAPSHOT} filters={{}} onMatches={onMatches} onSelect={vi.fn()} />);
    submit('question'); await waitFor(() => expect(api.retrieve).toHaveBeenCalledOnce());
    expect(screen.queryByText('Invalid answer')).toBeNull(); expect(onMatches).toHaveBeenLastCalledWith(new Set());
  });
  it('normalizes empty filter selections to all and translates host failures', async () => {
    const api = createMemoryMapApi(); api.retrieve.mockResolvedValue({ ok: false, error: 'graph-stale' });
    render(<MemoryQuestionBox api={api} snapshot={SNAPSHOT} filters={{ sources: [], projectIds: [] }} onMatches={vi.fn()} onSelect={vi.fn()} />);
    submit('question'); expect(api.retrieve.mock.calls[0][0].filters).toEqual({});
    expect(await screen.findByRole('alert')).toHaveTextContent('메모리가 변경되었습니다. 지도를 다시 만드세요.');
  });
  it('does not update matches after unmount', async () => {
    const api = createMemoryMapApi(), onMatches = vi.fn(); let resolve!: (reply: Reply) => void;
    api.retrieve.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<MemoryQuestionBox api={api} snapshot={SNAPSHOT} filters={{}} onMatches={onMatches} onSelect={vi.fn()} />);
    submit('question'); view.unmount(); const calls = onMatches.mock.calls.length;
    await act(async () => resolve({ ok: true, value: answer(api.retrieve.mock.calls[0][0].queryId) }));
    expect(onMatches).toHaveBeenCalledTimes(calls);
  });
});
