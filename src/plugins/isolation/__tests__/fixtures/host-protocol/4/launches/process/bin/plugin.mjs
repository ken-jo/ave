#!/usr/bin/env node
/** A process-entry module for the reference runtime; it pins construct frames over in-memory streams. */
export const createPlugin = async () => ({
  handlers: {
    report_launch: async () => ({ launched: true }),
  },
});
