/**
 * A stand-in xterm for renderer tests that mount a terminal without examining its screen. It accepts everything the
 * live terminal asks of xterm and records only what was written. Tests that drive the terminal itself
 * (PtyTerminalView.test.tsx) keep their own richer fake.
 */
const disposable = { dispose() {} };

/** Everything written to any fake terminal, in order. A test that reads it clears it afterwards. */
export const fakeXtermWrites: string[] = [];

export class FakeXterm {
  cols = 80;
  rows = 24;
  options: Record<string, unknown>;
  element: HTMLElement | null = null;
  parser = { registerOscHandler: () => disposable };
  _core = { coreService: { onUserInput: () => disposable } };
  unicode = { activeVersion: "6", register() {} };
  constructor(options: Record<string, unknown> = {}) { this.options = { ...options }; }
  loadAddon() {}
  open(host: HTMLElement) {
    this.element = document.createElement("div");
    host.appendChild(this.element);
  }
  onData() { return disposable; }
  write(text: string) { fakeXtermWrites.push(text); }
  focus() {}
  dispose() {}
  attachCustomKeyEventHandler() {}
  hasSelection() { return false; }
  getSelection() { return ""; }
  clearSelection() {}
  paste() {}
}
