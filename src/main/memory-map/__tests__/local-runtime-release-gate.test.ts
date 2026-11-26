import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { registerMxcReleaseGateEvidence } from '../../../permissions/mxc-extension-admission.js';
import { sessionSearchIndexPolicy } from '../../../permissions/windows-background-features.js';
import type { SandboxWindowsExtensionPlan, SandboxWindowsSubstrateInfo } from '../../../shared/sandbox-capability-info.js';
import { assertLocalEmbeddingRuntime, isLocalInferenceSwitchAvailable } from '../local-runtime.js';

const state = vi.hoisted(() => ({
  confined: false, homeVerified: true,
  plan: undefined as Pick<SandboxWindowsExtensionPlan, 'selectedBackend' | 'readiness' | 'reason'> | undefined,
  substrate: undefined as Pick<SandboxWindowsSubstrateInfo, 'mxc' | 'srtWinReady' | 'accountBackendAbsent' | 'shells'> | undefined,
}));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({ isOfflineProcessConfinementActive: () => state.confined }));
vi.mock('../../../permissions/sandbox-capability.js', () => ({
  getWindowsExtensionBackendPlan: () => state.plan,
  getWindowsSandboxSubstrate: () => state.substrate,
  isSandboxGateUndecidedAtBoot: () => false,
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
  state.substrate = { mxc: { state: 'unavailable', reason: 'container-unavailable', containerBackendAbsent: true },
    srtWinReady: false, accountBackendAbsent: true, shells: 'none' };
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
    expect(isLocalInferenceSwitchAvailable()).toBe(false);
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
    expect(isLocalInferenceSwitchAvailable()).toBe(false);
  });

  it('keeps session indexing unchanged until complete packaged evidence is registered', () => {
    expect(sessionSearchIndexPolicy(false)).toBe('enabled');
    unregister = registerMxcReleaseGateEvidence({ ...EVIDENCE, noWorkerPort: false });
    expect(sessionSearchIndexPolicy(false)).toBe('enabled');
  });

  it('defaults session indexing on and stops it independently of inference on a released PC without a backend', () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    expect(sessionSearchIndexPolicy(undefined)).toBe('enabled-with-recovery');
    expect(sessionSearchIndexPolicy(true)).toBe('enabled-with-recovery');
    expect(sessionSearchIndexPolicy(false)).toBe('paused');
    expect(assertLocalEmbeddingRuntime()).toBe('unconfined');
    state.substrate = { mxc: { state: 'available' }, srtWinReady: false, shells: 'none' };
    expect.soft(sessionSearchIndexPolicy(false)).toBe('inactive');
    state.substrate = { ...state.substrate, shells: 'mxc' };
    expect(sessionSearchIndexPolicy(false)).toBe('enabled-with-recovery');
    setProcessPlatform('linux');
    expect(sessionSearchIndexPolicy(false)).toBe('enabled');
  });

  it('accepts definitive boot absence even while the extension release pin is in place', () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'native-validation-required' };
    expect(isLocalInferenceSwitchAvailable()).toBe(true);
    expect(assertLocalEmbeddingRuntime()).toBe('unconfined');
  });

  it.each([
    ['missing boot plan', () => { state.plan = undefined; }],
    ['unverified home privacy', () => { state.homeVerified = false; }],
    ['pending plan', () => { state.plan = { selectedBackend: 'none', readiness: 'checking', reason: 'checking' }; }],
    ['rejected plan', () => { state.plan = { selectedBackend: 'none', readiness: 'rejected', reason: 'request-rejected' }; }],
    ['readiness deadline', () => { state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'readiness-deadline' }; }],
    ['unproved runtime root', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'runtime-root-unproved' }, srtWinReady: false, shells: 'none' }; }],
    ['installed account backend', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'container-unavailable' }, srtWinReady: true, shells: 'none' }; }],
    ['inconclusive container probe', () => { state.substrate = { mxc: { state: 'unavailable', reason: 'probe-failed' }, srtWinReady: false, shells: 'none' }; }],
  ] as const)('refuses the host route with %s', (_name, configure) => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    configure();
    expect(() => assertLocalEmbeddingRuntime()).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });
});
