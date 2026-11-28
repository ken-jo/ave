// A `vi.mock` factory for `src/tools/mxc-posix-shell-launch.ts` in suites that drive a sandboxed POSIX shell through a
// `child_process.spawn` double. Every POSIX host shell that runs sandboxed runs in its container. This bridge starts
// the container's supervisor through `child_process.spawn`, so the suite's own double supplies the child. The
// supervisor outcome follows that child's close, the way `startMxcLinuxShell` reports it, and a run still going at the
// request's timeout is stopped and reported timed out, as the launcher's deadline does. A synchronous spawn failure
// throws from `start`, as a supervisor that failed to start does.
//
// Usage: `vi.mock("../mxc-posix-shell-launch.js", () => bridgedPosixContainerLaunch());`

export const BRIDGED_CONTAINER_LAUNCHER = "/bridged/container-launcher";

export async function bridgedPosixContainerLaunch() {
  const childProcess = await import("node:child_process");
  return {
    async prepareMxcPosixShellLaunch(
      input: { readonly commandLine: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
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
          // As the launcher's own deadline: a run still going at the request's timeout is stopped and timed out.
          let timedOut = false;
          const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs);
          const completion = new Promise<{
            code: number; timedOut: boolean; cancelled: boolean; rejected: boolean; cleanupUnverified: boolean;
          }>((resolve) => {
            child.once("close", (code: number | null) => {
              clearTimeout(deadline);
              const cancelled = !timedOut && lifecycle.signal.aborted;
              resolve({ code: code ?? -1, timedOut, cancelled, rejected: !cancelled && !timedOut && launchError, cleanupUnverified: false });
            });
          });
          lifecycle.jobStarted(completion);
          return { child, completion };
        },
      };
    },
  };
}
