// Share bypass patterns between staged-source and shipped-output scans.

const TLS_BYPASS_REGEXES = Object.freeze([
  /NODE_TLS_REJECT_[U]NAUTHORIZED/,
  /ignore-certificate-error[s]/,
  /PYTHON[H]TTPSVERIFY/,
  /rejectUnauthorized\s*:\s*false/,
  /strictSSL\s*:\s*false/,
  /verify\s*=\s*False/,
  /ssl\._create_unverified_contex[t]/,
]);

// Derive labels from patterns so literal bypass needles cannot make the scanner match itself.
function labelFor(regex) {
  return regex.source.replace(/\[(.)\]/g, "$1").replace(/\\s\*/g, "").replace(/\\/g, "");
}

/** @type {ReadonlyArray<{ label: string; regex: RegExp }>} */
const TLS_BYPASS_PATTERNS = Object.freeze(
  TLS_BYPASS_REGEXES.map((regex) => Object.freeze({ label: labelFor(regex), regex })),
);

// Exclude documents: recording a bypass in prose does not execute it.
export const TLS_BYPASS_SCAN_EXTENSIONS = Object.freeze([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".ps1", ".cmd",
  ".yml", ".yaml", ".json", ".toml",
]);

export function findTlsBypass(content) {
  return TLS_BYPASS_PATTERNS.filter(({ regex }) => regex.test(content)).map(
    ({ label }) => label,
  );
}

export function isTlsBypassScanTarget(fileName) {
  return TLS_BYPASS_SCAN_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}
