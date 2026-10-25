// Invoke real permission APIs in the real inner frame; computed allow-lists alone do not prove enforcement.

// Inject only the case label; otherwise keep probe cards identical.
const CASE: string = (window as unknown as { __CASE?: string }).__CASE ?? "unknown";

// Report failures without crashing so every feature produces an outcome.
async function probe(feature: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(`E2E_PROBE ${CASE} ${feature}:ok`);
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    // Preserve error names to distinguish permission denial from missing devices or positioning.
    const reason = `${e?.name ?? "Error"}|${(e?.message ?? String(err)).replace(/\s+/g, " ").slice(0, 160)}`;
    console.log(`E2E_PROBE ${CASE} ${feature}:fail:${reason}`);
  }
}

async function main(): Promise<void> {
  console.log(`E2E_PROBE ${CASE} OPAQUE_ORIGIN:${window.origin === "null"}`);

  // Clipboard writes also require focus; wait for it before interpreting denial.
  await probe("clipboardWrite", async () => {
    if (!navigator.clipboard?.writeText) throw new Error("no navigator.clipboard.writeText");
    window.focus();
    for (let i = 0; i < 40 && !document.hasFocus(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!document.hasFocus()) {
      const unfocused = new Error("could not focus the card; clipboard verdict is unobtainable");
      unfocused.name = "UnfocusedHarness";
      throw unfocused;
    }
    await navigator.clipboard.writeText("ave-mcp-app-probe");
  });

  await probe("camera", async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no navigator.mediaDevices");
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
  });

  await probe("microphone", async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("no navigator.mediaDevices");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  });

  await probe("geolocation", async () => {
    if (!navigator.geolocation) throw new Error("no navigator.geolocation");
    await new Promise<void>((resolve, reject) => {
      // Bound unresolved permission requests so every probe eventually reports.
      const timer = setTimeout(() => reject(new Error("TimedOut|no callback in 8s")), 8_000);
      navigator.geolocation.getCurrentPosition(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          // Normalize geolocation failures because their values are not Error instances.
          const named = new Error(err.message || "geolocation error");
          named.name = `GeolocationPositionError(code=${err.code})`;
          reject(named);
        },
        { timeout: 7_000 },
      );
    });
  });

  console.log(`E2E_PROBE ${CASE} DONE`);
}

void main();
