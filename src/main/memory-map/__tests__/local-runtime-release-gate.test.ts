import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRepository } from '../../../memory/session-repository.js';
import { deferred } from '../../../__tests__/support/deferred.js';
import { setProcessPlatform } from '../../../__tests__/support/process-platform.js';
import { createTmpDirTracker } from '../../../__tests__/support/tmp-dir-teardown.js';
import { registerMxcReleaseGateEvidence } from '../../../permissions/mxc-extension-admission.js';
import { refreshWindowsBackgroundAdmission, sessionSearchIndexPolicySource } from '../../../permissions/windows-background-features.js';
import { invalidateWindowsBackendEvidence } from '../../../permissions/windows-confinement-evidence.js';
import type { SandboxWindowsExtensionPlan, SandboxWindowsSubstrateInfo } from '../../../shared/sandbox-capability-info.js';
import { assertLocalEmbeddingRuntime, refreshLocalInferenceAdmission } from '../local-runtime.js';

const NO_ACCOUNT = { errors: [] as string[], warnings: [] as string[], accountBackendAbsent: true as const };
const NO_CONTAINER = { state: 'unavailable', reason: 'container-unavailable', windowsBuild: null, detail: '', baseContainerApiPresent: false, containerBackendAbsent: true };
const state = vi.hoisted(() => ({
  accountHelperIdentity: 'account-helper-1', confined: false, homeVerified: true, verifiedShell: { confidence: 'verified' },
  accountOperational: vi.fn(async () => true), accountInventory: vi.fn(async (): Promise<object> => ({})),
  containerInventory: vi.fn(async (): Promise<object> => ({})), containerStart: vi.fn(async (): Promise<object> => ({})),
  plan: undefined as Pick<SandboxWindowsExtensionPlan, 'selectedBackend' | 'readiness' | 'reason'> | undefined,
  substrate: undefined as Pick<SandboxWindowsSubstrateInfo, 'mxc' | 'srtWinReady' | 'accountBackendAbsent' | 'shells'> | undefined,
}));
vi.mock('../../../permissions/asrt-sandbox.js', () => ({
  isWindowsBackgroundConfinementRuntimeActive: () => state.confined || state.substrate?.shells === 'mxc',
  isOfflineProcessConfinementActive: () => state.confined,
  isWindowsAccountConfinementOperational: async () => state.confined && await state.accountOperational(),
  checkAsrtDependencies: state.accountInventory,
  getWindowsConfinementRoute: () => [state.confined],
  getWindowsAccountConfinementHelperIdentity: () => state.accountHelperIdentity,
}));
vi.mock('../../../permissions/mxc-windows.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../permissions/mxc-windows.js')>(),
  getHostWxcExecIdentity: () => 'C:/example/resources/wxc-exec.exe',
  resolveHostWxcExecPath: async () => 'C:/example/resources/wxc-exec.exe',
  detectHostMxcPrerequisites: state.containerInventory,
  probeHostMxcPowerShellStart: state.containerStart,
}));
vi.mock('../../../permissions/mxc-runtime-root.js', () => ({ mxcSandboxHomesParent: () => 'C:/example/ave-runtime/homes' }));
vi.mock('../../../permissions/sandbox-capability.js', () => ({
  detectMxcShellCapability: () => state.substrate?.shells === 'mxc' ? state.verifiedShell : undefined,
  getSandboxGeneration: () => "0",
  getSandboxHomesUnavailable: () => false,
  getWindowsExtensionBackendPlan: () => state.plan,
  getWindowsSandboxSubstrate: () => state.substrate,
  isSandboxGateUndecidedAtBoot: () => false,
}));
vi.mock('../../../shared/ave-home.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../shared/ave-home.js')>(),
  isAveHomePrivacyVerifiedAtBoot: () => state.homeVerified,
}));

const HOST_PLATFORM = process.platform;
const indexDirs = createTmpDirTracker();
const EVIDENCE = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};
let unregister: (() => void) | undefined;
const policy = async (preference: boolean | undefined) => (await refreshWindowsBackgroundAdmission()).searchIndexPolicy(preference);
const switches = async () => (await refreshWindowsBackgroundAdmission()).areSwitchesAvailable();
const runtime = async (preference?: boolean) => assertLocalEmbeddingRuntime(preference, await refreshLocalInferenceAdmission());
const ACCOUNT_ROUTE = { mxc: { state: 'unavailable', reason: 'container-unavailable' }, srtWinReady: true, shells: 'approved-host' } as const;
const CONTAINER_ROUTE = { mxc: { state: 'available' }, srtWinReady: false, shells: 'mxc' } as const;

