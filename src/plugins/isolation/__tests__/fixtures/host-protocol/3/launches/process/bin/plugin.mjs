#!/usr/bin/env node
/**
 * The program a `process` manifest names. A real one speaks the host protocol
 * on its own stdio; this one is a module the reference runtime loads, so the
 * golden test can answer construct on in-memory streams and pin the frame the
 * host sends for a process launch.
 */
export const createPlugin = async () => ({
  handlers: {
    report_launch: async () => ({ launched: true }),
  },
});
