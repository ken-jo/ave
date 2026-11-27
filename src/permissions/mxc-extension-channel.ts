import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { encodeMxcFrame, MxcFrameDecoder, type MxcFrameProtocol, type MxcStreamFrame } from "./mxc-extension-protocol.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { commitUnderAdmission } from "../shared/admission-commit.js";

export type MxcFramePayload = MxcStreamFrame extends infer Frame ? Frame extends MxcStreamFrame ? Omit<Frame, "version" | "generation" | "sequence"> : never : never;

/** A single sequential reader and a bounded, backpressured writer on private inherited pipes. */
export class MxcExtensionChannel {
  private sequence = 0;
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private windowsWriteFailed = false;
  private readonly decoder: MxcFrameDecoder;

  constructor(readonly input: Readable, readonly output: Writable, private readonly generation: string,
    private readonly key: Buffer, private readonly role: "host" | "supervisor", private readonly protocol: MxcFrameProtocol = "shell") {
    this.decoder = new MxcFrameDecoder(generation, key, role === "host" ? "supervisor" : "host", protocol);
  }

  send(payload: MxcFramePayload, admit?: () => void): Promise<void> {
    if (this.pending >= 4 || this.closed || this.output.destroyed) return Promise.reject(new MxcProcessContractError("Supervisor send is not available"));
    if (this.protocol === "windows-extension") return this.sendWindowsExtensionFrame(payload, admit);
    const frame = encodeMxcFrame({ ...payload, version: 1, generation: this.generation, sequence: this.sequence++ } as MxcStreamFrame, this.key, this.role);
    this.pending += 1;
    const sent = this.tail.then(() => new Promise<void>((resolve, reject) => {
      this.output.write(frame, (error) => error ? reject(error) : resolve());
    })).finally(() => { this.pending -= 1; });
    this.tail = sent;
    void sent.catch(() => { this.closed = true; });
    return sent;
  }

  /** A refusal at the write boundary sends nothing and leaves the sequence and channel available. */
  private sendWindowsExtensionFrame(payload: MxcFramePayload, admit: (() => void) | undefined): Promise<void> {
    this.pending += 1;
    const sent = this.tail.then(() => new Promise<void>((resolve, reject) => {
      if (this.windowsWriteFailed) { reject(new MxcProcessContractError("Supervisor send is not available")); return; }
      let writing = false;
      const write = (): void => {
        writing = true;
        const frame = encodeMxcFrame({ ...payload, version: 1, generation: this.generation, sequence: this.sequence++ } as MxcStreamFrame, this.key, this.role, "windows-extension");
        this.output.write(frame, (error) => {
          if (!error) { resolve(); return; }
          this.failWindowsWrite();
          reject(error);
        });
      };
      try {
        if (admit === undefined) write(); else commitUnderAdmission(admit, write);
      } catch (error) {
        if (writing) this.failWindowsWrite();
        reject(error as Error);
      }
    })).finally(() => { this.pending -= 1; });
    this.tail = sent.then(() => {}, () => {});
    return sent;
  }

  private failWindowsWrite(): void {
    this.windowsWriteFailed = true;
    this.closed = true;
  }

  async *frames(): AsyncGenerator<MxcStreamFrame> {
    for await (const chunk of this.input) {
      for (const frame of this.decoder.read(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) yield frame;
    }
    this.decoder.end();
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    const done = finished(this.output, { readable: false, cleanup: true });
    this.output.end();
    await done;
  }
}
