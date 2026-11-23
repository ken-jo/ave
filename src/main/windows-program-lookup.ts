// Windows otherwise searches the current directory before PATH for a bare program name; children inherit the setting.
if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";

export {};