beforeEach(() => {
  setProcessPlatform('win32');
  state.accountHelperIdentity = 'account-helper-1';
  state.confined = false;
  state.homeVerified = true;
  state.accountOperational.mockReset().mockResolvedValue(true);
  state.accountInventory.mockReset().mockResolvedValue(NO_ACCOUNT);
  state.containerInventory.mockReset().mockResolvedValue(NO_CONTAINER);
  state.containerStart.mockReset().mockResolvedValue({ state: 'available', windowsBuild: null });
  invalidateWindowsBackendEvidence();
  state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'container-unavailable' };
  state.substrate = { mxc: { state: 'unavailable', reason: 'container-unavailable', containerBackendAbsent: true },
    srtWinReady: false, accountBackendAbsent: true, shells: 'none' };
});
afterEach(async () => {
  unregister?.();
  unregister = undefined;
  setProcessPlatform(HOST_PLATFORM);
  await indexDirs.cleanup();
});

describe('Windows local inference release gate', () => {
  it('preserves refusal without complete packaged evidence', async () => {
    await expect(runtime()).rejects.toEqual(expect.objectContaining({ code: 'local-runtime-unavailable' }));
    unregister = registerMxcReleaseGateEvidence({ ...EVIDENCE, noWorkerPort: false });
    await expect(runtime()).rejects.toEqual(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });

  it('selects the available container regardless of the no-backend preference', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.plan = { selectedBackend: 'mxc', readiness: 'ready', reason: 'ready' };
    state.substrate = CONTAINER_ROUTE;
    expect(await runtime(false)).toBe('mxc');
    expect(await switches()).toBe(false);
  });

  it('defaults to the host child with confirmed backend absence and honours explicit false', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    expect(await runtime()).toBe('unconfined');
    expect(await runtime(true)).toBe('unconfined');
    await expect(runtime(false)).rejects.toEqual(expect.objectContaining({ code: 'local-inference-disabled' }));
    state.plan = { selectedBackend: 'none', readiness: 'off', reason: 'not-requested' };
    expect(await runtime()).toBe('unconfined');
  });

  it('preserves the active offline sandbox independently of the preference', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.confined = true;
    state.substrate = ACCOUNT_ROUTE;
    expect(await runtime(false)).toBe('offline-sandbox');
    expect(await switches()).toBe(false);
  });

  it('keeps session indexing unchanged until complete packaged evidence is registered', async () => {
    expect(await policy(false)).toBe('enabled');
    unregister = registerMxcReleaseGateEvidence({ ...EVIDENCE, noWorkerPort: false });
    expect(await policy(false)).toBe('enabled');
  });

  it('defaults session indexing on and stops it independently of inference on a released PC without a backend', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    expect(await policy(undefined)).toBe('enabled-with-recovery');
    expect(await policy(true)).toBe('enabled-with-recovery');
    expect(await policy(false)).toBe('paused');
    expect(await runtime()).toBe('unconfined');
    state.substrate = { ...CONTAINER_ROUTE, shells: 'none' };
    expect.soft(await policy(false)).toBe('inactive');
    state.substrate = { ...state.substrate, shells: 'mxc' };
    expect(await policy(false)).toBe('enabled-with-recovery');
    setProcessPlatform('linux');
    expect(await policy(false)).toBe('enabled');
  });

  it('accepts definitive boot absence even while the extension release pin is in place', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.plan = { selectedBackend: 'none', readiness: 'unavailable', reason: 'native-validation-required' };
    expect(await switches()).toBe(true);
    expect(await runtime()).toBe('unconfined');
  });

  it('treats a live account runtime contradicting the absence record as inactive', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.confined = true;
    expect(await switches()).toBe(false);
    expect(await policy(false)).toBe('inactive');
    expect(await policy(true)).toBe('inactive');
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
  ] as const)('refuses the host route with %s', async (_name, configure) => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    configure();
    await expect(runtime()).rejects.toEqual(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });

  it.each([
    ['account egress or identity proof', ACCOUNT_ROUTE, () => { state.confined = true; }, () => state.accountOperational.mockResolvedValue(false)],
    ['account proof that cannot be gathered', ACCOUNT_ROUTE, () => { state.confined = true; }, () => state.accountOperational.mockRejectedValue(new Error('helper failed'))],
    ['native container startup', CONTAINER_ROUTE, () => {}, () => state.containerStart.mockResolvedValue({ state: 'unavailable', reason: 'powershell-start-failed' })],
    ['a container start that cannot be attempted', CONTAINER_ROUTE, () => {}, () => state.containerStart.mockRejectedValue(new Error('launcher failed'))],
  ] as const)('stops indexing when a published route loses %s with every boot record intact', async (_name, substrate, start, lose) => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.substrate = substrate;
    start();
    expect(await policy(false)).toBe('enabled-with-recovery');
    lose();
    expect(await policy(false)).toBe('inactive');
    expect(await policy(undefined)).toBe('inactive');
    expect(state.substrate).toBe(substrate);
  });

  it.each([
    ['an account backend that is now present', () => state.accountInventory.mockResolvedValue({ errors: [], warnings: [] })],
    ['an account backend that is now degraded', () => state.accountInventory.mockResolvedValue({ ...NO_ACCOUNT, warnings: ['inventory incomplete'] })],
    ['an account backend that cannot be queried', () => state.accountInventory.mockRejectedValue(new Error('inventory failed'))],
    ['a container backend that is now present', () => state.containerInventory.mockResolvedValue({ state: 'available', windowsBuild: null })],
    ['a container backend that is now degraded', () => state.containerInventory.mockResolvedValue({ ...NO_CONTAINER, baseContainerApiPresent: true })],
    ['a container backend that cannot be queried', () => state.containerInventory.mockRejectedValue(new Error('probe failed'))],
  ] as const)('withdraws the switches, the host route and unconfined indexing after published absence meets %s', async (_name, change) => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    const { plan, substrate } = state;
    expect(await switches()).toBe(true);
    expect(await policy(false)).toBe('paused');
    change();
    expect(await switches()).toBe(false);
    await expect(runtime()).rejects.toEqual(expect.objectContaining({ code: 'local-runtime-unavailable' }));
    expect(await policy(false)).toBe('inactive');
    expect(await policy(undefined)).toBe('inactive');
    expect(state.plan).toBe(plan);
    expect(state.substrate).toBe(substrate);
  });

  it('refuses an admission whose evidence was replaced or invalidated before the decision', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    const earlier = await refreshWindowsBackgroundAdmission();
    expect(earlier.areSwitchesAvailable()).toBe(true);
    await refreshWindowsBackgroundAdmission();
    expect(earlier.areSwitchesAvailable()).toBe(false);
    expect(earlier.searchIndexPolicy(false)).toBe('inactive');

    const current = await refreshWindowsBackgroundAdmission();
    invalidateWindowsBackendEvidence();
    expect(current.areSwitchesAvailable()).toBe(false);
    expect(current.searchIndexPolicy(undefined)).toBe('inactive');
    expect(() => assertLocalEmbeddingRuntime(true, current)).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
  });

  it('never upgrades a pre-release admission or revives one after release evidence replacement', async () => {
    const early = await refreshWindowsBackgroundAdmission();
    expect(early.searchIndexPolicy(true)).toBe('enabled');
    const remove = registerMxcReleaseGateEvidence(EVIDENCE);
    const released = await refreshWindowsBackgroundAdmission();
    expect(released.areSwitchesAvailable()).toBe(true);
    expect.soft(early.areSwitchesAvailable()).toBe(false);
    expect.soft(early.searchIndexPolicy(true)).toBe('inactive');

    remove();
    expect.soft(released.searchIndexPolicy(true)).toBe('inactive');
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    expect.soft(released.areSwitchesAvailable()).toBe(false);
    expect.soft(released.searchIndexPolicy(true)).toBe('inactive');
    expect((await refreshWindowsBackgroundAdmission()).areSwitchesAvailable()).toBe(true);
  });

  it.each([false, true])('keeps each probe receipt when a fast backend changes next to a shared slow backend (first clean: %s)', async firstClean => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    const slow = deferred<object>();
    const rejected = { ...NO_ACCOUNT, warnings: ['inventory incomplete'] };
    state.accountInventory.mockResolvedValueOnce(firstClean ? NO_ACCOUNT : rejected)
      .mockResolvedValueOnce(firstClean ? rejected : NO_ACCOUNT);
    state.containerInventory.mockReturnValue(slow.promise);

    const first = refreshWindowsBackgroundAdmission();
    await new Promise<void>(resolve => setImmediate(resolve));
    const second = refreshWindowsBackgroundAdmission();
    await new Promise<void>(resolve => setImmediate(resolve));
    slow.resolve(NO_CONTAINER);
    const [earlier, later] = await Promise.all([first, second]);
    expect(state.accountInventory).toHaveBeenCalledTimes(2);
    expect(state.containerInventory).toHaveBeenCalledOnce();
    expect.soft(earlier.areSwitchesAvailable()).toBe(false);
    expect.soft(earlier.searchIndexPolicy(true)).toBe('inactive');
    expect.soft(() => assertLocalEmbeddingRuntime(true, earlier)).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
    expect(later.areSwitchesAvailable()).toBe(!firstClean);
  });

  it('revokes a settled admission as soon as its replacement begins', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    const earlier = await refreshWindowsBackgroundAdmission();
    expect(earlier.areSwitchesAvailable()).toBe(true);
    const slow = deferred<object>();
    state.containerInventory.mockReturnValue(slow.promise);
    const replacement = refreshWindowsBackgroundAdmission();
    try {
      expect.soft(earlier.areSwitchesAvailable()).toBe(false);
      expect.soft(earlier.searchIndexPolicy(false)).toBe('inactive');
      expect.soft(() => assertLocalEmbeddingRuntime(true, earlier)).toThrow(expect.objectContaining({ code: 'local-runtime-unavailable' }));
    } finally {
      slow.resolve(NO_CONTAINER);
      await replacement;
    }
    expect((await replacement).areSwitchesAvailable()).toBe(true);
  });

  it('shares one probe between concurrent operations and admits nothing while it is pending or after a loss signal voids it', async () => {
    unregister = registerMxcReleaseGateEvidence(EVIDENCE);
    state.substrate = CONTAINER_ROUTE;
    const start = deferred<object>();
    state.containerStart.mockReturnValue(start.promise);
    const first = refreshWindowsBackgroundAdmission();
    const second = refreshWindowsBackgroundAdmission();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.containerStart).toHaveBeenCalledOnce();
    invalidateWindowsBackendEvidence();
    start.resolve({ state: 'available', windowsBuild: null });
    expect((await first).searchIndexPolicy(undefined)).toBe('inactive');
    expect((await second).searchIndexPolicy(undefined)).toBe('inactive');
    expect(await policy(undefined)).toBe('enabled-with-recovery');
  });
});

