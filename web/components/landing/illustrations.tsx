/**
 * Original vector illustrations for the landing page. They depict the product's
 * idea (signals → one proposal → your approval) with abstract shapes only — no
 * app screenshots or UI captures. All are decorative (`aria-hidden`); the
 * surrounding text carries the meaning.
 */

const INK = "#14161d";
const INK_SOFT = "#3a3d47";
const LINE = "#c9d3cf";
const FERN = "#1d6b58";
const MINT = "#9fd3c1";

function Bar({ x, y, w, o = 1 }: { x: number; y: number; w: number; o?: number }) {
  return <rect x={x} y={y} width={w} height={7} rx={3.5} fill={INK} opacity={0.12 * o} />;
}

/** Three source glyphs (mail, calendar, document) as plain geometry. */
function SourceNode({ cx, cy, kind }: { cx: number; cy: number; kind: "mail" | "cal" | "doc" }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={30} fill="#ffffff" stroke={LINE} />
      {kind === "mail" ? (
        <g fill="none" stroke={INK_SOFT} strokeWidth={2} strokeLinejoin="round">
          <rect x={cx - 13} y={cy - 9} width={26} height={18} rx={3} />
          <path d={`M${cx - 13} ${cy - 7} L${cx} ${cy + 2} L${cx + 13} ${cy - 7}`} />
        </g>
      ) : kind === "cal" ? (
        <g fill="none" stroke={INK_SOFT} strokeWidth={2}>
          <rect x={cx - 12} y={cy - 10} width={24} height={21} rx={3} />
          <path d={`M${cx - 12} ${cy - 3} H${cx + 12} M${cx - 6} ${cy - 14} V${cy - 7} M${cx + 6} ${cy - 14} V${cy - 7}`} />
          <circle cx={cx + 4} cy={cy + 4} r={2.2} fill={FERN} stroke="none" />
        </g>
      ) : (
        <g fill="none" stroke={INK_SOFT} strokeWidth={2} strokeLinejoin="round">
          <path d={`M${cx - 9} ${cy - 13} H${cx + 4} L${cx + 10} ${cy - 7} V${cy + 13} H${cx - 9} Z`} />
          <path d={`M${cx - 4} ${cy - 1} H${cx + 5} M${cx - 4} ${cy + 5} H${cx + 3}`} />
        </g>
      )}
    </g>
  );
}

/** Hero: signals drift in, become one proposal, and wait for a single approval. */
export function HeroArt() {
  return (
    <svg viewBox="0 0 1040 420" className="h-auto w-full" aria-hidden="true" focusable="false">
      {/* flight paths */}
      <g fill="none" stroke={FERN} strokeWidth={1.6} opacity={0.55}>
        <path className="ave-flow" d="M180 110 C 300 110, 330 190, 430 196" />
        <path className="ave-flow" d="M180 210 C 290 210, 330 208, 430 208" />
        <path className="ave-flow" d="M180 310 C 300 310, 330 228, 430 220" />
        <path className="ave-flow" d="M690 208 C 740 208, 770 208, 820 208" />
      </g>

      <SourceNode cx={150} cy={110} kind="mail" />
      <SourceNode cx={150} cy={210} kind="cal" />
      <SourceNode cx={150} cy={310} kind="doc" />

      {/* proposal card */}
      <g>
        <rect x={432} y={118} width={258} height={180} rx={18} fill="#ffffff" stroke={LINE} />
        <rect x={456} y={142} width={64} height={18} rx={9} fill={MINT} opacity={0.55} />
        <rect x={456} y={176} width={196} height={10} rx={5} fill={INK} opacity={0.85} />
        <Bar x={456} y={198} w={170} />
        <Bar x={456} y={214} w={140} />
        <rect x={456} y={246} width={92} height={30} rx={15} fill={INK} />
        <path d="M480 261 l6 6 l12 -12" fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        <rect x={556} y={246} width={70} height={30} rx={15} fill="#ffffff" stroke={LINE} />
      </g>

      {/* approval node */}
      <g>
        <circle cx={872} cy={208} r={52} fill="#ffffff" stroke={LINE} />
        <circle cx={872} cy={208} r={34} fill={FERN} />
        <path d="M857 209 l10 10 l20 -21" fill="none" stroke="#ffffff" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Tile: many faint signals, one highlighted. */
export function SignalsArt() {
  const dots = [
    [60, 70], [120, 50], [190, 80], [260, 56], [300, 110], [90, 140], [160, 130],
    [230, 150], [290, 180], [70, 200], [140, 190], [210, 205],
  ];
  return (
    <svg viewBox="0 0 360 240" className="h-auto w-full" aria-hidden="true" focusable="false">
      {dots.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={6} fill={INK} opacity={0.14} />
      ))}
      <circle cx={160} cy={130} r={22} fill="none" stroke={FERN} strokeWidth={1.6} opacity={0.5} />
      <circle cx={160} cy={130} r={9} fill={FERN} />
    </svg>
  );
}

/** Tile: one composed proposal with a context chip. */
export function ProposalArt() {
  return (
    <svg viewBox="0 0 360 240" className="h-auto w-full" aria-hidden="true" focusable="false">
      <rect x={60} y={44} width={240} height={152} rx={16} fill="#ffffff" stroke={LINE} />
      <rect x={82} y={66} width={70} height={16} rx={8} fill={MINT} opacity={0.6} />
      <rect x={82} y={96} width={176} height={10} rx={5} fill={INK} opacity={0.85} />
      <Bar x={82} y={116} w={150} />
      <Bar x={82} y={132} w={120} />
      <rect x={82} y={160} width={64} height={22} rx={11} fill={INK} />
      <rect x={154} y={160} width={52} height={22} rx={11} fill="#ffffff" stroke={LINE} />
    </svg>
  );
}

/** Tile: a gate — nothing writes until it opens. */
export function GateArt() {
  return (
    <svg viewBox="0 0 360 240" className="h-auto w-full" aria-hidden="true" focusable="false">
      <path d="M60 120 H150" stroke={INK} strokeOpacity={0.25} strokeWidth={2} strokeDasharray="4 7" />
      <path d="M210 120 H300" stroke={FERN} strokeWidth={2} />
      <rect x={150} y={64} width={60} height={112} rx={14} fill="#ffffff" stroke={LINE} />
      <circle cx={180} cy={104} r={12} fill="none" stroke={INK_SOFT} strokeWidth={2} />
      <rect x={168} y={112} width={24} height={22} rx={5} fill={INK} />
      <circle cx={300} cy={120} r={10} fill={FERN} />
    </svg>
  );
}
