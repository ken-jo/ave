import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deferred } from '../../../__tests__/support/deferred.js';
import { LocalModelManager } from '../model-manager.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

it('resolves a held status verification after a newer download starts', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'model-status-parity-'));
  const selected = join(dir, 'selected');
  const bytes = 'weights';
  const filename = 'weights.bin';
  const files = [{ name: filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
  const checking = deferred<void>();
  const releaseVerification = deferred<void>();
  const downloading = deferred<void>();
  const releaseDownload = deferred<Response>();
  await fs.mkdir(selected);
  await fs.writeFile(join(selected, filename), bytes);
  const manager = new LocalModelManager({
    namespace: {
      dir,
      readJson: async (_key, fallback) => fallback,
      writeJson: async () => {},
      childDir: async name => {
        const child = join(dir, name);
        await fs.mkdir(child, { recursive: true });
        return child;
      },
      createFile: name => fs.open(join(dir, name), 'wx'),
    },
    files,
    readPath: () => selected,
    savePath: () => {},
    downloadFile: () => { downloading.resolve(); return releaseDownload.promise; },
    ...{ refreshAdmission: async () => () => {} },
  });
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  vi.mocked(fs.realpath).mockImplementation(async (path, options) => {
    if (path === selected) { checking.resolve(); await releaseVerification.promise; }
    return actual.realpath(path, options);
  });
  try {
    const status = manager.status();
    await checking.promise;
    const download = manager.download();
    await downloading.promise;
    releaseVerification.resolve();
    try {
      await expect(status).resolves.toMatchObject({ status: 'ready' });
    } finally {
      releaseDownload.resolve(new Response(bytes));
      await download;
    }
  } finally {
    vi.mocked(fs.realpath).mockImplementation(actual.realpath);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
