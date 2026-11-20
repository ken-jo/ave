type HomePlatform = "linux" | "darwin" | "win32";
type Redactor = "text" | "path";

interface LiteralHomeCorpus {
  platform: HomePlatform;
  home: string;
  inputs: readonly (readonly [Redactor, string])[];
}

export const WINDOWS_LITERAL_HOMES = [
  String.raw`D:\fixtures\habitat`, String.raw`\\srv\share\habitat`,
  String.raw`C:\Users\bob`, String.raw`E:\temp\ted`,
] as const;

const DESCENDANT_NAMES = ["new", "tab", "bin", "file", "u0032", "ubeef", "u00e9x", "x41", "2024", ".git", "é", "fixtures"];
const PATH_CONTEXTS = [
  (path: string) => path, (path: string) => `Open ${path} now`,
  (path: string) => `Open:"${path}"`, (path: string) => `[Open:"${path}"]`,
];

function escapeFreeInputs(home: string, platform: HomePlatform): LiteralHomeCorpus["inputs"] {
  const windows = platform === "win32";
  const separator = windows ? "\\" : "/";
  const path = `${home}${separator}File.txt`;
  const forward = path.replaceAll("\\", "/");
  const plain = [home, path, forward, path.toUpperCase(), `${home}2/file`, `${home}_old/file`, `${home}.old/file`];
  const inputs: [Redactor, string][] = plain.flatMap(value => [["text", value], ["path", value]]);
  for (const text of [
    `see ${path} and ${path} now`, `"${home}"`, `cd "${path}" && ls`, `'${path}'`,
    `(${path})`, `[${path}]`, `file://${forward}`, `${home}, ${home}. ${home}: ${home};`,
    "/home/other/x /Users/other/y C:/Users/other/z",
    JSON.stringify({ p: path, other: 1 }), JSON.stringify(JSON.stringify({ p: path })),
  ]) inputs.push(["text", text]);
  if (windows) {
    const repeated = home.replaceAll("\\", "/").replace(/\/(?=[^/]+$)/u, "//");
    inputs.push(["path", `${repeated}/report.txt`]);
  } else {
    inputs.push(
      ["path", `FILE://${home}/file`],
      ["path", `file://${home}?view=1`],
      ["path", `file://${home}#page`],
    );
  }
  return inputs;
}

export function literalHomeCorpus(): LiteralHomeCorpus[] {
  const posixHomes = ["/srv/fixtures/habitat", "/home/bob", "/Users/Bob", "/home/John Smith", "/home/o'brien", "/Users/Café"];
  return [
    ...(["linux", "darwin"] as const).flatMap(platform => posixHomes.map(home => ({ platform, home, inputs: escapeFreeInputs(home, platform) }))),
    ...[...WINDOWS_LITERAL_HOMES, String.raw`D:\fixtures\bob`, String.raw`C:\Users\John Smith`, String.raw`C:\Users\Café`]
      .map(home => ({ platform: "win32" as const, home, inputs: escapeFreeInputs(home, "win32") })),
  ];
}

export function windowsDescendantInputs(home: string): string[] {
  const inputs: string[] = [];
  for (const name of DESCENDANT_NAMES) {
    for (const [index, context] of PATH_CONTEXTS.entries()) {
      const path = context(`${home}\\${name}\\file`);
      if (index) inputs.push(path);
      let input = JSON.stringify({ p: path, other: 1 });
      for (let depth = 1; depth <= 3; depth++) {
        inputs.push(input);
        input = JSON.stringify(input);
      }
    }
  }
  return inputs;
}
