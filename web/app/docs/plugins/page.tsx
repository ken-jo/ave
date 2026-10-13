import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";
import { Badge } from "@/components/ui/badge";

const plugins = [
  { slug: "local-indexer", title: "Local Indexer", id: "local-indexer", ver: "0.6.6", scope: "Local · RAG", desc: "kiwipiepy 한국어 형태소 + pymupdf4llm + FTS5 + LanceDB. chokidar 폴더 감시.", color: "from-teal/10 to-transparent" },
  { slug: "meeting", title: "Meeting", id: "meeting", ver: "0.8.4", scope: "Audio · STT", desc: "OpenAI Whisper API (gpt-4o-transcribe) + PCM16LE 16kHz/3sec 청크.", color: "from-coral/10 to-transparent" },
];

export const metadata = { title: "익스텐션 — 개요" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Extensions"
        title="익스텐션 — 호스트가 모르는 기능을 붙이는 단위"
        description="Ave의 모든 도메인 기능 (메일·캘린더·회의·문서·사내 API)은 익스텐션으로 분리됩니다. 호스트 코어는 익스텐션별 코드를 가져오지 않습니다. 공개 계약은 앱 릴리스 태그에서 가져옵니다."
        tags={["static manifest", "앱 릴리스 계약"]}
      />

      <Callout tone="info" title="익스텐션 등록 모델 — 정적 manifest">
        도구·Skill·Hook·MCP 서버·이벤트·UI 슬롯은 모두 <code>plugin.json</code> manifest 에 정적 선언합니다.
        런타임 <code>registerTool</code>/<code>registerSkill</code>/<code>registerCommand</code> 같은 등록 API는 제공하지 않습니다.
        Skill은 지침을 제공하고, 호출 가능한 표면은 순수 manifest <code>Tool</code> 객체뿐입니다.
      </Callout>

      <div className="my-8 grid gap-3 sm:grid-cols-2">
        {plugins.map((p) => (
          <Link
            key={p.slug}
            href={`/docs/plugins/${p.slug}`}
            className="group relative overflow-hidden rounded-2xl border border-border bg-white p-5 transition hover:-translate-y-0.5 hover:border-ink/15 hover:shadow-md"
          >
            <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${p.color}`} />
            <div className="relative">
              <div className="mb-1.5 flex items-center justify-between">
                <Badge variant="muted">{p.scope}</Badge>
                <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-ink" />
              </div>
              <p className="text-[16px] font-semibold text-ink">{p.title}</p>
              <p className="mt-0.5 text-[11.5px] font-mono text-muted-foreground">id: {p.id} · v{p.ver}</p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      <h2 id="install">설치 흐름</h2>
      <ol>
        <li>설정 → 마켓플레이스에서 익스텐션 선택 → “설치” (<code>ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code> 링크도 이 화면을 엶).</li>
        <li>호스트가 소스 스냅숏이 고정한 배포 파일을 받아 SHA-256 또는 커밋과 대조하고, <code>plugin.json</code> 이 마켓플레이스의 설명자와 같은지 확인.</li>
        <li>설치 기록(receipt)에 파일마다 해시를 남기고, 이후 실행 때마다 다시 확인.</li>
        <li>익스텐션 권한 다이얼로그 → 사용자 확인 → 자기 namespace <code>{"~/.ave/plugins/<pluginId>/"}</code> 생성.</li>
        <li>검증된 선언형 번들을 하나의 단위로 활성화하고 익스텐션 <code>start()</code> 콜백을 호출.</li>
      </ol>

      <Callout tone="info" title="과거 → 현재 통합 이력">
        <ul className="my-1 list-disc pl-5">
          <li><strong>agent-hub</strong> 사이드바 익스텐션은 archive 되었고 (2026-06-15), 업무 보드는 앱에 내장된 개인 칸반 보드로 흡수되었습니다. 더 이상 설치 가능한 익스텐션이 아닙니다.</li>
        </ul>
      </Callout>

      <PageNav />
    </article>
  );
}
