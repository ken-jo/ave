import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { setProcessPlatform } from '../../__tests__/support/process-platform.js';
import { cleanupTmpDir } from '../../__tests__/support/tmp-dir-teardown.js';
import * as bootServices from '../../boot/services.js';
import { createIsolatedConversationMemoryManagers } from '../../boot/steps/conversation-wiring.js';
import { MemoryManager } from '../memory-manager.js';
import { SessionRepository } from '../session-repository.js';
import { isIdPrefix, rowIdsOf } from '../session-turn-journal.js';
import { WindowsSessionRepository } from '../session-repository-win32.js';

const platform = process.platform;
let root: string;
afterEach(async () => {
  setProcessPlatform(platform);
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

it('selects the repository for the primary and isolated boot stores at call time', () => {
  root = mkdtempSync(join(tmpdir(), 'boot-session-repository-parity-'));
  vi.stubEnv('AVE_HOME', root);
  const settings = { get: vi.fn() };
  for (const selected of ['win32', 'linux'] as const) {
    setProcessPlatform(selected);
    const createSessionRepository = bootServices.selectBootSessionRepositoryFactory(settings);
    const primary = new MemoryManager({ aveDir: root, createSessionRepository });
    const isolated = createIsolatedConversationMemoryManagers(createSessionRepository);
    const expected = selected === 'win32' ? WindowsSessionRepository : SessionRepository;
    for (const manager of [primary, isolated.sideChatMemoryManager, isolated.subAgentMemoryManager]) {
      expect(manager.sessions.constructor).toBe(expected);
    }
  }
  expect(settings.get).not.toHaveBeenCalled();
});

it('indexes a saved session synchronously and appends without writing repair intent', async () => {
  root = mkdtempSync(join(tmpdir(), 'posix-session-index-'));
  const repository = new SessionRepository({ aveDir: root });
  const session = '7a48ef89-cfe9-4981-afcb-8de6544c5442';
  await repository.saveSession(session, [{ role: 'user', content: 'searchable transcript' }]);
  expect(repository.searchSessions('searchable transcript').map(hit => hit.sessionId)).toEqual([session]);
  const savedIds = rowIdsOf(repository.loadSession(session) ?? []);
  await repository.appendSessionProgress(session, [
    { role: 'user', content: 'searchable transcript' },
    { role: 'assistant', content: 'new response' },
  ]);
  const appendedIds = rowIdsOf(repository.loadSession(session) ?? []);
  assert.ok(savedIds);
  assert.ok(appendedIds);
  expect(appendedIds).toHaveLength(savedIds.length + 1);
  expect(isIdPrefix(savedIds, appendedIds)).toBe(true);
  expect(existsSync(join(root, 'sessions', '.search-repair.json'))).toBe(false);
});
