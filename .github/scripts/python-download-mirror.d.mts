export function preparePythonDownloadMirror(options: {
  uv: string;
  mirrorRoot: string;
  listDownloads?: () => string;
  download?: (url: string, options: { httpError: (response: Response) => string }) => Promise<Buffer>;
}): Promise<string | null>;
