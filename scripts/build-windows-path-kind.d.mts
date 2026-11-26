export interface WindowsPathKindBuild {
  binarySha256: string;
  /** Signing-stable digest of the helper image. */
  imageSha256: string;
  receiptSha256: string;
  helper: string;
  fixture?: string;
  fixtureSha256?: string;
}

export function buildWindowsPathKind(options?: { root?: string; arch?: string; fixture?: boolean; outDir?: string }): WindowsPathKindBuild;
