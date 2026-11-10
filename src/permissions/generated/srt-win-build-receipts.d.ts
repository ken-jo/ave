export interface SrtWinBuildReceipt {
  readonly schemaVersion: number;
  readonly sourceRevision: string;
  readonly sourceArchiveSha256: string;
  readonly nativePatchSha256: string;
  readonly rustToolchain: string;
  readonly target: string;
  readonly binarySha256: string;
}
declare const receipts: Readonly<Record<string, SrtWinBuildReceipt>>;
export default receipts;
