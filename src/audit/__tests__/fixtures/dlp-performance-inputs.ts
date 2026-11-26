const DRIVE_BOB = String.raw`C:\Users\bob`;
export const MIXED_ESCAPE_FRAGMENT = String.raw`%252541&amp;amp;amp;B\u0043`;

export const WINDOWS_SEPARATOR_HOMES = [
  { shape: "UNC", path: String.raw`\\server\share\alice` },
  { shape: "extended drive", path: String.raw`\\?\D:\fixtures\alice` },
  { shape: "drive", path: String.raw`D:\fixtures\alice` },
] as const;

export const WINDOWS_SEPARATOR_INPUTS = [
  { name: "separator run", input: (_path: string, size: number) => `${"\\".repeat(size - 9)}near-miss` },
  {
    name: "near-miss name",
    input: (path: string, size: number) => {
      const firstSeparator = path.indexOf("\\");
      const prefix = path.slice(0, firstSeparator);
      const nearMiss = `${path.slice(firstSeparator).replace(/^\\+/u, "").slice(0, -1)}X`;
      return prefix + "\\".repeat(size - prefix.length - nearMiss.length) + nearMiss;
    },
  },
] as const;

export const fill = (size: number, unit: string, head = "") => head + unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
export const GENERIC_HOME_FAMILIES = [
  ["x y ", "/home/"], ["/home/x y", ""], [DRIVE_BOB, ""], ["%C3", "/home/"], ["a", "https://"], ["a:/users/", "/home/"],
  ["%2525", "/home/"], ["x ", "C:\\Users\\"], ["/users/x", "https://x.example"],
  ["\\\\a\\b", ""], ["a", "\\\\"], ["\\", ""], ["x y ", '"/home/'], ['"/home/x y ', ""], ["\\u00e9", "/home/"],
  ["\\u002fhome", ""], ["%27", "/home/"], ["%2D", "file://"],
  ["\\uabcd", "/home/"], ["\\\\\\uabcd", "/home/"], ["\\uabcd\\x", "C:\\Users\\"], ["\\\\uabcd", "C:\\\\Users\\\\"],
  ["\\\\uabcd\\\\x", "C:\\\\Users\\\\"], ["\\\\uabcd\\\\u", "/home/"],
] as const;

export function secretFamiliesAt(size: number): string[] {
  const fill = (unit: string, tail = "") => unit.repeat(Math.ceil(size / unit.length)).slice(0, size - tail.length) + tail;
  return [
    fill("token", "!"), fill("token", "="), fill("a."), fill("a.", "://x@y"), fill("a@"), fill(" a@"), fill("a:b@"), fill("%"),
    `token="${fill("\\")}`, fill('token="a'), fill("token='a"), `'${fill("\\")}':`, fill('\\"'),
    fill("a="), fill("a:"), fill('"a":'), fill("token="), fill(" ="), `token${fill(" ")}=`, fill("--token "), fill("-"),
    fill('"a'), fill("'a"), fill('"a" '), fill('"a:'), fill("'x=y' "), fill('"token":"a'), fill('\\\\"'), `"${fill("a:")}`,
    fill('"a"\n'), `"a"${fill("\r\n")}:`, `"token":${fill("\n")}`, fill("'a' :"), fill(`"'a':`), fill('"token"\n:'), fill("'[REDACTED:X]':"),
    fill('"token:a" :'), `"${fill("token=a ")}": x`, fill(`"'a b' token=c":`), `"${fill("'a")}":`,
    fill('\\"a'), fill('\\"a\\\\\\"'), `\\"${fill('a\\\\\\"')}`, fill('\\"token\\":'), fill('\\"token\\":\\"a\\"'), fill('"token":\n"a"\n:'), fill("token: a :"),
    `"${fill('\\"a')}": 1`, `"\\"${fill('a\\\\\\"')}": 1`, fill('\\"a \\"'), `"${fill('\\"token\\": ')}": 1`, fill("token=Basic "), `token=Basic${fill(" ")}x`,
    `Authorization: Digest ${fill('a="b", ')}`, fill("Authorization: Basic a\n"), fill("x: Authorization: Basic "),
    fill("\\u0041"), fill("\\\\u0041uthorizatio"), fill("Authorizatio"), fill('\\"Authorization\\"'), fill("\\nauthorization"), fill("--authorizatio"),
    `Authorization${fill("\n")}`, `"Authorization"${fill("\\n")}`, `Authorization${fill("\\\\\\t")}`, fill("Authorization \n"), fill('"authorization"\\u000a'), `authorization:${fill(" \r\n")}`,
    fill("authorization_"), `authorization_${fill("a")}`, fill("x-authorization-token "), fill("authorization.x\\u00a0"), `Authorization${fill("\\u00a0")}`,
    `Authorization${fill("\\\\u2003")}`, fill("authorization\\u005f"), fill("Authorization\\u0041"), `"authorization_x${fill("\\uFEFF")}"`,
    `"${fill("authorization ")}`, fill('"authorization '), fill("'a authorization "), fill('"authorization \\"authorization '),
    `"${fill("authorization\\u003a")}`, `\\"${fill("authorization\n")}\\": x`, fill('"x" authorization '),
    // Read long backslash runs once per key window rather than once per step.
    `${"authorization ".repeat(18)}${fill("\\")}`, `${"authorization ".repeat(18)}${fill("\\", "u0041")}`,
    fill("?a%26"), fill("&a%41"), fill("%253f"), fill("&sig=a1B"), `&sig=${fill("a1B%3D")}`, `?token=${fill("\\")}`, `?token=a${fill("%2526")}`,
    fill("\\u0026token=a"), fill("?\\u0073ig=a1B"), fill('?token=a"'), `"?token=${fill('a\\"')}`, fill("&Expires=1&sig=a"), `?token=${fill("\\\\u0026")}`,
    fill('"?token=a\\\\\\"'), fill("<?token=a>"), fill("`?token=a'"), `${fill('\\\\"')}?token=a\\"`,
  ];
}
