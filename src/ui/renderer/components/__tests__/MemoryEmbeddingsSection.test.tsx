import '../../../../../test/renderer/setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { IpcDeps } from '../../../../ipc/types.js';
import { registerMemoryMapHandlers } from '../../../../ipc/domains/memory-map.js';
import { CHANNELS } from '../../../../contract/app-contract.js';
import type { MemoryEmbeddingConfig } from '../../../../shared/memory-embedding-config.js';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import { MemoryEmbeddingsSection } from '../MemoryEmbeddingsSection.js';
import { en } from '../../../../i18n/messages/en.js';
import { ko } from '../../../../i18n/messages/ko.js';

const ROUTE = { endpointId: 'a'.repeat(64), origin: 'https://example.com' };
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) } }));

describe('memory embeddings settings', () => {
  it('refuses consent from a mounted form after the destination changes', async () => {
    const api = createMemoryMapApi();
    const event = { senderFrame: { url: 'file:///app/index.html' } } as IpcMainInvokeEvent;
    let baseUrl = 'https://api.openai.com/v1';
    let config: MemoryEmbeddingConfig | undefined;
    const set = vi.fn(async (_key: string, value: MemoryEmbeddingConfig) => { config = value; });
    const transport = vi.fn();
    registerMemoryMapHandlers({
      auditLogger: { log: vi.fn() },
      settingsService: {
        get: (key: string) => key === 'memoryEmbedding' ? config : key === 'llm' ? {
          vendors: { openai: { baseUrl } },
          modelListCache: { saved: {
            vendor: 'openai', baseUrl, endpoint: baseUrl + '/models', models: ['embed-a'],
            modelEntries: [{ id: 'embed-a', outputModalities: ['embedding'] }],
          } },
        } : undefined,
        hasStoredSecret: async (name: string) => name === 'llm.apiKey.openai',
        set,
      },
      singleHopNetworkFetch: transport,
      memoryManager: { readMemoryPanelCatalog: () => ({ notes: [] }) },
    } as unknown as IpcDeps, () => ({ ok: true, options: {} }));
    api.settingsGet.mockImplementation(async () =>
      await handlers.get(CHANNELS.memoryMap.settingsGet)!(event) as Awaited<ReturnType<typeof api.settingsGet>>);
    api.settingsSet.mockImplementation(async input =>
      await handlers.get(CHANNELS.memoryMap.settingsSet)!(event, input) as Awaited<ReturnType<typeof api.settingsSet>>);

    render(<MemoryEmbeddingsSection api={api} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '제공자' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '제공자' }));
    fireEvent.change(screen.getByRole('combobox', { name: '제공자' }), { target: { value: 'openai' } });
    fireEvent.change(screen.getByRole('combobox', { name: '임베딩 모델' }), { target: { value: 'embed-a' } });
    const previousDestination = screen.queryByText(/https:\/\/api\.openai\.com/);
    const acknowledgement = screen.getByRole('checkbox');
    fireEvent.click(acknowledgement);
    const save = screen.getByRole('button', { name: '저장' });
    expect(save).toBeEnabled();
    baseUrl = 'https://api.mistral.ai/v1';
    fireEvent.click(save);
    await waitFor(() => expect(api.settingsSet).toHaveBeenCalledOnce());
    expect(await api.settingsSet.mock.results[0]!.value).toEqual({ ok: false, error: 'request-stale' });
    expect(previousDestination).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    expect(await handlers.get(CHANNELS.memoryMap.build)!(event)).toEqual({ ok: false, error: 'model-unconfigured' });
    expect(transport).not.toHaveBeenCalled();
    expect(await screen.findByText(/https:\/\/api\.mistral\.ai/)).toBeTruthy();
    expect(acknowledgement).not.toBeChecked();
    expect(save).toBeDisabled();
    fireEvent.click(acknowledgement);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledOnce());
    const [first, second] = api.settingsSet.mock.calls.map(([selection]) => selection.source === 'provider' ? selection.endpointId : undefined);
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
    expect(config?.consent).toMatchObject({ modelId: 'embed-a', endpointId: second });
    expect(transport).not.toHaveBeenCalled();
  });
  it('revokes persisted provider consent when its acknowledgement is cleared', async () => {
    const api = createMemoryMapApi();
    const initial = await api.settingsGet();
    if (!initial.ok) throw new Error('Missing settings');
    const namespace = { ...initial.value.namespace, source: 'provider' as const, providerId: 'configured', modelId: 'embed-a', modelRevision: ROUTE.endpointId };
    api.settingsGet.mockResolvedValue({ ok: true, value: {
      ...initial.value, source: 'provider', namespace, providers: [{ id: 'configured', models: ['embed-a'], route: ROUTE }],
      consent: { version: 2, providerId: 'configured', modelId: 'embed-a', endpointId: namespace.modelRevision, timestamp: '2026-11-22T00:00:00Z' },
    } });
    api.settingsSet.mockResolvedValue(initial);
    render(<MemoryEmbeddingsSection api={api} />);
    const acknowledgement = await screen.findByRole('checkbox');
    expect(acknowledgement).toBeChecked();
    fireEvent.click(acknowledgement);
    expect(api.settingsSet).toHaveBeenCalledWith({ source: 'local' });
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });
  it('requires explicit provider and model consent, resets it on changes, and opts out immediately', async () => {
    const api = createMemoryMapApi();
    const initial = await api.settingsGet();
    if (!initial?.ok) throw new Error('Missing settings');
    api.settingsGet.mockClear();
    api.settingsGet.mockResolvedValue({ ok: true, value: { ...initial.value, providers: [{ id: 'configured', models: ['embed-a', 'embed-b'], route: ROUTE }, { id: 'no-embedding', models: [], reason: 'provider-no-embedding-model' }] } });
    api.settingsSet.mockImplementation(async selection => ({ ok: true, value: { ...initial.value, source: selection.source, namespace: { ...initial.value.namespace, source: selection.source } } }));
    render(<MemoryEmbeddingsSection api={api} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '제공자' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '제공자' }));
    const save = screen.getByRole('button', { name: '저장' }); expect(save).toBeDisabled();
    const provider = screen.getByRole('combobox', { name: '제공자' }); const model = screen.getByRole('combobox', { name: '임베딩 모델' });
    fireEvent.change(provider, { target: { value: 'configured' } }); fireEvent.change(model, { target: { value: 'embed-a' } });
    expect(save).toBeDisabled(); expect(api.settingsSet).not.toHaveBeenCalled();
    const consent = screen.getByRole('checkbox'); expect(consent).toHaveAccessibleName(/configured/); expect(consent).toHaveAccessibleName(/질문/);
    fireEvent.click(consent); expect(save).toBeEnabled();
    fireEvent.change(model, { target: { value: 'embed-b' } }); expect(consent).not.toBeChecked(); expect(save).toBeDisabled();
    fireEvent.click(consent); fireEvent.click(save);
    await waitFor(() => expect(api.settingsSet).toHaveBeenCalledWith({ source: 'provider', providerId: 'configured', modelId: 'embed-b', endpointId: ROUTE.endpointId, consent: true }));
    await waitFor(() => expect(screen.getByRole('radio', { name: '로컬' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '로컬' }));
    await waitFor(() => expect(api.settingsSet).toHaveBeenLastCalledWith({ source: 'local' }));
  });
  it.each(['provider-no-embedding-model', 'provider-route-ineligible'] as const)('shows translated refusal for %s', async reason => {
    const api = createMemoryMapApi(); const result = await api.settingsGet(); if (!result.ok) throw new Error('Missing settings');
    api.settingsGet.mockResolvedValue({ ok: true, value: { ...result.value, providers: [{ id: 'no-embedding', models: [], route: ROUTE, reason }] } });
    render(<MemoryEmbeddingsSection api={api} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: '제공자' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '제공자' })); fireEvent.change(screen.getByRole('combobox', { name: '제공자' }), { target: { value: 'no-embedding' } });
    expect(screen.getByText(ko[`memoryMap.error.${reason}`])).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '임베딩 모델' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  });
  it('keeps setup explicit and reports failed folder validation and retry', async () => {
    const api = createMemoryMapApi();
    render(<MemoryEmbeddingsSection api={api} />);
    const download = await screen.findByRole('button', { name: '로컬 모델 다운로드' });
    await waitFor(() => expect(download).toBeEnabled());
    expect(api.modelDownload).not.toHaveBeenCalled();
    expect(api.settingsSet).not.toHaveBeenCalled();
    expect(screen.getByText(/135 MB/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '기존 모델 사용' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.model-folder-invalid']);
    fireEvent.click(download);
    await waitFor(() => expect(api.modelDownload).toHaveBeenCalledOnce());
    expect(await screen.findByRole('alert')).toHaveTextContent(ko['memoryMap.error.model-download-failed']);
  });
  it('shows progress bytes, cancel, ready revision and removes its subscription', async () => {
    const api = createMemoryMapApi();
    const stop = api.onModelProgress.mock.results;
    const view = render(<MemoryEmbeddingsSection api={api} />);
    await screen.findByText('모델이 설정되지 않았습니다');
    act(() => api.onModelProgress.mock.calls[0]![0]({ status: 'downloading', receivedBytes: 1024, totalBytes: 2048, completedFiles: 1, totalFiles: 4 }));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1024');
    expect(screen.getByText('1,024 / 2,048 바이트')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다운로드 취소' }));
    await waitFor(() => expect(api.modelCancel).toHaveBeenCalledOnce());
    act(() => api.onModelProgress.mock.calls[0]![0]({ status: 'ready', receivedBytes: 2048, totalBytes: 2048, completedFiles: 4, totalFiles: 4 }));
    expect(await screen.findByText(/revision-1/)).toBeTruthy();
    view.unmount();
    expect(stop[0]!.value).toHaveBeenCalledOnce();
  });
  it('offers retry with a translated failure and accepts an existing model', async () => {
    const api = createMemoryMapApi();
    const status = { status: 'failed' as const, error: 'model-integrity-failed' as const, receivedBytes: 0, totalBytes: 1, completedFiles: 0, totalFiles: 4 };
    api.modelStatus.mockResolvedValue({ ok: true, value: status });
    api.modelUseExisting.mockResolvedValue({ ok: true, value: { ...status, status: 'ready', error: undefined } });
    render(<MemoryEmbeddingsSection api={api} />);
    expect(await screen.findByRole('button', { name: '다운로드 재시도' })).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(ko['memoryMap.error.model-integrity-failed']);
    fireEvent.click(screen.getByRole('button', { name: '기존 모델 사용' }));
    expect(await screen.findByText(/모델 준비됨/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps embedding and map keys in both catalogs', () => {
    const keys = (catalog: Record<string, string>) => Object.keys(catalog).filter(key => key.startsWith('memoryEmbeddings.') || key.startsWith('memoryMap.')).sort();
    expect(keys(en)).toEqual(keys(ko));
  });
});
