/**
 * A `git diff --raw` entry for a regular file the change modified in place,
 * the shape the pre-push source policy and the CI test selection classify.
 */
export function modifiedEntry(path: string) {
  return { status: "M", oldMode: "100644", newMode: "100644", path };
}
