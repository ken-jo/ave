import { afterEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
const state = vi.hoisted(() => ({ confined: true, holder: false, plan: undefined as undefined | { readiness: string; selectedBackend: string } }));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({ isOfflineProcessConfinementActive: () => state.confined, isOfflineHolderConfinementActive: () => state.holder }));
vi.mock('../../../permissions/sandbox-capability.js', () => ({ getExtensionBackendPlan: () => state.plan }));
import { assertLocalEmbeddingRuntime } from '../local-runtime.js';
const hostPlatform = process.platform;
function refusal(): string | undefined {
  try { assertLocalEmbeddingRuntime(); } catch (error) { return (error as { code?: string }).code ?? String(error); }
  return undefined;
}
afterEach(() => { setProcessPlatform(hostPlatform); state.confined = true; state.holder = false; state.plan = undefined; });
describe('local embedding runtime gate', () => {
  it('allows Windows local inference once the OS sandbox confines the inference child', () => {
    setProcessPlatform('win32');
    state.plan = { readiness: 'off', selectedBackend: 'none' };
    expect(refusal()).toBeUndefined();
  });
  it.each(['win32', 'darwin', 'linux'] as const)('refuses on %s while the OS sandbox is not active', platform => {
    setProcessPlatform(platform);
    state.confined = false;
    expect(refusal()).toBe('local-runtime-unavailable');
  });
  it.each([
    { readiness: 'checking', selectedBackend: 'none' },
    { readiness: 'rejected', selectedBackend: 'none' },
    { readiness: 'ready', selectedBackend: 'mxc' },
  ])('refuses on Windows while the extension plan $readiness/$selectedBackend would refuse the confined child', plan => {
    setProcessPlatform('win32');
    state.plan = plan;
    expect(refusal()).toBe('local-runtime-unavailable');
  });
  it('allows macOS local inference in an offline holder once the holder route is proven, whatever the extension plan', () => {
    setProcessPlatform('darwin');
    state.confined = false;
    state.holder = true;
    state.plan = { readiness: 'ready', selectedBackend: 'mxc' };
    expect(refusal()).toBeUndefined();
  });
  it('refuses macOS local inference with the holder route on and unproven: the wrap no longer counts, and nothing asks', () => {
    setProcessPlatform('darwin');
    state.confined = false;
    state.holder = false;
    expect(refusal()).toBe('local-runtime-unavailable');
  });
});
