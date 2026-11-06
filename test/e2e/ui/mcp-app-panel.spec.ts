import { test, expect, type ElectronFixtures } from './fixtures.js';
import { buildLlmSettings } from './seeded-electron.js';
import { admitFixturePlugins } from './admit-fixture-plugins.js';
import type { ElectronApplication, Page } from 'playwright';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type FixtureContext = Pick<ElectronFixtures, 'app' | 'mainWindow' | 'aveHome' | 'userDataDir' | 'tempHome'>;
async function admittedApp(context: FixtureContext) {
  const { app, mainWindow: page } = await admitFixturePlugins(context);
  await page.getByTestId('sidebar-group-plugins').waitFor();
  return { app, page };
}
async function openPanel(app: ElectronApplication, page: Page) {
  await page.getByTestId('sidebar-group-plugins').click();
  await page.getByRole('menuitem', { name: 'View Fixture', exact: true }).click();
  await expect.poll(() => app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
    return guest ? guest.executeJavaScript("document.querySelector('iframe')?.contentDocument?.getElementById('status')?.textContent") : null;
  })).toBe('Standard app ready');
}
async function stageFromPanel(app: ElectronApplication) {
  await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
    if (!guest) throw new Error('App guest not found');
    await guest.executeJavaScript("document.querySelector('iframe').contentDocument.getElementById('draft').click()");
  });
}

async function clickHostTool(page: Page, method: string, payload: unknown) {
  await page.evaluate(({ method, payload }) => {
    const button = document.createElement('button');
    button.dataset.testid = 'fixture-host-tool'; button.textContent = 'Fixture action';
    button.style.cssText = 'position:fixed;top:40px;left:50%;z-index:2147483647';
    button.onclick = async () => {
      try {
        await window.aveApi.callPluginMethod(method, payload, { userAction: true });
        button.dataset.result = 'ok';
      } catch (error) { button.dataset.result = String(error); }
    };
    document.body.append(button);
  }, { method, payload });
  const button = page.getByTestId('fixture-host-tool');
  await button.click();
  await expect(button).toHaveAttribute('data-result', 'ok');
  await button.evaluate((node) => node.remove());
}

