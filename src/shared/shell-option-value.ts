export function readShellOptionValue(
  argv: readonly string[],
  index: number,
  options: ReadonlySet<string>,
  otherValueOptions?: ReadonlySet<string>,
): { option: string; value: string; consumedNext: boolean } | null {
  const token = argv[index]!;
  const equals = token.indexOf("=");
  // A short option consumes the entire suffix, including a leading equals sign.
  if (equals > 2 && options.has(token.slice(0, equals))) {
    return { option: token.slice(0, equals), value: token.slice(equals + 1), consumedNext: false };
  }
  const takeNext = (option: string): { option: string; value: string; consumedNext: boolean } | null => {
    const next = argv[index + 1];
    return next === undefined ? null : { option, value: next, consumedNext: true };
  };
  if (options.has(token)) return takeNext(token);
  // Only short options cluster; exclude long options and --.
  if (!token.startsWith("-") || token.startsWith("--")) return null;
  for (let i = 1; i < token.length; i += 1) {
    const option = `-${token[i]!}`;
    // A different value-taking option owns the entire remaining suffix.
    if (otherValueOptions?.has(option)) return null;
    if (!options.has(option)) continue;
    const attached = token.slice(i + 1);
    return attached.length > 0 ? { option, value: attached, consumedNext: false } : takeNext(option);
  }
  return null;
}
