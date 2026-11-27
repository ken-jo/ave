import { promises as dns, type LookupAddress } from 'node:dns';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { getCACertificates } from 'node:tls';
import { classifyAddress, fetchAddressCheckedResponse, NetworkGuardError } from '../../core/network-guard.js';
import { raceWithAbort } from '../../shared/abortable-deadline.js';
import { REDIRECT_STATUSES } from '../host-fetch-guard.js';
import { modelFileUrl } from './model-manifest.js';
import { MemoryModelError } from './model-manager-win32.js';

let trustedCertificates: string[] | undefined;

function requestArtifact(
  url: URL,
  addresses: LookupAddress[],
  signal: AbortSignal,
  assertStillValid: () => void,
): Promise<Response> {
  const first = addresses[0];
  if (!first) throw new MemoryModelError('model-download-failed');
  trustedCertificates ??= [...getCACertificates('default'), ...getCACertificates('system')];
  signal.throwIfAborted();
  assertStillValid();
  return new Promise((resolve, reject) => {
    const request = requestHttps(url, {
      agent: false,
      signal,
      ca: trustedCertificates,
      rejectUnauthorized: true,
      lookup: (_hostname, options, done) => {
        if (options.all) done(null, addresses);
        else done(null, first.address, first.family);
      },
    }, incoming => {
      try {
        const status = incoming.statusCode ?? 0;
        const headers = new Headers();
        for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
          const name = incoming.rawHeaders[index];
          const value = incoming.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const hasBody = status >= 200 && status < 300 && status !== 204 && status !== 205;
        if (!hasBody) incoming.destroy();
        const body = hasBody ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null;
        resolve(new Response(body, { status, headers }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.once('socket', socket => {
      socket.once('secureConnect', () => {
        try {
          signal.throwIfAborted();
          assertStillValid();
          request.end();
        } catch (error) {
          request.destroy(error instanceof Error ? error : new MemoryModelError('model-download-failed'));
        }
      });
    });
  });
}

export function downloadModelFile(
  name: string,
  signal: AbortSignal,
  assertStillValid: () => void,
): Promise<Response> {
  return fetchAddressCheckedResponse(modelFileUrl(name), {
    signal,
    addressPolicy: address => classifyAddress(address) === 'public'
      ? 'allow'
      : new NetworkGuardError('Model download requires a public address', { fatal: true }),
    fetchImpl: async (input, init, select) => {
      const url = new URL(input);
      if (url.protocol !== 'https:') throw new MemoryModelError('model-download-failed');
      // Preserve the operation signal after the per-hop header timer is cleared.
      const requestSignal = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      requestSignal.throwIfAborted();
      const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      const family = isIP(host);
      const answers = family
        ? [{ address: host, family }]
        : await raceWithAbort(dns.lookup(host, { all: true }), requestSignal);
      const approved = new Set(select(answers.map(answer => answer.address)));
      const response = await requestArtifact(url, answers.filter(answer => approved.has(answer.address)), requestSignal, assertStillValid);
      if (response.status >= 300 && response.status < 400 && !REDIRECT_STATUSES.has(response.status)) {
        throw new MemoryModelError('model-download-failed');
      }
      return response;
    },
  });
}
