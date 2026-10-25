export function modifiedEntry(path: string) {
  return { status: "M", oldMode: "100644", newMode: "100644", path };
}
