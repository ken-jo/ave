// Stands in for the inference child behind the real transport: reports the environment it started with and what the network let it reach.
import { connect, type Socket } from 'node:net';
import { serveInferenceChild } from '../../inference-child-serve.js';

const telemetryAtStart = process.env.ORT_DISABLE_TELEMETRY ?? null;

function open(options: { host: string; port: number } | { path: string }): Promise<{ socket?: Socket; code?: string }> {
  return new Promise(resolve => {
    const socket = connect(options);
    const timer = setTimeout(() => { socket.destroy(); resolve({ code: 'TIMEOUT' }); }, 5_000);
    socket.once('connect', () => { clearTimeout(timer); resolve({ socket }); });
    socket.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ code: error.code ?? 'ERROR' }); });
  });
}

async function viaProxy(port: number): Promise<string> {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return 'no-proxy';
  const proxy = new URL(raw);
  const { socket, code } = await open({ host: proxy.hostname, port: Number(proxy.port) });
  if (!socket) return `proxy-unreachable:${code}`;
  const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : '';
  return new Promise(resolve => {
    let head = '';
    const timer = setTimeout(() => { socket.destroy(); resolve('proxy-timeout'); }, 10_000);
    // Read until the proxy closes, so this side never resets the connection.
    socket.on('data', chunk => { head += chunk.toString('latin1'); });
    socket.once('error', () => {});
    socket.once('close', () => { clearTimeout(timer); resolve(head.split('\r\n')[0] || 'proxy-closed'); });
    socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${auth}\r\n`);
  });
}

// The stand-in model bytes are not a model: a parse error proves the native runtime loaded under the sandbox.
async function loadRuntime(model: Uint8Array): Promise<string> {
  let ort: typeof import('onnxruntime-node');
  try { ort = await import('onnxruntime-node'); } catch (error) { return `import-failed:${String(error)}`; }
  return ort.InferenceSession.create(model).then(() => 'session-created', (error: unknown) => `session-refused:${String(error).slice(0, 200)}`);
}

serveInferenceChild(async (task, files) => {
  if (task.kind !== 'embed') throw new Error('probe expects an embed task');
  const { port, unixPath } = JSON.parse(task.text) as { port: number; unixPath?: string };
  const direct = await open({ host: '127.0.0.1', port });
  const unix = unixPath === undefined ? undefined : await open({ path: unixPath });
  unix?.socket?.destroy();
  direct.socket?.destroy();
  return { telemetryAtStart, direct: direct.socket ? 'connected' : direct.code, proxy: await viaProxy(port), unix: unix?.socket ? 'connected' : unix?.code, runtime: await loadRuntime(files.model) };
}).then(() => process.exit(0), () => process.exit(1));
