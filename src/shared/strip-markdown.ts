/** Native notification bodies are plain text; in-app Markdown toasts must not use this helper. Block-level Markdown is outside its bounded notification scope. */
export function stripMarkdown(input: string): string {
  let s = input;
  // Balance one URL parenthesis level and strip links before emphasis so link text is preserved.
  s = s.replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
  // Guard underscore emphasis at word boundaries so identifiers remain intact.
  s = s.replace(/(?<![A-Za-z0-9_])__([\s\S]+?)__(?![A-Za-z0-9_])/g, "$1");
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  // Reject whitespace-led emphasis so arithmetic asterisks remain literal.
  s = s.replace(/\*([^\s*][^*]*?)\*/g, "$1");
  // Underscore italics require word boundaries; preserve underscores inside filenames.
  s = s.replace(/(?<![A-Za-z0-9_])_([^\s_][^_]*?)_(?![A-Za-z0-9_])/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^>\s+/gm, "");
  s = s.replace(/^[-*+]\s+/gm, "");
  s = s.replace(/^\d+\.\s+/gm, "");
  return s;
}
