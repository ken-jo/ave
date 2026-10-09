import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const arch = process.argv[2] ?? process.arch;
if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported rename helper architecture: ${arch}`);
if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(root, "scripts/build-windows-job.ps1"), "-Arch", arch, "-Helper", "rename-entry"], { stdio: "inherit" });
} else {
  const out = join(root, "resources/rename-entry", arch);
  mkdirSync(out, { recursive: true });
  const args = ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror"];
  if (process.platform === "darwin") args.push("-arch", arch === "x64" ? "x86_64" : arch);
  else if (process.platform !== "linux" || arch !== process.arch) throw new Error("Rename helper requires a native build");
  args.push(join(root, "native/rename-entry/rename-entry.cpp"), "-o", join(out, "ave-rename-entry"));
  execFileSync(process.platform === "darwin" ? "/usr/bin/clang++" : "c++", args, { stdio: "inherit" });
}
