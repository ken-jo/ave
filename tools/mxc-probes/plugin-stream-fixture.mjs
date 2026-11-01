import { writeSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

// Deliberately bypass the child writer only for negative controls.
export const createPlugin = async (context) => {
  let seen = null;
  return { handlers: {
    subscribe: async () => { context.hostApi.config.onChange("value", (value) => { seen = value; }); return true; },
    read: async () => ({ seen, bytes: "한".repeat(256 * 1024) }),
    forge: async () => {
      const reply = new Promise((resolve, reject) => {
        let pending = "";
        const receive = (chunk) => {
          pending += chunk.toString("utf8");
          if (pending.length > 65536) { process.stdin.off("data", receive); reject(new Error("Forged reply exceeds bound")); return; }
          while (pending.includes("\n")) {
            const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
            const frame = JSON.parse(line);
            if (frame.id === "forged-native-owner") { process.stdin.off("data", receive); resolve(frame.error?.data?.code); }
          }
        };
        process.stdin.on("data", receive);
      });
      writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: "forged-native-owner", method: "ave/host/raiseAlert",
        params: { input: { kind: "reply", key: "probe" }, pluginId: "foreign-owner", generationId: "foreign-generation", _meta: { "ave/invocation": "never-issued" } } }) + "\n");
      return await reply;
    },
    overflow: async () => {
      const chunk = Buffer.alloc(32768, 0x78);
      for (let written = 0; written < 64 * 1024 * 1024;) {
        try { written += writeSync(1, chunk); }
        catch (error) { if (error.code !== "EAGAIN") throw error; }
        await nextTurn();
      }
      return null;
    },
  } };
};
