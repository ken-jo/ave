export const homeEscapeDecoderProbe = {
  fullCalls: 0,
  quadratic: false,
  isEntityTerminatorMissing: quadraticEntityTerminatorMissing,
};

// Repeated unterminated numeric references cause overlapping suffix scans.
// Run this at the decoder's escape-read site only in the mutation probe.
function quadraticEntityTerminatorMissing(text: string, index: number): boolean {
  if (text.charCodeAt(index) !== 38 || text.charCodeAt(index + 1) !== 35) return false;
  let end = index + 2;
  while (end < text.length && text.charCodeAt(end) !== 59) end++;
  return end === text.length;
}

// The nested repetition admits exponentially many partitions of a near miss.
export function exponentialBacktrackingRegex(input: string): string {
  return input.replace(/^(a+)+b$/u, "[redacted]");
}
