// Embedded build paths must be rejected by the bundle validator.
export function embeddedBuildPaths(bytes: Buffer): string[] {
  const source = bytes.toString();
  const paths: string[] = [];
  if (/\/(?:private|Users|home|tmp|var|workspace|workspaces|root|opt|mnt|builds|repo)\//u.test(source)) {
    paths.push("Unix checkout path");
  }
  if (/(?:^|[\s"'`(=])[A-Za-z]:[\\/]/mu.test(source)) paths.push("Windows drive path");
  return paths;
}
