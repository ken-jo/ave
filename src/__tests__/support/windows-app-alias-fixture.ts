import { win32 } from "node:path";

export function windowsAppAliasFixture() {
  const local = "C:\\Users\\alice\\AppData\\Local";
  const aliases = win32.join(local, "Microsoft", "WindowsApps");
  const short = "C:\\Users\\alice\\AppData\\Local\\MICROS~1\\WINDOW~1";
  const outsideLocal = "C:\\outside";
  const outside = win32.join(outsideLocal, "Microsoft", "WindowsApps");
  const program = "example-alias";
  const executable = win32.join(aliases, `${program}.exe`);
  const key = (path: string) => win32.normalize(path).replace(/\\$/u, "").toLowerCase();
  const root = { canonical: aliases, dev: 1n, ino: 2n };
  const regularFiles = new Set<string>();
  const fs = {
    windowsApps: root,
    pinWindowsDirectory: (path: string) => [key(aliases), key(short)].includes(key(path)) ? root : null,
    statSync: (path: string) => {
      if (!regularFiles.has(path)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return { isFile: () => true };
    },
    lstatSync: (path: string) => ({ isSymbolicLink: () => win32.basename(path) === `${program}.exe` }),
    accessSync: () => undefined,
  };
  return { local, aliases, short, outsideLocal, outside, program, executable, root, regularFiles, fs };
}
