import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { closeSettingsWindow, openSettingsWindow } from './settings-window';

const DEMO_KEY = 'sk-e2e-demo-login-openai';
const STALE_MANUAL_KEY = 'sk-e2e-stale-manual-openai';
const DEMO_BASE_URL = 'https://mock-llm.example/v1';
const DEMO_MODEL = 'gpt-4.1-mini-e2e';
const RESOLVE_DEMO_KEY_TOOL = 'meeting_resolve_demo_key';

async function resolveDemoKey(mainWindow: Page): Promise<unknown> {
  return mainWindow.evaluate(async (toolName) => {
    const api = (window as unknown as { aveApi: { callPluginMethod: (name: string, payload?: unknown) => Promise<unknown> } }).aveApi;
    try {
      return await api.callPluginMethod(toolName, {});
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }, RESOLVE_DEMO_KEY_TOOL);
}

test.use({
  launchEnv: {
    AVE_DEMO_ENABLED: '1',
    AVE_DEMO_VENDOR: 'openai',
    AVE_DEMO_KEY_OPENAI: DEMO_KEY,
    AVE_DEMO_BASEURL_OPENAI: DEMO_BASE_URL,
    AVE_DEMO_MODEL_OPENAI: DEMO_MODEL,
    AVE_E2E_RESOLVE_DEMO_KEY_PROBE: '1',
    AVE_WHITELIST_OFFLINE: '1',
  },
  // This spec asserts the no-key → demo-login key-persistence transition, so it
  // must start without the default seeded LLM key.
  seedApiKey: false,
});

test('LLM tab: demo Login click persists host-managed key and plugin resolveApiKey can read it', async ({
  app,
  mainWindow,
}) => {
  await mainWindow.evaluate(async () => {
    const api = (window as unknown as { aveApi: { updateSettings: (patch: unknown) => Promise<unknown> } }).aveApi;
    await api.updateSettings({ llm: { authMode: 'manual', provider: 'openai' } });
  });

  const settingsWindow = await openSettingsWindow(app, mainWindow, 'llm');

  await expect(settingsWindow.getByLabel('API 키 직접 입력', { exact: true })).toBeChecked();
  await settingsWindow.getByTestId('llm-api-key-input').fill(STALE_MANUAL_KEY);

  await settingsWindow.getByLabel('Login', { exact: true }).check();
  await expect(settingsWindow.getByTestId('llm-tab:manual-section')).toHaveCount(0);

  await settingsWindow.getByTestId('llm-tab:open-login').click();
  await expect(settingsWindow.getByTestId('login-modal')).toBeVisible();
  // Path 2 hotfix: the conversational variant is form-less. The demo chip
  // auto-fires `loginMockup({ username: "demo", password: "demo123" })`,
  // so a single click on `login-modal:chip-demo` replaces the legacy
  // fill+submit dance.
  await settingsWindow.getByTestId('login-modal:chip-demo').click();

  const loginSection = settingsWindow.getByTestId('llm-tab:login-section');
  await expect(settingsWindow.getByTestId('login-modal')).toHaveCount(0);
  await expect(loginSection.getByText('로그인됨')).toBeVisible();
  await expect(loginSection).toContainText('OpenAI');

  await expect
    .poll(
      async () =>
        settingsWindow.evaluate(async () => {
          const api = (window as unknown as { aveApi: { getSettings: () => Promise<any>; hasApiKey: (vendor: string) => Promise<boolean> } }).aveApi;
          const settings = await api.getSettings();
          return {
            authMode: settings.llm.authMode,
            provider: settings.llm.provider,
            model: settings.llm.vendors.openai.model,
            baseUrl: settings.llm.vendors.openai.baseUrl,
            hasOpenAiKey: await api.hasApiKey('openai'),
          };
        }),
      { timeout: 10_000 },
    )
    .toEqual({
      authMode: 'login',
      provider: 'openai',
      model: DEMO_MODEL,
      baseUrl: DEMO_BASE_URL,
      hasOpenAiKey: true,
    });
  await expect(loginSection).toContainText(DEMO_MODEL);

  await expect
    .poll(
      async () => resolveDemoKey(mainWindow),
      { timeout: 15_000 },
    )
    .toEqual({ ok: true, vendor: 'openai', bearer: DEMO_KEY });

  await settingsWindow.getByTestId('llm-tab:save-providers').click();
  await expect
    .poll(
      async () => resolveDemoKey(mainWindow),
      { timeout: 15_000 },
    )
    .toEqual({ ok: true, vendor: 'openai', bearer: DEMO_KEY });

  await closeSettingsWindow(app, settingsWindow);

  const reopened = await openSettingsWindow(app, mainWindow, 'llm');
  await expect(reopened.getByLabel('Login', { exact: true })).toBeChecked();
  await expect(reopened.getByTestId('llm-tab:login-section')).toContainText(DEMO_MODEL);
  await expect(reopened.getByTestId('llm-tab:manual-section')).toHaveCount(0);

  await reopened.getByLabel('API 키 직접 입력', { exact: true }).check();
  await expect(reopened.getByTestId('llm-tab:manual-section')).toBeVisible();
  // The model field is now a <select> (was a free-text input).
  await expect(reopened.getByTestId('llm-model-select')).toBeVisible();
  await expect(reopened.getByTestId('llm-tab:login-section')).toHaveCount(0);

  await closeSettingsWindow(app, reopened);
});
