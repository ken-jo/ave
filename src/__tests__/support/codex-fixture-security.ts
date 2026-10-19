import type { ChildProcess, ExecFileOptions, execFile } from "node:child_process";

/** Supply controlled ACL metadata for synthetic artifacts, independent of the host's temp ACLs. */
export function codexFixtureExecFile(original: typeof execFile): typeof execFile {
  return ((...args: unknown[]) => {
    const options = args[2] as ExecFileOptions | undefined;
    const targets = options?.env?.AVE_EXECUTABLE_ACL_PATHS;
    if (targets === undefined) return Reflect.apply(original, undefined, args);
    const currentSid = "S-1-5-21-100-200-300-1001";
    const paths = (JSON.parse(targets) as string[]).map((path) => ({
      path,
      owner: currentSid,
      daclPresent: true,
      entries: [{ sid: currentSid, mask: 0x1f01ff, flags: 0, type: 0 }],
    }));
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, JSON.stringify({ currentSid, paths }), "");
    return {} as ChildProcess;
  }) as typeof execFile;
}
