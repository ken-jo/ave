export const UV_TARGETS = Object.freeze([
  Object.freeze({
    dir: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    bin: "uv",
    archive: "uv-aarch64-apple-darwin.tar.gz",
    archiveSha256: "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca",
    type: "tar.gz",
  }),
  Object.freeze({
    dir: "win32-x64",
    platform: "win32",
    arch: "x64",
    bin: "uv.exe",
    archive: "uv-x86_64-pc-windows-msvc.zip",
    archiveSha256: "edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb",
    type: "zip",
  }),
  Object.freeze({
    dir: "linux-x64",
    platform: "linux",
    arch: "x64",
    bin: "uv",
    archive: "uv-x86_64-unknown-linux-gnu.tar.gz",
    archiveSha256: "a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5",
    type: "tar.gz",
  }),
  Object.freeze({
    dir: "linux-arm64",
    platform: "linux",
    arch: "arm64",
    bin: "uv",
    archive: "uv-aarch64-unknown-linux-gnu.tar.gz",
    archiveSha256: "0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d",
    type: "tar.gz",
  }),
]);

for (const target of UV_TARGETS) {
  if (!/^[0-9a-f]{64}$/.test(target.archiveSha256)) {
    throw new Error(`UV_TARGETS malformed: ${target.dir} archiveSha256 is not lowercase 64-char hex`);
  }
}

export const UV_TARGET_BY_DIR = new Map(UV_TARGETS.map((target) => [target.dir, target]));
export const SUPPORTED_UV_TARGET_DIRS = Object.freeze(UV_TARGETS.map((target) => target.dir));

export function getUvTargetByDir(dir) {
  const target = UV_TARGET_BY_DIR.get(dir);
  if (!target) {
    throw new Error(`Unknown uv target '${dir}'. Known targets: ${SUPPORTED_UV_TARGET_DIRS.join(", ")}`);
  }
  return target;
}

export function resolveUvTarget(platform, arch) {
  const target = UV_TARGETS.find((item) => item.platform === platform && item.arch === arch);
  if (!target) {
    throw new Error(`지원하지 않는 플랫폼/아키텍처: ${platform}/${arch}`);
  }
  return target;
}

export function installerUvTargetFor(installerTarget, platform = process.platform, arch = process.arch) {
  if (installerTarget === "mac") {
    if (platform !== "darwin" || arch !== "arm64") {
      throw new Error("Ave macOS installers support Apple Silicon only; Intel macOS builds are not supported.");
    }
    return { ...resolveUvTarget("darwin", "arm64"), archFlag: "--arm64" };
  }
  if (installerTarget === "linux") {
    const target = resolveUvTarget("linux", arch);
    return { ...target, archFlag: arch === "arm64" ? "--arm64" : "--x64" };
  }
  if (installerTarget === "win") {
    const target = resolveUvTarget("win32", arch);
    return { ...target, archFlag: "--x64" };
  }
  throw new Error(`Unknown installer target: ${installerTarget}`);
}
