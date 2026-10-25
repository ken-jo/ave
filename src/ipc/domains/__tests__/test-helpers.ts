import { HOST_FRAME_URL, hostFrameEvent } from "../../../__tests__/test-helpers.js";

export function invokeAppIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn(
      { ...hostFrameEvent(), frameId: 0, processId: 0, frame: { url: HOST_FRAME_URL } } as never,
      ...args,
    ),
  );
}

export function makeAppIpcInvoker(
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  return (channel: string, ...args: unknown[]): Promise<unknown> =>
    invokeAppIpcHandler(handlers, channel, ...args);
}

// Vary sender URLs while preserving the shared invoker's event shape.
export function invokeAppIpcHandlerFromFrame(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  url: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(fn({ senderFrame: { url } } as never, ...args));
}

export function makeAppIpcFrameInvoker(
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  return (channel: string, url: string, ...args: unknown[]): Promise<unknown> =>
    invokeAppIpcHandlerFromFrame(handlers, channel, url, ...args);
}

export function invokeFileIpcHandler(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return Promise.resolve(
    fn({ ...hostFrameEvent(), frameId: 0, processId: 0 } as never, ...args),
  );
}
