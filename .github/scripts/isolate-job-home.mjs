// Points every later step of a CI job at a home and a temp directory under
// RUNNER_TEMP, which the runner empties at the start and end of every job.
//
// On a self-hosted runner the inherited HOME/USERPROFILE and TMPDIR/TEMP/TMP
// are the owner's own profile and temp directory: anything a test, an install
// script or a tool resolves through os.homedir() or os.tmpdir() would land
// there (and through HOME, in the owner's real ~/.ave). AVE_HOME is set too,
// so an inherited value cannot point the tests at the owner's real Ave home.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const runnerTemp = process.env.RUNNER_TEMP;
const githubEnv = process.env.GITHUB_ENV;
if (!runnerTemp || !githubEnv) {
  console.error("isolate-job-home: RUNNER_TEMP and GITHUB_ENV must be set (run this inside a GitHub Actions job)");
  process.exit(1);
}

const home = join(runnerTemp, "home");
const temp = join(runnerTemp, "tmp");
// The confinement tests bind Unix sockets such as `<tmpdir>/srt-mux-<pid>-<n>.sock`,
// and macOS caps a socket path at 104 bytes including its terminator (the
// default /var/folders/…/T/ leaves room). A runner installed under a long path
// fails here, naming the cause, instead of as EINVAL inside the suites.
const SOCKET_NAME_ROOM = 32;
if (process.platform === "darwin" && Buffer.byteLength(temp) + SOCKET_NAME_ROOM > 103) {
  console.error(`isolate-job-home: ${temp} is too long for a Unix socket path under it; install the runner under a shorter directory`);
  process.exit(1);
}
mkdirSync(home, { recursive: true });
mkdirSync(temp, { recursive: true });

const assignments = {
  HOME: home,
  USERPROFILE: home,
  // Set explicitly: a runner service started from the owner's login session
  // could otherwise inherit an AVE_HOME pointing at the owner's real Ave home.
  AVE_HOME: join(home, ".ave"),
  TMPDIR: temp,
  TEMP: temp,
  TMP: temp,
};
appendFileSync(
  githubEnv,
  Object.entries(assignments).map(([name, value]) => `${name}=${value}\n`).join(""),
);
for (const [name, value] of Object.entries(assignments)) console.log(`${name} = ${value}`);
