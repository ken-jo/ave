// Allow-list launch essentials without inheriting credentials or loader overrides.
// The gate owns process-role flags and scratch profile paths.
const PACKAGED_ESCAPE_GATE_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
  "TMPDIR", "TEMP", "TMP", "USERPROFILE", "SystemRoot", "WINDIR",
  "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
]);

export function packagedEscapeGateEnvironment(source = process.env) {
  return Object.fromEntries(PACKAGED_ESCAPE_GATE_ENV_KEYS
    .filter((key) => typeof source[key] === "string")
    .map((key) => [key, source[key]]));
}
