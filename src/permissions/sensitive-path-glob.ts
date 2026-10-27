type GlobState = { kind: "literal"; value: string } | { kind: "one" | "star" | "any" | "prefix" | "body" };

// Match the policy's fixed glob grammar without regex backtracking. State count
// is fixed by the catalogue; each input code unit advances that graph once.
export function compileSensitivePathGlob(pattern: string, insensitive: boolean): (path: string) => boolean {
  const states: GlobState[] = [];
  const folded = (char: string): string => {
    if (!insensitive) return char;
    const upper = char.toUpperCase();
    return upper.length !== 1 || (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? char : upper;
  };
  const source = pattern.replace(/\\/g, "/");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        states.push({ kind: "prefix" }, { kind: "body" });
        index += 2;
      } else { states.push({ kind: "any" }); index += 1; }
    } else if (char === "*") states.push({ kind: "star" });
    else if (char === "?") states.push({ kind: "one" });
    else states.push({ kind: "literal", value: folded(char) });
  }
  const epsilon = (active: Uint8Array): void => {
    for (let index = 0; index < states.length; index += 1) {
      if (!active[index]) continue;
      const state = states[index]!;
      if (state.kind === "star" || state.kind === "any") active[index + 1] = 1;
      else if (state.kind === "prefix") active[index + 2] = 1;
    }
  };
  return (path) => {
    let active = new Uint8Array(states.length + 1);
    active[0] = 1;
    epsilon(active);
    for (let offset = 0; offset < path.length; offset += 1) {
      const raw = path[offset] === "\\" ? "/" : path[offset]!;
      const char = folded(raw);
      const next = new Uint8Array(states.length + 1);
      for (let index = 0; index < states.length; index += 1) {
        if (!active[index]) continue;
        const state = states[index]!;
        if (state.kind === "literal") { if (char === state.value) next[index + 1] = 1; }
        else if (state.kind === "one") { if (raw !== "/") next[index + 1] = 1; }
        else if (state.kind === "star") { if (raw !== "/") next[index] = 1; }
        else if (state.kind === "any") { if (!/[\n\r\u2028\u2029]/.test(raw)) next[index] = 1; }
        else if (state.kind === "prefix") {
          if (!/[\n\r\u2028\u2029]/.test(raw)) next[index + 1] = 1;
          if (raw === "/") next[index + 2] = 1;
        } else {
          if (!/[\n\r\u2028\u2029]/.test(raw)) next[index] = 1;
          if (raw === "/") next[index + 1] = 1;
        }
      }
      epsilon(next);
      active = next;
    }
    return active[states.length] === 1;
  };
}
