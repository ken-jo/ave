/** Blocks the calling thread synchronously, starving every timer, like a long spawnSync chain on the main thread. */
export function blockMainThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