test('mounting a dock panel preserves the main renderer theme throughout initialization', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  type ThemeSnapshot = { bundleId: string; shell: string; tokens: Record<string, string> };
  type Probe = {
    phase: string;
    samples: Array<{ phase: string; cache: ThemeSnapshot | null }>;
    sends: Array<{ phase: string; theme: ThemeSnapshot; cache: ThemeSnapshot | null }>;
    timer: ReturnType<typeof setInterval>;
    read: () => ThemeSnapshot | null;
  };
  try {
    // Import the already-loaded cache module, so the measurement observes its live singleton.
    const chunks = resolve('dist/src/main/chunks');
    const cacheModules = readdirSync(chunks).filter((name) => name.endsWith('.js') && readFileSync(resolve(chunks, name), 'utf8').includes('"getLastThemePayload"'));
    expect(cacheModules).toHaveLength(1);
    const cacheModule = pathToFileURL(resolve(chunks, cacheModules[0])).href;
    await page.evaluate(async () => {
      await window.aveApi.updateSettings({ appearance: { mode: 'dark', darkScheme: 'nord' } });
    });
    await expect.poll(() => app.evaluate(async (_, moduleUrl) => {
      const vm = process.getBuiltinModule("node:vm");
      const module = await vm.compileFunction("return import(url)", ["url"], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(moduleUrl);
      const read = Object.values(module).find((value) => typeof value === 'function' && value.name === 'getLastThemePayload') as () => ThemeSnapshot | null;
      return read()?.bundleId;
    }, cacheModule)).toBe('nord');
    await app.evaluate(async ({ app }, moduleUrl) => {
      const vm = process.getBuiltinModule("node:vm");
      const module = await vm.compileFunction("return import(url)", ["url"], { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })(moduleUrl);
      const read = Object.values(module).find((value) => typeof value === 'function' && value.name === 'getLastThemePayload') as () => ThemeSnapshot | null;
      const probe: Probe = { phase: 'before', samples: [], sends: [], read, timer: undefined! };
      const sample = () => probe.samples.push({ phase: probe.phase, cache: read() });
      sample();
      probe.timer = setInterval(sample, 1);
      (globalThis as unknown as { dockThemeProbe: Probe }).dockThemeProbe = probe;
      app.on('web-contents-created', (_, contents) => {
        const send = contents.send.bind(contents);
        contents.send = (channel, ...args) => {
          if (channel === 'ave:dock:theme') probe.sends.push({ phase: probe.phase, theme: args[0].theme, cache: read() });
          send(channel, ...args);
        };
      });
      probe.phase = 'mounting';
    }, cacheModule);
    await clickHostTool(page, 'viewfixture_open_dock', {});
    await expect.poll(() => app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
      return guest?.executeJavaScript("document.querySelector('iframe')?.contentDocument?.getElementById('status')?.textContent");
    })).toBe('Standard app ready');
    const dock = app.windows().find((window) => window.url().includes('floating-dock-window.html'));
    if (!dock) throw new Error('Dock window not found');
    const applied = await dock.evaluate(() => ({ background: document.documentElement.style.getPropertyValue('--dock-bg') }));
    // The card chrome is Tailwind: without the app stylesheet its title and sandbox badge run together as bare text.
    const chrome = await dock.evaluate(() => {
      const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith('/styles.css'));
      const head = document.querySelector('.slot > .slot-head');
      const cardHeader = document.querySelector('.slot .rounded.border > div');
      const style = (node: Element | null) => {
        if (!node) return null;
        const computed = getComputedStyle(node);
        return { display: computed.display, paddingLeft: computed.paddingLeft, paddingTop: computed.paddingTop, borderBottomWidth: computed.borderBottomWidth, backgroundColor: computed.backgroundColor, color: computed.color, appRegion: computed.getPropertyValue('-webkit-app-region') };
      };
      return { stylesheetRules: sheet?.cssRules.length ?? 0, slotHead: style(head), slotTitle: head?.querySelector('.slot-title')?.textContent ?? null, cardHeader: style(cardHeader), cardHeaderText: [...(cardHeader?.children ?? [])].map((child) => child.textContent) };
    });
    expect(chrome.stylesheetRules).toBeGreaterThan(0);
    expect(chrome.slotHead).toMatchObject({ display: 'flex', paddingLeft: '10px', appRegion: 'drag' });
    expect(chrome.cardHeader).toMatchObject({ display: 'flex', borderBottomWidth: '1px' });
    expect(Number.parseFloat(chrome.cardHeader!.paddingLeft)).toBeGreaterThan(0);
    expect(chrome.cardHeaderText).toHaveLength(2);
    const contexts = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
      if (!guest) throw new Error('App guest not found');
      return guest.executeJavaScript("document.querySelector('iframe').contentWindow.fixtureHostContexts");
    });
    const readGuestFont = () => app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('ave-mcp-app://'));
      if (!guest) throw new Error('App guest not found');
      return { id: guest.id, ...await guest.executeJavaScript("(() => { const frame = document.querySelector('iframe'); return { contexts: frame.contentWindow.fixtureHostContexts, font: frame.contentWindow.getComputedStyle(frame.contentDocument.documentElement).getPropertyValue('--font-mono') }; })()") };
    });
    const fontBefore = await readGuestFont();
    const initialFont = fontBefore.font;
    expect(initialFont).toBe(fontBefore.contexts.at(-1).styles.variables['--font-mono']);
    const changedFont = initialFont === 'Changed Dock Mono' ? 'Other Dock Mono' : 'Changed Dock Mono';
    await page.evaluate(async (family) => {
      await window.aveApi.updateSettings({ appearance: { terminalFont: { family } } });
    }, changedFont);
    await expect.poll(async () => (await readGuestFont()).font).toBe(changedFont);
    const fontAfter = await readGuestFont();
    expect(fontAfter.id).toBe(fontBefore.id);
    const evidence = await app.evaluate(() => {
      const probe = (globalThis as unknown as { dockThemeProbe: Probe }).dockThemeProbe;
      probe.phase = 'after';
      probe.samples.push({ phase: probe.phase, cache: probe.read() });
      clearInterval(probe.timer);
      return { samples: probe.samples, sends: probe.sends };
    });
    const evidencePath = testInfo.outputPath('dock-theme-ownership.json');
    writeFileSync(evidencePath, JSON.stringify({ ...evidence, applied, chrome, contexts, fontBefore, fontAfter, aveHome, userDataDir }, null, 2));
    await testInfo.attach('dock-theme-ownership', { path: evidencePath, contentType: 'application/json' });
    expect(new Set(evidence.samples.map((sample) => sample.phase))).toEqual(new Set(['before', 'mounting', 'after']));
    expect(evidence.samples.every((sample) => sample.cache?.bundleId === 'nord')).toBe(true);
    expect(evidence.sends.length).toBeGreaterThan(0);
    expect(evidence.sends.every((send) => send.theme.bundleId === 'nord' && send.cache?.bundleId === 'nord')).toBe(true);
    const tokens = evidence.samples[0].cache!.tokens;
    expect(applied.background).toBe(tokens['--ave-bg']);
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context.theme).toBe('dark');
      expect(context.styles.variables['--color-background-primary']).toBe(tokens['--ave-bg']);
    }
    await dock.screenshot({ path: testInfo.outputPath('dock-nord.png') });
  } finally { await app.close(); }
});

