// Whether the host's own SIGINT/SIGTERM handling runs the quit sequence that releases the sandbox runtime (the headless host). A dependency-free
// module, so the host entry can claim it without loading the sandbox adapter. The runtime registers its signal handlers once, at initialize, so
// the claim must come first.
let owned = false;
let read = false;

export function claimAsrtSignalRelease(): void {
  if (read) throw new Error("claimAsrtSignalRelease: the sandbox runtime has already initialized");
  owned = true;
}

// Read by initializeAsrtSandbox immediately before the runtime initializes; a later claim would not reach it.
export function readAsrtSignalReleaseClaim(): boolean {
  read = true;
  return owned;
}
