export declare const DOWNLOAD_ATTEMPTS: number;

export declare class DownloadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}

export declare function isTransientNetworkError(error: unknown): boolean;

export interface FetchBytesWithRetryOptions {
  /** Message for a non-OK response; the final transient failure appends the attempt count. */
  readonly httpError: (response: Response) => string;
  readonly log?: (message: string) => void;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly env?: NodeJS.ProcessEnv;
}

export declare function fetchBytesWithRetry(url: string, options: FetchBytesWithRetryOptions): Promise<Buffer>;