test('sidebar app messages fill the composer without sending a turn', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  try {
    await openPanel(app, page);
    await page.screenshot({ path: testInfo.outputPath('sidebar.png') });
    await stageFromPanel(app);
    await page.getByTestId('pane-close').click();
    await expect(page.locator('textarea').first()).toHaveValue('Review the selected fixture item');
    await expect(page.getByTestId('composer-send-button')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('composer-draft.png') });
    const composer = page.locator('textarea').first();
    await composer.fill(''); await composer.fill('Keep my user draft');
    await page.getByTestId('pane-split').first().click();
    await page.getByTestId('pane-split-row').click();
    await openPanel(app, page);
    await composer.focus();
    await composer.press('End');
    await stageFromPanel(app);
    await expect(page.getByRole('button', { name: 'Replace draft', exact: true })).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await composer.press('Space'); await composer.press('x');
    await expect(composer).toHaveValue('Keep my user draft x');
    await expect(page.getByRole('button', { name: 'Replace draft', exact: true })).toBeVisible();
    const evidence = await composer.evaluate((node) => ({ focused: document.activeElement === node, value: (node as HTMLTextAreaElement).value }));
    writeFileSync(testInfo.outputPath('composer-focus.json'), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: testInfo.outputPath('pending-app-draft.png') });
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(composer).toHaveValue('Keep my user draft x');
    await stageFromPanel(app);
    await page.getByRole('button', { name: 'Replace draft', exact: true }).click();
    await expect(composer).toHaveValue('Review the selected fixture item');
  } finally { await app.close(); }
});

