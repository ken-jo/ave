// Imported first by every esbuild entry (scripts/lib/main-entry-points.mjs). On Windows, a lookup that asks
// NeedCurrentDirectoryForExePath before searching the current folder for a program named without one skips that folder while
// this variable is set. A child keeps it only when its environment carries it, which the child-environment allow-lists do. It
// does not replace starting a program by its absolute path.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";
