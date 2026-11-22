import { duplexPair } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { serveInferenceChild } from '../inference-child-serve.js';

const { accept } = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock('../../../plugins/isolation/child-loopback-link.js', () => ({
  parseChildLaunchArgs: () => ({ transport: 'loopback', env: {} }),
  acceptHostOverLoopback: accept,
}));
vi.mock('../../../shared/tool-timeout-policy.js', () => ({
  TOOL_TIMEOUT_POLICY: { windowsInferenceChildAcceptMs: 123, windowsInferenceChildHandshakeMs: 45 },
}));
vi.mock('../model-manifest.js', () => ({ MODEL_FILES: [{ bytes: 2 }, { bytes: 3 }, { bytes: 4 }] }));

function connectFixture() {
  const [child, host] = duplexPair();
  accept.mockResolvedValueOnce(child);
  const replies: unknown[] = [];
  host.on('data', (chunk: Buffer) => { replies.push(JSON.parse(chunk.toString('utf8')) as unknown); });
  return { host, replies };
}

function prefix(lengths: number[]): Buffer {
  const bytes = Buffer.alloc(16);
  for (const [index, length] of lengths.entries()) bytes.writeUInt32BE(length, index * 4);
  return bytes;
}

it('takes the child loopback deadlines from the transport policy', async () => {
  const refused = new Error('loopback refused by fixture');
  accept.mockRejectedValue(refused);
  await expect(serveInferenceChild(vi.fn())).rejects.toBe(refused);
  expect(accept).toHaveBeenCalledWith({
    announce: expect.any(Function), acceptTimeoutMs: 123, handshakeTimeoutMs: 45,
  });
});

it.each([
  { lengths: [32 * 1024 * 1024 + 1, 2, 3, 4], error: 'invalid-input' },
  { lengths: [32, 2, 3, 0xffff_ffff], error: 'model-integrity-failed' },
])('refuses a $error frame from its split prefix before reading or allocating the payload', async ({ lengths, error }) => {
  const { host, replies } = connectFixture();
  const handle = vi.fn();
  const alloc = vi.spyOn(Buffer, 'allocUnsafe');
  try {
    const run = serveInferenceChild(handle);
    const head = prefix(lengths);
    host.write(head.subarray(0, 11));
    host.write(head.subarray(11));
    await setImmediate();
    const repliesBeforeEnd = replies.slice();
    host.end();
    await run;
    expect(repliesBeforeEnd).toEqual([{ kind: 'error', error }]);
    expect(handle).not.toHaveBeenCalled();
    expect(alloc.mock.calls.some(([bytes]) => bytes >= lengths.reduce((sum, length) => sum + length, 0))).toBe(false);
  } finally { alloc.mockRestore(); host.destroy(); }
});

it('dispatches one complete request across split prefix and payload writes', async () => {
  const { host, replies } = connectFixture();
  const task = { kind: 'embed', text: '한글' };
  const json = Buffer.from(JSON.stringify(task));
  const model = Buffer.from('ab');
  const tokenizer = Buffer.from('cde');
  const tokenizerConfig = Buffer.from('fghi');
  const head = prefix([json.length, model.length, tokenizer.length, tokenizerConfig.length]);
  const handle = vi.fn(async () => 'embedded');
  try {
    const run = serveInferenceChild(handle);
    host.write(head.subarray(0, 4));
    host.write(Buffer.concat([head.subarray(4), json.subarray(0, 7)]));
    await setImmediate();
    expect(handle).not.toHaveBeenCalled();
    host.write(Buffer.concat([json.subarray(7), model, tokenizer, tokenizerConfig]));
    await run;
    expect(handle).toHaveBeenCalledExactlyOnceWith(task, { model, tokenizer, tokenizerConfig }, expect.any(Function));
    expect(replies).toEqual([{ kind: 'result', value: 'embedded' }]);
  } finally { host.destroy(); }
});
