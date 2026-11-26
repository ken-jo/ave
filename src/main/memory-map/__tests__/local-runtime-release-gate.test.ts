import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { registerMxcReleaseGateEvidence } from '../../../permissions/mxc-extension-admission.js';
import type { SandboxWindowsExtensionPlan, SandboxWindowsSubstrateInfo } from '../../../shared/sandbox-capability-info.js';
import { assertLocalEmbeddingRuntime } from '../local-runtime.js';

const state = vi.hoisted(() => ({
  confined: false, homeVerified: true,
  plan: undefined as Pick<SandboxWindowsExtensionPlan, 'selectedBackend' | 'readiness' | 'reason'> | undefined,
  substrate: undefined as Pick<SandboxWindowsSubstrateInfo, 'mxc' | 'srtWinReady'> | undefined,
}));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({ isOfflineProcessConfinementActive: () => state.confined }));
vi.mock('../../../permissions/sandbox-capability.js', () => ({
  getWindowsExtensionBackendPlan: () => state.plan,
  getWindowsSandboxSubstrate: () => state.substrate,
}));
vi.mock('../../../shared/ave-home.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/ave-home.js')>(),
  isAveHomePrivacyVerifiedAtBoot: () => state.homeVerified,
}));

const HOST_PLATFORM = process.platform;
const EVIDENCE = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};
let unregister: (() => void) | undefined;

beforeEach(() => {
  setProcessPlatform('win32');
  state.confined = false;
  state.homeVerified = true;
  state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'container-unavailable' };
  state.substrate = { mxc: { state: 'unavailable', reason: 'container-unavailable' }, srtWinReady: false };
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
  setProcessPlatform(HOST_PLATFORM);
});

describe('Windows local inference release gate', () => {
  it('preserves refusal without complete packaged evidence', () => {
    expect(() => assertLocalEmbeddingRuntime()).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
    unregister = registerMxcReleaseGateEvidence({ ...EVIDENCE, noWorkerPort: false });
    expect(() => assertLocalEmbeddingRuntime()).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });

  it('selects the available container regardless of the no-backend preference', () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.plan = { selectedBackend: 'mxc', readiness: 'ready', reason: 'ready' };
    expect(assertLocalEmbeddingRuntime(false)).toBe('mxc');
  });

  it('defaults to the host child with confirmed backend absence and honours explicit false', () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    expect(assertLocalEmbeddingRuntime()).toBe('unconfined');
    expect(assertLocalEmbeddingRuntime(true)).toBe('unconfined');
    expect(() => assertLocalEmbeddingRuntime(false)).toThrow(expect.objectContaining({ code: 'local-inference-disabled' }));
    state.plan = { selectedBackend: 'none', readiness: 'off', reason: 'not-requested' };
    expect(assertLocalEmbeddingRuntime()).toBe('unconfined');
  });

  it('preserves the active offline sandbox independently of the preference', () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.confined = true;
    expect(assertLocalEmbeddingRuntime(false)).toBe('offline-sandbox');
  });

  it.each([
    ['missing boot plan', () => { state.plan = undefined; }],
    ['unverified home privacy', () => { state.homeVerified = false; }],
    ['pending plan', () => { state.plan = { selectedBackend: 'none', readiness: 'checking', reason: 'checking' }; }],
    ['rejected plan', () => { state.plan = { selectedBackend: 'none', readiness: 'rejected', reason: 'request-rejected' }; }],
    ['readiness deadline', () => { state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'readiness-deadline' }; }],
    ['unproved runtime root', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'runtime-root-unproved' }, srtWinReady: false }; }],
    ['installed account backend', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'container-unavailable' }, srtWinReady: true }; }],
    ['inconclusive container probe', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'probe-failed' }, srtWinReady: false }; }],
  ] as const)('refuses the host route with %s', (_name, configure) => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    configure();
    expect(() => assertLocalEmbeddingRuntime()).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });
});
