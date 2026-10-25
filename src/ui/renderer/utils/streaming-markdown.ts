// Hide incomplete markdown-link URLs while streaming to prevent bare-URL autolink flashes; final rendering uses the
// original complete text.

const DANGLING_LINK = /(\[[^\]\n]*\])\(([^)\n]*)$/;

export function clampDanglingMarkdownLink(text: string): string {
  return text.replace(DANGLING_LINK, "$1(…)");
}
