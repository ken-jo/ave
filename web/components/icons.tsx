/**
 * Line icons for the extension kinds grid, drawn for this site on a 24-unit
 * grid with a 1.6 stroke. Order matches `HomeCopy.plugins.kinds`.
 */

const paths: string[] = [
  // Plugins: a puzzle piece
  "M9 4h4v2.5a1.5 1.5 0 0 0 3 0V4h4v5h-2.5a1.5 1.5 0 0 0 0 3H20v8h-5v-2.5a1.5 1.5 0 0 0-3 0V20H4v-8h2.5a1.5 1.5 0 0 0 0-3H4V4h5Z",
  // MCP servers: stacked servers
  "M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01",
  // Skills: an open book
  "M12 6c-2-1.5-5-2-8-1.5V19c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V4.5c-3-.5-6 0-8 1.5ZM12 6v14.5",
  // Agents: a person with a spark
  "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20c.7-3.5 3.3-5.5 6.5-5.5s5.8 2 6.5 5.5M18.5 4v4M16.5 6h4",
  // Model providers: a chip
  "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  // Themes: half-filled circle
  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 3v18",
  // Fonts: letter A
  "M5 19 10.5 5h3L19 19M7.5 13.5h9",
  // Languages: globe
  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z",
  // Messaging: speech bubble
  "M4 5h16v11H9l-5 4V5ZM8 9.5h8M8 12.5h5",
  // Local folders: folder
  "M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z",
];

export function KindIcon({ index }: { index: number }) {
  const d = paths[index];
  if (!d) throw new Error(`no icon for kind ${index}`);
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
