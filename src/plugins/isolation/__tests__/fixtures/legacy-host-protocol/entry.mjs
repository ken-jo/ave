/** Report how each authRedirect member settles on this connection; plugin errors return as values. */
const settled = async (call) => {
  try {
    return { result: await call() };
  } catch (error) {
    return { error: { code: error.code, name: error.name, message: error.message, detail: error.detail } };
  }
};

export const createPlugin = async (context) => {
  const api = context.hostApi;
  return {
    handlers: {
      ping: async () => ({ pong: true }),
      open: async () => await settled(() => api.authRedirect.open()),
      wait: async ({ handle }) => await settled(() => api.authRedirect.wait({ handle, timeoutMs: 5_000 })),
      close: async ({ handle }) => await settled(() => api.authRedirect.close({ handle })),
    },
  };
};
