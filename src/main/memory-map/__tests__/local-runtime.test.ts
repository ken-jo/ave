import { afterEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
const state = vi.hoisted(() => ({ confined: true, plan: undefined as undefined | { readiness: string; selectedBackend: string } }));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({ isOfflineProcessConfinementActive: () => state.confined }));
vi.mock('../../../permissions/sandbox-capability.js', () => ({ getWindowsExtensionBackendPlan: () => state.plan }));
import { assertLocalEmbeddingRuntime } from '../local-runtime.js';
const hostPlatform = process.platform;
function refusal(): string | undefined {
  try { assertLocalEmbeddingRuntime(); } catch (error) { return (error as { code?: string }).code ?? String(error); }
  return undefined;
}
afterEach(() => { setProcessPlatform(hostPlatform); state.confined = true; state.plan = undefined; });
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
});
