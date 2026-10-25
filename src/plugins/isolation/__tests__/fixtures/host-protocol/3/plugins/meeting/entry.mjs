/** Record capture, floating panel, worker and secret calls through the real child stub. */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { frames: [], ends: [], detached: [], ffmpeg: [] };
  const held = {};
  return {
    handlers: {
      exercise_host: async () => {
        held.lease = await api.resolveApiKey({ purpose: "stt" });
        held.panel = await api.attachFloatingPanel({ extensionId: "meeting-recorder", height: 240 });
        held.panel.onDetached((reason) => seen.detached.push(reason));
        held.capture = await api.startAudioCapture({
          sampleRate: 16_000,
          frameMs: 200,
          microphone: true,
          systemAudio: false,
        });
        held.capture.onFrame((frame) =>
          seen.frames.push({ seq: frame.seq, peak: frame.peak, pcm: Array.from(frame.pcm) }),
        );
        held.capture.onEnd((end) => seen.ends.push(end));
        held.ffmpeg = await api.spawnWorker({ workerId: "ffmpeg", command: "/usr/local/bin/ffmpeg", args: ["-version"] });
        held.ffmpeg.onStdout((chunk) => seen.ffmpeg.push(chunk));
        const summary = await api.callLlm("summarise the meeting", {
          systemPrompt: "You write meeting notes.",
          maxTokens: 256,
        });
        return {
          lease: { ok: held.lease.ok, vendor: held.lease.vendor },
          panel: { panelId: held.panel.panelId, height: held.panel.height },
          capture: { captureId: held.capture.captureId, opened: held.capture.opened },
          summary,
        };
      },
      report_host: async () => {
        held.lease.release();
        return seen;
      },
    },
  };
};