it('a late search cannot reuse an earlier batch account receipt', async () => {
  unregister = registerMxcReleaseGateEvidence(EVIDENCE);
  const container = deferred<object>();
  state.containerInventory.mockReturnValue(container.promise);
  const aveDir = indexDirs.track(mkdtempSync(join(tmpdir(), 'ave-index-batch-')));
  const initial = new SessionRepository({ aveDir });
  const sessionId = 'aaaaaaaa-1111-2222-3333-444444444444';
  await initial.saveSession(sessionId, [{ role: 'user', content: 'indexed result' }]);
  initial.closeSearchIndex();
  const repository = new SessionRepository({ aveDir, ...sessionSearchIndexPolicySource(() => true) });
  const bootCheck = repository.verifyOrRebuildSearchIndex();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(state.accountInventory).toHaveBeenCalledTimes(1);
    state.accountInventory.mockResolvedValue({ ...NO_ACCOUNT, warnings: ['late inventory failure'] });
    const search = repository.searchSessionsWithCurrentPolicy('indexed result');
    container.resolve(NO_CONTAINER);
    await bootCheck;
    expect.soft(await search).toEqual([]);
    expect.soft(state.accountInventory).toHaveBeenCalledTimes(2);
    expect((await refreshWindowsBackgroundAdmission()).areSwitchesAvailable()).toBe(false);
  } finally {
    container.resolve(NO_CONTAINER);
    await bootCheck;
    repository.closeSearchIndex();
  }
});

it('revokes an account receipt when its verified helper identity changes', async () => {
  unregister = registerMxcReleaseGateEvidence(EVIDENCE);
  state.confined = true;
  state.substrate = ACCOUNT_ROUTE;
  const admission = await refreshWindowsBackgroundAdmission();
  expect(admission.searchIndexPolicy(true)).toBe('enabled-with-recovery');

  state.accountHelperIdentity = 'account-helper-2';
  expect.soft(admission.searchIndexPolicy(true)).toBe('inactive');
  state.accountHelperIdentity = 'account-helper-1';
  expect(admission.searchIndexPolicy(true)).toBe('inactive');
});
