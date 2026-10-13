import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "패키지 작성자 가이드" };

const kinds = [
  { kind: "skill", files: "SKILL.md 와 scripts/ · references/ · assets/ · LICENSE · NOTICE" },
  { kind: "agent", files: "AGENTS.md 하나" },
  { kind: "theme", files: "theme.json 과 선택적 미리보기 이미지. 대비 규칙을 검사합니다" },
  { kind: "font", files: "font.json · LICENSE · files/ 아래 글꼴(.woff2 · .woff · .ttf · .otf)" },
  { kind: "language", files: "locale · language.json · messages.json(영어 카탈로그에 있는 화면 문구 키만)" },
  { kind: "provider", files: "provider.json(프로바이더 프리셋)" },
  { kind: "messaging-connection", files: "connection.json" },
  { kind: "mcp", files: "정확한 버전의 npx · uvx · docker 런처, 패키지 안 server/ 명령, Streamable HTTP, 또는 공식 MCP server.json" },
  { kind: "plugin", files: "plugin.json 에서 복사한 authority 와 배포 파일 고정값(artifact)" },
];

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace · Authors"
        title="패키지 작성자 가이드 — 게시는 머지입니다"
        description="마켓플레이스는 git 저장소이고, 패키지를 게시한다는 것은 그 저장소에 커밋을 머지하는 일입니다. 업로드 API · 승인 대기열 · 퍼블리셔 키는 없습니다. 저장소의 브랜치 보호가 곧 검토입니다."
        tags={["marketplace.json 인덱스", "종류별 ave-package.json", "버전은 커밋에 고정"]}
      />

      <h2 id="layout">저장소 구조</h2>
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-secondary/60 p-4 font-mono text-[13px] leading-relaxed text-ink">{`marketplace.json                      인덱스
policy/revocations.json               선택 — 회수 목록
<kind dir>/<name>/ave-package.json   패키지마다 설명자 하나
<kind dir>/<name>/...                 패키지 파일`}</pre>
      <p>
        <code>marketplace.json</code> 은 하나뿐인 인덱스 파일이고 형식 버전을 <code>schemaVersion: 2</code> 로 담습니다. 앱은 다른 값을 거부합니다.
        이 파일은 마켓플레이스 이름과 패키지마다 <code>kind</code> · <code>name</code> · <code>path</code> 를 나열합니다.
        패키지 항목의 <code>versions[]</code>(최신순)는 각 <code>version</code> 을 그 버전을 게시한 <code>commit</code> 에 고정합니다.
        이름은 소문자와 하이픈이고, 한 마켓플레이스 안에서 종류마다 유일합니다.
      </p>

      <h2 id="kinds">종류별 파일</h2>
      <p>
        <code>ave-package.json</code> 에는 <code>schemaVersion: 2</code> · <code>kind</code> · <code>name</code> · <code>version</code> ·{" "}
        <code>minAppVersion</code> 과 종류별 <code>payload</code> 가 들어갑니다. SVG 는 어떤 종류에서도 받지 않습니다.
      </p>
      <ul>
        {kinds.map((k) => (
          <li key={k.kind}><code>{k.kind}</code> — {k.files}</li>
        ))}
      </ul>

      <h2 id="plugins">익스텐션 배포 파일</h2>
      <StepList
        steps={[
          { title: "release", body: <p>GitHub 릴리스 자산. <code>sha256</code> 고정이 있을 때만 씁니다.</p>, badge: "1순위" },
          { title: "archive", body: <p>https zip. 역시 <code>sha256</code> 고정이 있을 때만 씁니다.</p>, badge: "2순위" },
          { title: "tree", body: <p>고정 커밋에 있는 패키지의 <code>plugin.json</code> · <code>dist/</code> · <code>assets/</code>. 그 밖의 파일은 둘 수 없습니다.</p>, badge: "3순위" },
        ]}
      />
      <p>
        전송이나 체크섬이 실패하면 다음 단계로 넘어갑니다. 받은 <code>plugin.json</code> 의 권한 필드와 <code>minAppVersion</code> 이
        설명자와 다르면 설치가 멈춥니다. 폐기된 <code>installPolicy</code> · <code>publisher</code> 필드를 선언한 매니페스트는 거부됩니다.
      </p>

      <h2 id="lifecycle">업데이트 · 회수 · 폐기</h2>
      <ul>
        <li><strong>업데이트</strong> — 새 <code>version</code> 을 게시하면 사용자는 다음 동기화 뒤에 봅니다. 새 권한은 사용자의 명시적인 결정을 받습니다.</li>
        <li><strong>회수(yank)</strong> — <code>versions[]</code> 항목에 <code>yanked</code> 를 넣으면 그 버전을 더는 제안하지 않습니다. 이미 설치된 것은 그대로 둡니다.</li>
        <li><strong>단계적 배포</strong> — 버전에 <code>rollout: {"{ percent }"}</code> 를 둡니다.</li>
        <li><strong>폐기</strong> — <code>policy/revocations.json</code> 에 나열한 버전은 이 소스에서 설치된 것에 한해 비활성화(<code>disable</code>)하거나 제거(<code>uninstall</code>)합니다.</li>
      </ul>

      <Callout tone="tip" title="게시 전에 저장소 검사">
        앱의 규칙은 <code>checkMarketplaceRepository</code> 로 내보내집니다. 공식 저장소처럼 이 검사를 CI 에 넣으면, 결과가 비었을 때 앱이
        모든 패키지를 그대로 받아들인다는 뜻입니다.
      </Callout>

      <Callout tone="info" title="더 자세한 형식">
        모든 형식의 기준은 앱 저장소의 <code>docs/design/multi-source-git-marketplace.md</code> 이고, 작성자용 안내는{" "}
        <code>docs/guides/marketplace-publishing.md</code>, 로컬 테스트는 <code>docs/guides/local-marketplace-testing.md</code> 에 있습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
