import { requiredFixture } from "../../../../__tests__/support/required-fixture.js";
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeMockAveApi } from '../../../../../test/renderer/mock-ave-api.js';
import { useSettingsOrchestration } from '../use-settings-orchestration.js';
import type { AveApi } from '../../types.js';

describe('round budget persistence', () => {
  it('skips unchanged and invalid values and reconciles a valid saved response', async () => {
    const { api } = makeMockAveApi();
    Object.assign(api, { hasWebApiKey: vi.fn(async () => false), hasMarketplaceApiKey: vi.fn(async () => false) });
    const onSaved = vi.fn(); const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, onSaved));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const previous = result.current.subAgentMaxRounds;
    requiredFixture(api.updateSettings).mockClear();
    act(() => { for (const value of [previous, 0, -5, 1.5, 1001]) result.current.setSubAgentMaxRounds(value); });
    expect(api.updateSettings).not.toHaveBeenCalled();
    act(() => result.current.setSubAgentMaxRounds(1000));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ chat: { subAgentMaxRounds: 1000 } });
    expect(result.current.subAgentMaxRounds).toBe(1000);
  });
});
