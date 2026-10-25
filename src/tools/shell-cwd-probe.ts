import { randomBytes } from "node:crypto";

// A nonce-tagged EXIT trap reports final cwd while preserving exit status and diagnostic line numbers.
// Only spawned argv gains the host prefix; policy binds original command text, and missing reports retain the prior cwd.
export interface ShellCwdProbe {
  readonly script: string;
  readonly start: string;
  readonly end: string;
}

// Probe only cd/pushd/popd candidates; unwrapped commands retain direct exec and child-signal behavior.
// Path policy already refuses sourcing and dynamic command names; false matches only add a probe.
const DIRECTORY_BUILTIN = /(?:^|[^A-Za-z0-9_.\/-])(?:cd|pushd|popd)(?:$|[^A-Za-z0-9_.\/-])/;

export function createShellCwdProbe(command: string): ShellCwdProbe | undefined {
  if (!DIRECTORY_BUILTIN.test(command)) return undefined;
  const nonce = randomBytes(12).toString("hex");
  // \036 (record separator) keeps the delimiters out of ordinary text output.
  const start = `\x1eave-cwd-${nonce}:`;
  const end = `:${nonce}\x1e`;
  const trap = `trap 'printf "\\036ave-cwd-${nonce}:%s:${nonce}\\036" "$PWD" >&2' EXIT; `;
  return Object.freeze({ script: trap + command, start, end });
}

/** Longest marker body accepted before the report is treated as ordinary output. */
const MAX_REPORTED_PATH_BYTES = 16 * 1024;

// Remove reports before display, artifacts, or progress; buffer possible prefixes until classified.
// Adopt the last complete report so EXIT supersedes command-forged reports; callers still clamp cwd to allowed scope.
export class ShellCwdProbeFilter {
  private readonly start: Buffer;
  private readonly end: Buffer;
  private pending: Buffer = Buffer.alloc(0);
  private reported: string | undefined;
  private flushed = false;

  constructor(probe: Pick<ShellCwdProbe, "start" | "end">) {
    this.start = Buffer.from(probe.start, "utf8");
    this.end = Buffer.from(probe.end, "utf8");
  }

  get reportedCwd(): string | undefined {
    return this.reported;
  }

  push(chunk: Buffer): Buffer {
    if (this.flushed) return chunk;
    let data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const out: Buffer[] = [];
    for (;;) {
      const startIndex = data.indexOf(this.start);
      if (startIndex === -1) {
        const held = this.partialStartSuffixLength(data);
        out.push(data.subarray(0, data.length - held));
        this.pending = Buffer.from(data.subarray(data.length - held));
        break;
      }
      const bodyIndex = startIndex + this.start.length;
      const endIndex = data.indexOf(this.end, bodyIndex);
      if (endIndex === -1) {
        if (data.length - bodyIndex > MAX_REPORTED_PATH_BYTES) {
          out.push(data.subarray(0, bodyIndex));
          data = data.subarray(bodyIndex);
          continue;
        }
        out.push(data.subarray(0, startIndex));
        this.pending = Buffer.from(data.subarray(startIndex));
        break;
      }
      this.reported = data.subarray(bodyIndex, endIndex).toString("utf8");
      out.push(data.subarray(0, startIndex));
      data = data.subarray(endIndex + this.end.length);
    }
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  flush(): Buffer {
    const held = this.pending;
    this.pending = Buffer.alloc(0);
    this.flushed = true;
    return held;
  }

  private partialStartSuffixLength(data: Buffer): number {
    const max = Math.min(this.start.length - 1, data.length);
    for (let length = max; length > 0; length--) {
      if (data.subarray(data.length - length).equals(this.start.subarray(0, length))) return length;
    }
    return 0;
  }
}
