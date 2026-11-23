// Imported first by every host entry, before any other module can start a process. On Windows a program named without a folder is
// looked up in the current folder ahead of PATH unless this variable is set; with it the host, and every process that inherits its
// environment, looks such a name up on PATH alone.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";
