/** The async half of Electron's safeStorage that the A2A stores wrap their data keys with. */
export interface A2AOsEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

const DATA_KEY_BYTES = 32;

export interface DataKeyCodec {
  readonly unavailable: string;
  readonly invalid: string;
  decodeWrapped(value: string): Buffer | null;
  decodeKey(value: string): Buffer | null;
}

interface OpenSession {
  wrappedFor?: string;
  key?: Buffer;
  minted?: { key: Buffer; wrapped: string };
  error?: unknown;
}

/**
 * Async safeStorage cannot run inside a store's synchronous crypto helpers, so each locked operation unwraps the
 * data key once up front and hands out copies; `close` zeroes it when the operation ends. Failures surface on `take`,
 * where the synchronous `dataKey` used to throw them.
 */
export class DataKeySession {
  #current: OpenSession | null = null;

  constructor(
    private readonly encryption: A2AOsEncryption,
    private readonly random: (size: number) => Buffer,
    private readonly codec: DataKeyCodec,
  ) {}

  /** Returns true when the host asked for re-encryption and `state.encryptedDataKey` was rewrapped in memory. */
  async open(state: { encryptedDataKey?: string }): Promise<boolean> {
    this.close();
    const session: OpenSession = {};
    this.#current = session;
    try {
      if (!await this.encryption.isAsyncEncryptionAvailable()) throw new Error(this.codec.unavailable);
      if (!state.encryptedDataKey) {
        const key = this.random(DATA_KEY_BYTES);
        if (key.length !== DATA_KEY_BYTES) throw new Error(this.codec.invalid);
        const wrapped = (await this.encryption.encryptStringAsync(key.toString("base64"))).toString("base64");
        session.minted = { key, wrapped };
        return false;
      }
      const wrapped = this.codec.decodeWrapped(state.encryptedDataKey);
      if (!wrapped) throw new Error(this.codec.invalid);
      const { result, shouldReEncrypt } = await this.encryption.decryptStringAsync(wrapped);
      wrapped.fill(0);
      const key = this.codec.decodeKey(result);
      if (!key || key.length !== DATA_KEY_BYTES) throw new Error(this.codec.invalid);
      session.key = key;
      session.wrappedFor = state.encryptedDataKey;
      if (!shouldReEncrypt) return false;
      const rewrapped = (await this.encryption.encryptStringAsync(key.toString("base64"))).toString("base64");
      state.encryptedDataKey = rewrapped;
      session.wrappedFor = rewrapped;
      return true;
    } catch (error) {
      session.error = error;
      return false;
    }
  }

  /** A copy of the operation's data key; mints into `state` when it has none yet. Callers zero the copy. */
  take(state: { encryptedDataKey?: string }): Buffer {
    const session = this.#current;
    if (!session) throw new Error(this.codec.invalid);
    if (session.error !== undefined) throw session.error;
    if (!state.encryptedDataKey) {
      if (session.minted) {
        session.key = session.minted.key;
        session.wrappedFor = session.minted.wrapped;
        session.minted = undefined;
      }
      if (!session.key || session.wrappedFor === undefined) throw new Error(this.codec.invalid);
      state.encryptedDataKey = session.wrappedFor;
      return Buffer.from(session.key);
    }
    if (!session.key || state.encryptedDataKey !== session.wrappedFor) throw new Error(this.codec.invalid);
    return Buffer.from(session.key);
  }

  close(): void {
    const session = this.#current;
    this.#current = null;
    session?.key?.fill(0);
    session?.minted?.key.fill(0);
  }
}
