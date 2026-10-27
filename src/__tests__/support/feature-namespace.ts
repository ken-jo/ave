/** JSON-only namespace fixtures grant no file-stream creation capability. */
export async function refuseNamespaceFileCreation(_name: string): Promise<never> {
  throw new Error("File creation is unavailable in this test namespace.");
}
