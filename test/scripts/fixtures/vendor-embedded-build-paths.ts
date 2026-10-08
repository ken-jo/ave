/**
 * The official repository's rule that a vendored bundle exposes no path of the
 * checkout it was built in — `embeddedBuildPaths` in `tools/vendor.mjs`
 * (`ken-jo/agent-marketplace` at `e53fb40a8`, `:37-43`), which `checkVendored`
 * applies to every `build` entry. Ported verbatim in behaviour, so a bundle the
 * app's test accepts is one that repository's check accepts.
 */
export function embeddedBuildPaths(bytes: Buffer): string[] {
  const source = bytes.toString();
  const paths: string[] = [];
  if (/\/(?:private|Users|home|tmp|var|workspace|workspaces|root|opt|mnt|builds|repo)\//u.test(source)) {
    paths.push("Unix checkout path");
  }
  if (/(?:^|[\s"'`(=])[A-Za-z]:[\\/]/mu.test(source)) paths.push("Windows drive path");
  return paths;
}
