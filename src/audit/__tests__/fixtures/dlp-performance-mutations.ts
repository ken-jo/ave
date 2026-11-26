// A decoder that starts a new entity scan at every ampersand, even when the
// previous scan reached the end without finding a terminator.
export function quadraticEntityDecoder(input: string): string {
  let decoded = "";
  let start = 0;
  for (let index = 0; index < input.length; index++) {
    if (input.charCodeAt(index) !== 38) continue;
    let end = index + 1;
    while (end < input.length && input.charCodeAt(end) !== 59) end++;
    if (end === input.length || input.slice(index, end) !== "&#47") continue;
    decoded += `${input.slice(start, index)}/`;
    start = end + 1;
    index = end;
  }
  return decoded + input.slice(start);
}

// The nested repetition admits exponentially many partitions of a near miss.
export function exponentialBacktrackingRegex(input: string): string {
  return input.replace(/^(a+)+b$/u, "[redacted]");
}
