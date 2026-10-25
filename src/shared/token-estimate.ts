/** Keep token estimation dependency-free below both prompts and engine so neither layer needs an upward import. */

export function countHangul(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xac00 && c <= 0xd7a3) count++;
  }
  return count;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  const hangul = countHangul(text);
  const ratio = hangul / text.length;
  const weight = ratio >= 0.5 ? 1.3 : 1.0;
  return Math.ceil((text.length * weight) / 4) + 1;
}
