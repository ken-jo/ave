import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { StepList } from "@/components/docs/step-list";
import { Reveal } from "@/components/motion/reveal";

export const metadata = { title: "아키텍처 — 시스템 한 눈에 보기" };

// Same layer-stack visual language as the landing architecture section —
// tag column + hairline card + chip row (docs and landing must not diverge).
const layers = [
  {
    tag: "Desktop Host",
    band: "Electron 호스트",
    boxes: [
      "App.tsx · MainToolbar · ChatView",
      "MessageQueuePanel · SessionTasksPanel",
      "Reviewer (risk-classifier)",
      "Tool Registry · ConversationLoop",
      "RoutineEngine (shutdown · schedule)",
    ],
  },
  {
    tag: "Extension Runtime",
    band: "boot/steps/plugin-runtime.ts",
    boxes: [
      "local-indexer (kiwi · pymupdf4llm · LanceDB · FTS5)",
      "meeting (Whisper STT)",
    ],
  },
  {
    tag: "Storage",
    band: "~/.ave/ (0o700 / 0o600)",
    boxes: [
      "sessions/",
      "routine/",
      "audit/<YYYY-MM-DD>.jsonl",
      "plugins/<id>/",
      "secrets/",
      "permissions.json",
      "settings.json",
      "memories/MEMORY.md",
    ],
  },
  {
    tag: "External",
    band: "마켓플레이스 · 외부",
    boxes: [
      "git 마켓플레이스 (공식 · 사내 · 사용자 지정 저장소)",
      "MCP servers (외부)",
    ],
  },
];

const flowSteps = [
  { title: "사용자 입력", body: <>사용자 입력 → <code>ChatView</code>.</> },
  { title: "Scope 선택", body: <>호스트가 명시적 활성화와 유지된 세션 상태에서 활성 익스텐션 범위를 선택.</> },
  { title: "도구 호출 결정", body: <>모델이 eager Tool schema를 사용하거나 <code>tool_search</code>로 deferred Tool을 승격.</> },
  { title: "Reviewer 평가", body: <>도구 RiskLevel × Category × 사용자 grant 격자에서 자동/카드/다이얼로그 결정.</> },
  { title: "실행", body: <>승인 시 익스텐션 처리기 실행 (<code>callTool</code> 통한 익스텐션 간 호출 가능).</> },
  { title: "응답 스트림", body: <>도구 결과 + thinking 토큰 → LLM 컨텍스트 → 채팅 본문 stream.</> },
  { title: "감사 기록", body: <>모든 단계 → <code>{"~/.ave/audit/<YYYY-MM-DD>.jsonl"}</code> append.</> },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Architecture"
        title="Ave 시스템 한 눈에 보기"
        description="Ave는 네 개의 레이어 — Electron 호스트, 익스텐션 런타임, 로컬 스토리지(~/.ave), 서버 — 가 같은 사용자 신호 위에서 움직이는 구조입니다. 모든 도메인 기능은 익스텐션으로 분리되고, 호스트는 도메인 specific 코드를 import 하지 않습니다 (CI 단계 차단)."
        tags={["static manifest", "no fallback"]}
      />

      <Reveal>
        <div className="my-7 grid gap-2.5" role="figure" aria-label="Ave 스택 — 4 레이어 (소스 검증)">
          {layers.map((l) => (
            <div
              key={l.tag}
              className="grid gap-3 rounded-2xl border border-border bg-white p-5 sm:grid-cols-[130px_1fr]"
            >
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                {l.tag}
              </span>
              <div>
                <p className="font-mono text-[13px] font-semibold text-ink">{l.band}</p>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {l.boxes.map((b) => (
                    <span
                      key={b}
                      className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-[12px] font-medium text-ink-soft"
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            ↑ 결정 · 승인 흐름 &nbsp;·&nbsp; ↓ 신호 · 데이터 흐름 — 모든 계층은 명시적 권한 경계로 분리됩니다.
          </p>
        </div>
      </Reveal>

      <h2 id="data-flow">데이터 흐름 — 사용자 메시지 한 턴</h2>
      <StepList steps={flowSteps} />

      <Callout tone="security" title="아키텍처 문서 정합성">
        모든 구현은 <code>ave/docs/architecture/architecture.md</code> (v4 Final) 에 뿌리를 두며,
        문서와 모순되는 패턴 / 구조 / 접근법은 도입하지 않습니다. — Ave Project CLAUDE.md 룰
      </Callout>

      <PageNav />
    </article>
  );
}
