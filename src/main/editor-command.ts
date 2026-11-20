// The user's "open in editor" command: split into a program and arguments without a shell, with the file and line put in
// as whole arguments, and started detached.
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { splitEditorCommand } from "../shared/editor-command.js";

export type EditorArgv =
  | { ok: true; program: string; args: string[] }
  | { ok: false; error: "not-configured" | "invalid-command" };

/**
 * The program and arguments for opening `file` at `line`. The command is split first and the placeholders are filled in
 * afterwards, so a path with blanks or quotes stays inside the argument that named `{file}` and can never add arguments.
 * A command without `{file}` gets the file as its last argument.
 */
export function buildEditorArgv(command: string, target: { file: string; line: number }): EditorArgv {
  if (command.trim().length === 0) return { ok: false, error: "not-configured" };
  const words = splitEditorCommand(command);
  if (words === null || words.length === 0) return { ok: false, error: "invalid-command" };
  const [program, ...templates] = words as [string, ...string[]];
  // The program is a full path or a bare name looked up in PATH; a relative path would resolve against this process's
  // working folder. It takes no placeholder.
  if (program.includes("{file}") || program.includes("{line}") || (!isAbsolute(program) && /[\\/]/u.test(program))) {
    return { ok: false, error: "invalid-command" };
  }
  // One pass over the template, so a `{line}` that is part of the file's own name is left as it is.
  const fill = (template: string): string =>
    template.replace(/\{(file|line)\}/gu, (_match, name: string) => (name === "file" ? target.file : String(target.line)));
  const args = templates.map(fill);
  if (!templates.some((template) => template.includes("{file}"))) args.push(target.file);
  return { ok: true, program, args };
}

/**
 * The absolute path of the program to start, or null. An absolute path is used as written. A bare name is looked up in the
 * absolute folders of PATH only; a relative path, and a relative or empty PATH entry, are never used, because they would
 * resolve against this process's working folder (the default project, which an agent can write to). On Windows a bare
 * name is tried with `.exe` and `.com`; a `.cmd` or `.bat` launcher needs a shell, which this never starts.
 */
export async function resolveEditorProgram(
  program: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (isAbsolute(program)) return program;
  if (/[\\/]/u.test(program)) return null;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const folders = (pathKey ? env[pathKey] ?? "" : "").split(delimiter).filter((folder) => isAbsolute(folder));
  const names = platform === "win32" && !/\.(?:exe|com)$/iu.test(program) ? [`${program}.exe`, `${program}.com`] : [program];
  for (const folder of folders) {
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        const info = await fs.stat(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not in this folder, or not runnable there: the next PATH folder is tried.
      }
    }
  }
  return null;
}

/** The editor's environment: this process's, without the app's own variables (`AVE_*`, which carry profile locations and
 * test switches) and the runtime's (`ELECTRON_*`, which would make an editor built on the same runtime start as a script
 * host). */
export function editorEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:AVE_|ELECTRON_)/iu.test(name)));
}

/**
 * Start the editor and leave it running on its own. True once the OS has started the program; false when the program
 * could not be found or started. No shell is involved.
 */
export async function launchEditor(program: string, args: readonly string[]): Promise<boolean> {
  const resolved = await resolveEditorProgram(program);
  if (resolved === null) return false;
  return new Promise((resolve) => {
    // The OS reports "could not start" in two ways: most as the child's `error` event, some (a path that runs through a
    // file, a launcher that needs a shell) as a throw from the call itself. Both are the same answer here.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolved, [...args], { detached: true, stdio: "ignore", shell: false, windowsHide: true, env: editorEnvironment() });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
