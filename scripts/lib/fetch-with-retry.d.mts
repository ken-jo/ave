export declare const DOWNLOAD_ATTEMPTS: number;

export interface FetchBytesWithRetryOptions {
  /** Message for a non-OK response; the final transient failure appends the attempt count. */
  readonly httpError: (response: Response) => string;
  readonly log?: (message: string) => void;
  readonly fetchImpl?: (url: string) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export declare function fetchBytesWithRetry(url: string, options: FetchBytesWithRetryOptions): Promise<Buffer>;