test('an app draft queued during streaming starts its next turn with app provenance', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  let finishInitial: (() => void) | undefined;
  const requestTexts: unknown[] = [];
  const complete = (response: ServerResponse) => {
    for (const [delta, finishReason] of [[{ content: 'Fixture response complete.' }, null], [{}, 'stop']] as const) {
      response.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 0,
        model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages?.findLast((message: { role: string }) => message.role === 'user')?.content;
    const text = Array.isArray(last) ? last.find((part: { type: string }) => part.type === 'text')?.text : last;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    requestTexts.push(text);
    if (text === 'Hold the fixture turn' && !finishInitial) { finishInitial = () => complete(response); response.flushHeaders(); }
    else complete(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  try {
    await expect(page.locator('[data-composer-surface="main"] textarea')).toBeVisible();
    const settings = buildLlmSettings('openai-compatible', 'fixture-model');
    const llm = settings.llm as { vendors: Record<string, { baseUrl?: string }> };
    llm.vendors['openai-compatible'].baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await page.evaluate(async (llm) => {
      await window.aveApi.updateSettings({ llm });
      const events: unknown[] = [];
      (window as unknown as { __appDraftEvents: unknown[] }).__appDraftEvents = events;
      window.aveApi.onChatStream((event) => { if (event.type === 'user_message') events.push(event); });
    }, llm);
    const composer = page.locator('[data-composer-surface="main"] textarea');
    await composer.fill('Hold the fixture turn'); await composer.press('Enter');
    await expect.poll(() => Boolean(finishInitial)).toBe(true);
    await openPanel(app, page); await stageFromPanel(app);
    await page.getByTestId('pane-close').click();
    await expect(composer).toHaveValue('Review the selected fixture item');
    await composer.press('Enter');
    await expect(page.getByTestId('message-queue-row-text')).toHaveText('Review the selected fixture item');
    await page.screenshot({ path: testInfo.outputPath('app-draft-queued.png') });
    finishInitial!();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __appDraftEvents: Array<{ origin?: string }> }).__appDraftEvents
      .some((event) => event.origin === 'app-emitted'))).toBe(true);
    const events = await page.evaluate(() => (window as unknown as { __appDraftEvents: unknown[] }).__appDraftEvents);
    await expect(page.getByText('app:viewfixture', { exact: true }).first()).toBeVisible();
    const evidencePath = testInfo.outputPath('host-resolved-origins.json');
    writeFileSync(evidencePath, JSON.stringify({ events, requestTexts }, null, 2));
    await testInfo.attach('host-resolved-origins', { path: evidencePath, contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('app-emitted-turn.png') });
  } finally {
    await app.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a dock auth identity change remounts its app without app-tool auth denials', async ({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome }, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = await admittedApp({ app: originalApp, mainWindow, aveHome, userDataDir, tempHome });
  const messages: string[] = [];
  app.on('console', (message) => messages.push(message.text()));
  try {
    await clickHostTool(page, 'viewfixture_open_dock', {});
    const guestId = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .find((contents) => contents.getURL().startsWith('ave-mcp-app://'))?.id);
    await expect.poll(guestId).toBeTruthy();
    const before = await guestId();
    await clickHostTool(page, 'viewfixture_set_auth', { authenticated: false });
    await expect.poll(guestId, { timeout: 15_000 }).not.toBe(before);
    await expect.poll(guestId).toBeTruthy();
    expect(messages.join('\n')).not.toContain('MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE');
    expect(messages.join('\n')).not.toContain('tools/call denied or failed');
    const audit = await page.evaluate(() => window.aveApi.audit.search({ textSearch: "MCP_APP_AUTH_TOOL_NOT_APP_CALLABLE", limit: 100 }));
    expect(audit).toMatchObject({ total: 0, entries: [] });
    const dock = app.windows().find((window) => window.url().includes('floating-dock-window.html'));
    if (!dock) throw new Error('Dock window not found');
    await dock.screenshot({ path: testInfo.outputPath('auth-remounted-dock.png') });
    const evidencePath = testInfo.outputPath('dock-auth-lifetime.json');
    writeFileSync(evidencePath, JSON.stringify({ before, after: await guestId(), messages, audit }, null, 2));
    await testInfo.attach('dock-auth-lifetime', { path: evidencePath, contentType: 'application/json' });
  } finally { await app.close(); }
});
