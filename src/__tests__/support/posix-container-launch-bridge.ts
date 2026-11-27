// A `vi.mock` factory for `src/tools/mxc-posix-shell-launch.ts` in suites that drive a sandboxed POSIX shell through a
// `child_process.spawn` double. Every POSIX host shell that runs sandboxed runs in its container. This bridge starts
// the container's supervisor through `child_process.spawn`, so the suite's own double supplies the child. The
// supervisor outcome follows that child's close, the way `startMxcLinuxShell` reports it. A synchronous spawn failure
// throws from `start`, as a supervisor that failed to start does.
//
// Usage: `vi.mock("../mxc-posix-shell-launch.js", () => bridgedPosixContainerLaunch());`

export const BRIDGED_CONTAINER_LAUNCHER = "/bridged/container-launcher";

export async function bridgedPosixContainerLaunch() {
  const childProcess = await import("node:child_process");
  return {
    async prepareMxcPosixShellLaunch(
      input: { readonly commandLine: string; readonly cwd: string; readonly env: Readonly<Record<string, string>> },
      lifecycle: import("../../tools/contained-shell-lifecycle.js").ContainedShellLifecycle,
    ) {
      lifecycle.signal.throwIfAborted();
      return {
        carvedReadLimitedAt: undefined, proxyPort: 1, narrowedWriteRoots: [],
        start() {
          const child = childProcess.spawn(BRIDGED_CONTAINER_LAUNCHER, ["--config", "request.json"], { cwd: input.cwd, env: { ...input.env } });
          // As the real supervisor: a child error is a refused start, decided when the child closes.
          let launchError = false;
          child.on("error", () => { launchError = true; });
          const completion = new Promise<{
            code: number; timedOut: boolean; cancelled: boolean; rejected: boolean; cleanupUnverified: boolean;
          }>((resolve) => {
            child.once("close", (code: number | null) => {
              const cancelled = lifecycle.signal.aborted;
              resolve({ code: code ?? -1, timedOut: false, cancelled, rejected: !cancelled && launchError, cleanupUnverified: false });
            });
          });
          lifecycle.jobStarted(completion);
          return { child, completion };
        },
      };
    },
  };
}
