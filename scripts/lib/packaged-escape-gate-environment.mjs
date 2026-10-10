/**
 * The environment the packaged escape gate hands the packaged executable
 * (`scripts/packaged-escape-gate.mjs`; `plugin-hostapi-protocol.md` §9.8 A2,
 * Gates (ii)).
 *
 * An allow-list of the gate's own. The host's environment is not passed
 * through: whatever the CI runner or a developer's shell carries — tokens,
 * `NODE_OPTIONS`, a stray `ELECTRON_RUN_AS_NODE` — would otherwise decide
 * what the measurement measures. What remains is what a process needs to
 * start and to find a display: the executable search path, the user and
 * locale, the temporary directories, the Windows system variables, and the
 * X11, Wayland, XDG and D-Bus variables the Linux control runs under.
 *
 * `ELECTRON_RUN_AS_NODE` is never on the list: each half of the gate sets it
 * itself, to `1` for the probes and not at all for the control. Nothing here
 * establishes a profile either; the gate points `HOME`, `AVE_HOME` and
 * `--user-data-dir` at its own scratch directory.
 */
const PACKAGED_ESCAPE_GATE_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
  "TMPDIR", "TEMP", "TMP", "USERPROFILE", "SystemRoot", "WINDIR",
  "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
]);

/** The allow-listed variables `source` carries as strings, and nothing else. */
export function packagedEscapeGateEnvironment(source = process.env) {
  return Object.fromEntries(PACKAGED_ESCAPE_GATE_ENV_KEYS
    .filter((key) => typeof source[key] === "string")
    .map((key) => [key, source[key]]));
}
