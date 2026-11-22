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

it('takes the child loopback deadlines from the transport policy', async () => {
  const refused = new Error('loopback refused by fixture');
  accept.mockRejectedValue(refused);
  await expect(serveInferenceChild(vi.fn())).rejects.toBe(refused);
  expect(accept).toHaveBeenCalledWith({
    announce: expect.any(Function), acceptTimeoutMs: 123, handshakeTimeoutMs: 45,
  });
});
