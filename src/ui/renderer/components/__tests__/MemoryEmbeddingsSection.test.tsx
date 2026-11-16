import '../../../../../test/renderer/setup.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMemoryMapApi } from '../../../../__tests__/support/memory-map-api.js';
import { MemoryEmbeddingsSection } from '../MemoryEmbeddingsSection.js';
import { en } from '../../../../i18n/messages/en.js';
import { ko } from '../../../../i18n/messages/ko.js';

describe('memory embeddings settings', () => {
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
