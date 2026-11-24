import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOST_PLATFORM = process.platform;

// Synchronous so callers that mock the promise file API can still use these fixtures.
const removeFixture = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

export interface PlantedProgram {
  /** The folder holding the planted program; also the process cwd while planted. */
  readonly dir: string;
  /** PATH with empty, "." and relative entries and one empty fully qualified folder. */
  readonly path: string;
  /** POSIX: whether the planted script ran. Windows images leave no marker; assert on the site's outcome. */
  ran(): boolean;
}

interface Planting {
  separator: string;
  plant(dir: string, name: string, marker: string): void;
}

const POSIX_PLANTING: Planting = {
  separator: ":",
  plant(dir, name, marker) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho planted > '${marker}'\necho planted\n`);
    chmodSync(join(dir, name), 0o755);
  },
};

export async function withPlantedProgram<T>(
  names: readonly string[],
  use: (planted: PlantedProgram) => Promise<T> | T,
  { separator, plant }: Planting = POSIX_PLANTING,
): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-planted-program-")));
  const dir = join(root, "cwd");
  const empty = join(root, "empty");
  const marker = join(root, "ran");
  const path = ["", ".", join("..", "cwd"), empty].join(separator);
  const cwd = process.cwd();
  const previousPath = process.env.PATH;
  try {
    mkdirSync(dir);
    mkdirSync(empty);
    for (const name of names) plant(dir, name, marker);
    process.env.PATH = path;
    process.chdir(dir);
    return await use({ dir, path, ran: () => existsSync(marker) });
  } finally {
    process.chdir(cwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    removeFixture(root);
  }
}

export interface ProgramsOnPath {
  readonly dir: string;
  /** The absolute path a bare name resolves to. */
  program(name: string): string;
  restore(): Promise<void>;
}

/** Stub programs in a fully qualified folder prepended to PATH, for tests whose spawn is faked but whose program name must still resolve. */
export function installProgramsOnPath(names: readonly string[], platform = process.platform): ProgramsOnPath {
  const windows = platform === "win32";
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ave-programs-on-path-")));
  // A simulated POSIX lookup on Windows uses a root-relative path on the test drive.
  const dir = !windows && HOST_PLATFORM === "win32" ? fixture.replace(/^[A-Za-z]:/u, "").replaceAll("\\", "/") : fixture;
  const imageName = (name: string) => windows && !/\.(?:com|exe)$/iu.test(name) ? `${name}.exe` : name;
  for (const name of names) {
    const path = join(fixture, imageName(name));
    writeFileSync(path, windows ? "" : "#!/bin/sh\nexit 0\n");
    if (!windows) chmodSync(path, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = [dir, previousPath].filter(Boolean).join(windows ? ";" : ":");
  return {
    dir,
    program: (name) => windows ? join(dir, imageName(name)) : `${dir}/${name}`,
    async restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      removeFixture(fixture);
    },
  };
}
