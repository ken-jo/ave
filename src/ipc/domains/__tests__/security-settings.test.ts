import { requiredFixture } from "../../../__tests__/support/required-fixture.js";
import { EventEmitter } from 'node:events';
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '../../../shared/ipc-channels.js';
import { securitySettingsGestures } from '../../security-settings-gesture.js';
import { USER_GESTURE_LIFETIME_MS } from '../../../shared/chat-origin.js';
import { registerPermissionsHandlers } from '../permissions.js';
import { containsSecuritySettings, SECURITY_FEATURE_KEYS } from '../../../shared/security-settings.js';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }, session: {} }));
vi.mock('../settings.js', () => ({ broadcastSettingsSnapshot: vi.fn(async () => {}), rendererSettingsSnapshot: vi.fn(async (_service: unknown, value: unknown) => value) }));

function setup() {
  const frame = { url: 'file:///Applications/Ave.app/dist/index.html' };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  const window = { webContents: contents, isDestroyed: () => false };
  const previous = { features: { osToolSandbox: true }, system: { localApiServer: false } };
  const settingsService = { getAll: () => previous, patch: vi.fn(async (patch) => patch) };
  const auditLogger = { log: vi.fn(), append: vi.fn(async (_entry: unknown) => {}) };
  registerPermissionsHandlers({ conversationLoop: {}, settingsService, auditLogger, getMainWindow: () => window, getAppWindows: () => [window] } as never);
  securitySettingsGestures.observe(contents as never);
  const event = { sender: contents, senderFrame: frame };
  const call = (patch: unknown, intent = { inputOrigin: 'user-keyboard', userActivation: true }, senderEvent = event) =>
    requiredFixture(handlers.get(PERMISSIONS.updateSecuritySettings))(senderEvent, { patch, intent });
  return { contents, event, settingsService, auditLogger, call };
}

beforeEach(() => handlers.clear());
describe('security settings user consent boundary', () => {
  it('refuses a forged renderer intent without a native main input', async () => {
    const f = setup();
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ ok: false, error: 'user-keyboard-required' });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
    expect(f.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ input: expect.stringContaining('security_settings_refused') }));
  });
  it('consumes the native gesture once and audits before and after values', async () => {
    const f = setup();
    f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    await f.call({ features: { osToolSandbox: false } });
    expect(f.settingsService.patch).toHaveBeenCalledExactlyOnceWith({ features: { osToolSandbox: false } });
    const lastAppend = f.auditLogger.append.mock.lastCall;
    assert.exists(lastAppend, 'Expected a committed audit entry');
    const committed = JSON.parse(String((lastAppend[0] as { input: string }).input));
    expect(committed).toEqual({ action: 'security_settings_changed', phase: 'committed', changes: [{ path: 'features.osToolSandbox', previous: true, value: false }],
      gestureSequence: expect.any(Number), gesturePayloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ ok: false });
  });
  it.each(['blur', 'did-start-navigation', 'destroyed'])('invalidates pending native input after %s', async (name) => {
    const f = setup(); f.contents.emit('before-input-event', {}, { type: 'keyDown', isAutoRepeat: false }); f.contents.emit(name);
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ ok: false });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
  });
  it('refuses a native input older than the gesture lifetime even with an asserted active intent', async () => {
    vi.useFakeTimers();
    try {
      const f = setup(); f.contents.emit('before-input-event', {}, { type: 'keyDown', isAutoRepeat: false });
      vi.advanceTimersByTime(USER_GESTURE_LIFETIME_MS + 1);
      expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ ok: false, error: 'user-keyboard-required' });
      expect(f.settingsService.patch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('refuses native input observed on another web contents', async () => {
    const f = setup();
    const other = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
    securitySettingsGestures.observe(other as never);
    other.emit('before-input-event', {}, { type: 'keyDown', isAutoRepeat: false });
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ ok: false, error: 'user-keyboard-required' });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
  });
  it('spends one native input on one operation, so a second operation from the same input is refused', async () => {
    const f = setup(); f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    expect(await f.call({ features: { osToolSandbox: false } })).not.toMatchObject({ ok: false });
    expect(await f.call({ system: { localApiServer: true } })).toMatchObject({ ok: false, error: 'user-keyboard-required' });
    expect(f.settingsService.patch).toHaveBeenCalledOnce();
  });
  it('requires preload activation and the registered main frame', async () => {
    const f = setup(); f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    expect(await f.call({ features: { osToolSandbox: false } }, { inputOrigin: 'user-keyboard', userActivation: false })).toMatchObject({ ok: false });
    expect(await f.call({ features: { osToolSandbox: false } }, undefined, { ...f.event, senderFrame: { ...f.event.senderFrame } })).toMatchObject({ error: 'unauthorized-frame' });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
  });
  it.each([{ features: { osToolSandbox: 'false' } }, { features: { unrelated: true } }, { pluginConfigs: {} }])('rejects invalid security patches %j', async (patch) => {
    const f = setup(); f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    expect(await f.call(patch)).toMatchObject({ error: 'invalid-security-settings' });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
  });
  it.each(['Audit writer is unavailable', 'Audit writer queue is full', 'Filesystem error'])('refuses mutation when durable audit fails: %s', async (message) => {
    const f = setup(); f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    f.auditLogger.append.mockRejectedValueOnce(new Error(message));
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ error: 'security-settings-audit-unavailable' });
    expect(f.settingsService.patch).not.toHaveBeenCalled();
  });
  it('restores only the changed fields when the final audit append fails', async () => {
    const f = setup(); f.contents.emit('before-mouse-event', {}, { type: 'mouseUp' });
    f.auditLogger.append.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Storage closed'));
    expect(await f.call({ features: { osToolSandbox: false } })).toMatchObject({ error: 'security-settings-audit-unavailable' });
    expect(f.settingsService.patch).toHaveBeenLastCalledWith({ features: { osToolSandbox: true } });
  });
  it('classifies all protected flags for the generic settings refusal', () => {
    for (const key of SECURITY_FEATURE_KEYS) expect(containsSecuritySettings({ features: { [key]: false } })).toBe(true);
    expect(containsSecuritySettings({ system: { localApiServer: false } })).toBe(true);
    expect(containsSecuritySettings({ features: { idleMemoryConsolidation: true } })).toBe(false);
  });
});
