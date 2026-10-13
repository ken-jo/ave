export interface ReleaseChannel {
  /** `build.publish[0].url`, e.g. `https://downloads.agent-connector.ai/releases`. */
  readonly feedUrl: string;
  readonly origin: string;
  /** Object-key prefix of the feed and the versioned files, e.g. `releases/`. */
  readonly feedPrefix: string;
  /** Object-key prefix of the stable download aliases: `latest/`. */
  readonly latestPrefix: string;
}

export interface PutOperation {
  readonly action: "put";
  readonly source: string;
  readonly key: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly immutable: boolean;
}

export interface CopyOperation {
  readonly action: "copy";
  readonly from: string;
  readonly key: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly contentDisposition: string;
}

export type UploadOperation = PutOperation | CopyOperation;

export declare const FEED_FILES: readonly string[];
export declare const IMMUTABLE_CACHE: string;
export declare const REVALIDATE_CACHE: string;

export declare function releaseChannel(packageJson: unknown): ReleaseChannel;

export declare function latestDownloadUrl(channel: ReleaseChannel, rest: string): string;

export declare function feedReferences(text: string): { version: string | undefined; files: string[] };

export declare function planR2Upload(input: {
  packageJson: unknown;
  tag: string;
  files: readonly string[];
  readFeed: (name: string) => string;
}): { channel: ReleaseChannel; version: string; operations: UploadOperation[] };

export declare function missingSecrets(env: Record<string, string | undefined>): string[];
