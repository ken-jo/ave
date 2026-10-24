/**
 * A promise plus the handle that settles it, for a test that must observe work
 * mid-flight — start the call, assert on the state it is now in, then resolve.
 *
 * Three suites wrote this out; the only thing that differed between them was the
 * name of the executor's parameter. `Promise.withResolvers` is the same object,
 * but it is ES2024 and this tree compiles against `lib: ES2023`.
 *
 * A leaf module: renderer suites import it without loading the main-process
 * modules test-helpers.ts pulls in (its session store loads pino, whose exit
 * hooks outlive a renderer file's VM context).
 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
