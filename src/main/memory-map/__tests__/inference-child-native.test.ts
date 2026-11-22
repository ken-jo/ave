// The local inference child through the real launch path: it starts with the telemetry opt-out and reaches no listener, directly or through the proxy, that the host reaches in the same run.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectAveHomeFixture, useVerifiedAveHomePrivacy as installVerifiedAveHomePrivacy } from '../../../__tests__/support/ave-home-privacy.js';
import { configureHostResources } from '../../host-resources.js';
import { initializeAsrtSandbox, isAsrtSandboxActive, isOfflineProcessConfinementActive, registerWorkerUnixSocketDir, resetAsrtSandbox } from '../../../permissions/asrt-sandbox.js';
import type { ApprovalDecision, ApprovalRequestInput } from '../../../permissions/approval-gate.js';
import { EGRESS_DENY_REASONS } from '../../../permissions/egress-ask.js';
import { createEgressAskRuntimeCallback, setWorkerEgressAllowlists } from '../../../permissions/egress-runtime.js';
import { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } from '../../../permissions/sandbox-capability.js';
import { buildMainBoundaryBundle, childBundleDir } from '../../../plugins/isolation/__tests__/child-entry-bundle.js';
import { sandboxCasesRun } from '../../../plugins/isolation/__tests__/sandbox-cases.js';
import { MODEL_FILES } from '../model-manifest.js';
import { runMemoryWorker } from '../worker-client.js';

const state = vi.hoisted(() => ({ mainDir: '' }));
vi.mock('../../main-paths.js', () => ({ get mainDir() { return state.mainDir; } }));
// The child never parses the model, so short files stand in for it.
vi.mock('../model-manifest.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../model-manifest.js')>();
  return { ...actual, MODEL_FILES: actual.MODEL_FILES.map(file => ({ ...file, bytes: 32 })) };
});
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, userInfo: vi.fn(original.userInfo) };
});

installVerifiedAveHomePrivacy();

const WRAP_PLATFORM = process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32';
const PROBE_SOURCE = fileURLToPath(new URL('./fixtures/inference-probe-child.ts', import.meta.url));
let previousAveHome: string | undefined;
let root: string | undefined;
let modelDir = '';
let listener: Server | undefined;
let listenerPort = 0;
let unixRoot: string | undefined;
let unixListener: Server | undefined;
let unixPath: string | undefined;
const listenerConnections: string[] = [];

beforeAll(async () => {
  previousAveHome = process.env.AVE_HOME;
  if (previousAveHome === undefined) throw new Error('the test run sets AVE_HOME');
  configureHostResources({ resourcePath: fileURLToPath(new URL('../../../../resources/', import.meta.url)), isPackaged: false });
  root = mkdtempSync(join(previousAveHome, 'mmc-'));
  protectAveHomeFixture(root);
  const aveHome = join(root, '.ave');
  mkdirSync(aveHome, { recursive: true, mode: 0o700 });
  process.env.AVE_HOME = aveHome;
  if (process.platform === 'win32') {
    // A fixture-owned profile keeps the sandbox's deny stamps off the account's real profile.
    vi.stubEnv('USERPROFILE', join(root, 'home'));
    vi.stubEnv('HOME', join(root, 'home'));
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(root, 'home') });
    mkdirSync(join(root, 'home'));
  }
  modelDir = join(root, 'model');
  mkdirSync(modelDir);
  for (const file of MODEL_FILES) writeFileSync(join(modelDir, file.name), Buffer.alloc(file.bytes));
  const outdir = childBundleDir('memory-map-inference-child');
  await buildMainBoundaryBundle({ entryPoints: { 'memory-map-child': PROBE_SOURCE }, outdir, splitting: false });
  renameSync(join(outdir, 'memory-map-child.mjs'), join(outdir, 'memory-map-child.js'));
  state.mainDir = outdir;
  const server = createServer(socket => { listenerConnections.push(socket.remoteAddress ?? 'unknown'); socket.destroy(); });
  listener = server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  listenerPort = (server.address() as { port: number }).port;
  if (process.platform !== 'win32') {
    unixRoot = realpathSync(mkdtempSync(join(tmpdir(), 'mmu-')));
    unixPath = join(unixRoot, 's');
    const socketServer = createServer(socket => socket.destroy());
    unixListener = socketServer;
    await new Promise<void>((resolve, reject) => {
      socketServer.once('error', reject);
      socketServer.listen(unixPath, resolve);
    });
  }
}, 120_000);

afterAll(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
  const server = listener;
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()));
  if (unixListener !== undefined) await new Promise<void>(resolve => unixListener?.close(() => resolve()));
  if (unixRoot !== undefined) rmSync(unixRoot, { recursive: true, force: true });
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  vi.unstubAllEnvs();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

function hostConnect(options: { host: string; port: number } | { path: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(options);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  });
}

describe.runIf(WRAP_PLATFORM)('memory map inference child (native)', () => {
  it('starts with the telemetry opt-out and reaches no listener the host reaches, directly or through the proxy', async context => {
    if (!(await sandboxCasesRun())) context.skip('ASRT cannot initialize (sandbox dependencies missing)');
    // Control: the listener is reachable from this process in this run.
    const beforeControl = listenerConnections.length;
    await hostConnect({ host: '127.0.0.1', port: listenerPort });
    await vi.waitFor(() => expect(listenerConnections.length).toBe(beforeControl + 1));

    // Extension confinement off and the listener's host on the worker allowlist: only the offline owner keeps it out.
    setPluginWorkerConfinementRequestedAtBoot(false);
    setWorkerEgressAllowlists({ byExtension: new Map(), modelEndpointHosts: ['127.0.0.1'] });
    const decisions: unknown[] = [];
    const product = createEgressAskRuntimeCallback({
      approvalGate: { requestAndWait: async (request: ApprovalRequestInput): Promise<ApprovalDecision> => ({ requestId: request.id, choice: 'deny-once' }) },
      shellAskEnabled: () => false,
    });
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: false }, async (params, askContext) => {
      const decision = await product(params, askContext);
      decisions.push(decision);
      return decision;
    });
    expect(isOfflineProcessConfinementActive()).toBe(true);
    if (unixRoot !== undefined && unixPath !== undefined) {
      await hostConnect({ path: unixPath });
      await registerWorkerUnixSocketDir(unixRoot, {});
    }

    const before = listenerConnections.length;
    const report = await runMemoryWorker<{ telemetryAtStart: string | null; direct: string; proxy: string; unix?: string; runtime: string }>(
      modelDir, { kind: 'embed', text: JSON.stringify({ port: listenerPort, unixPath }) }, AbortSignal.timeout(120_000));
    console.info(`[memory-map-child] ${JSON.stringify(report)} decisions=${JSON.stringify(decisions)}`);
    expect(report.telemetryAtStart).toBe('1');
    expect(report.direct, JSON.stringify(report)).not.toBe('connected');
    if (unixPath !== undefined) expect(report.unix).toMatch(/^(?:EACCES|EPERM)$/u);
    expect(report.proxy, JSON.stringify(report)).not.toMatch(/^HTTP\/1\.[01] 200/u);
    expect(listenerConnections.length, 'the listener recorded a connection from the inference child').toBe(before);
    expect(decisions, JSON.stringify(report)).toContainEqual({ allow: false, reason: EGRESS_DENY_REASONS.offline });
    expect(report.runtime, 'the native runtime did not load inside the sandbox').toMatch(/^session-refused:.*protobuf parsing failed/iu);
  }, 180_000);
});
