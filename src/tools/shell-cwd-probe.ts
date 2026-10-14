import { randomBytes } from "node:crypto";

/**
 * Working-directory probe for one foreground shell command.
 *
 * Each foreground `bash` process is fresh, so a `cd` would otherwise be lost
 * when the call returns. The host prefixes the command with a fixed EXIT trap
 * that reports the shell's final `$PWD` on stderr between two delimiters that
 * carry a per-invocation random nonce. The trap runs on normal completion,
 * `exit`, and `set -e` failures, preserves the command's exit status, and is
 * placed on the same line as the command so line numbers in shell diagnostics
 * stay unchanged. When the shell never reaches the trap (it was replaced with
 * `exec`, killed, or the command installed its own EXIT trap) no report
 * arrives and the caller keeps its previous directory.
 *
 * Commands that cannot change directory run unwrapped (see
 * {@link createShellCwdProbe}).
 *
 * The prefix is host-authored text: only the nonce varies, and it is hex. The
 * command text that permission, path, and approval checks bind to is not
 * changed; only the argv handed to the shell interpreter carries the prefix.
 */
export interface ShellCwdProbe {
  /** Prefix-wrapped script for the interpreter's `-c` argument. */
  readonly script: string;
  readonly start: string;
  readonly end: string;
}

/**
 * A shell's directory changes only through `cd`, `pushd`, or `popd`; path
 * policy refuses sourcing and dynamic command names before spawn. A command
 * whose text never names one of them keeps its unwrapped argv, so the shell
 * may still replace itself with a final simple command and report a child's
 * own signal directly. A false match (for example `echo cd`) only adds the
 * probe.
 */
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

/**
 * Removes probe reports from a stderr byte stream before the bytes reach the
 * bounded display buffer, the output artifact, or live progress. Bytes that
 * might begin a report are held until they can be classified.
 *
 * Every complete report is removed, and the last one is adopted: the EXIT
 * trap runs after the command, so a report the command printed itself (it can
 * read the nonce with `trap -p`) comes earlier and is superseded. Whatever is
 * adopted is still clamped to the allowed scope by the caller.
 */
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

  /** The `$PWD` of the last complete report, or undefined when none arrived. */
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
          // Too long to be a report: ordinary output from here on.
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

  /** Release held bytes that never became a complete report. */
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
