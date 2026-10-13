import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "익스텐션 권한 허용 흐름" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Extensions"
        title="권한 허용 흐름"
        description="익스텐션이 처음 활성화될 때 manifest 선언과 호스트가 분류한 도구 위험도, pluginAccess, hostSecrets, agentApprovalScopes를 사용자에게 한번에 표시하는 통합 다이얼로그."
      />

      <h2 id="what">manifest 로부터 검토되는 항목</h2>
      <ul>
        <li><strong>capabilities</strong>: 형식 검증된 기능 태그. 호스트가 런타임에 강제하는 집합에는 <strong>두 개</strong> 가 들어 있고, 그 집합 밖의 문자열은 그 두 게이트를 열지 못합니다. 다만 “게이트가 아니다” 가 “아무 효과도 없다” 는 뜻은 아닙니다 — 호스트가 <em>어느 익스텐션이 어떤 역할을 맡는지 찾을 때</em> 이 문자열을 조회 키로 쓰는 자리가 있어서, 선언 하나로 그 역할의 도구 표면 전체가 그 익스텐션에 배선될 수 있습니다.</li>
        <li><strong>tools[]</strong>: 순수 MCP <code>Tool</code> 객체 목록. 호스트가 입력 스키마와 실행 경로로 위험도를 분류하며, 매니페스트가 선언한 <code>tool._meta[&quot;ave/operationPolicy&quot;]</code>는 operation별 최소 위험도와 read-before-write 요구를 강화할 수만 있음.</li>
        <li><strong>pluginAccess</strong>: 다른 익스텐션의 어떤 도구/이벤트를 사용할지 (예: 한 익스텐션이 캘린더 익스텐션의 <code>calendar_today</code> 호출).</li>
        <li><strong>agentApprovalScopes</strong>: 익스텐션 간 위험 동작의 표준 라벨 (예: <code>agent_file_share</code>, <code>agent_task_delegate</code>, <code>agent_external_api_call</code>).</li>
        <li><strong>hostSecrets / llmKeySource</strong>: secret 접근 / LLM 키 vendor 선언.</li>
        <li><strong>configSchema</strong>: 사용자가 수정 가능한 설정 필드 + 기본값.</li>
      </ul>

      <h2 id="flow">사용자가 보는 흐름</h2>
      <StepList
        steps={[
          { title: "마켓플레이스에서 설치", body: <p>설정 → 마켓플레이스에서 “설치” 를 누릅니다. <code>ave://install/plugin/&lt;name&gt;@&lt;source&gt;</code> 링크도 같은 화면을 엽니다 (<code>src/main/ave-protocol.ts</code>).</p> },
          { title: "배포 파일 대조", body: <p>소스 스냅숏이 고정한 배포 파일을 SHA-256 또는 커밋과 대조하고, <code>plugin.json</code> 의 권한 필드가 마켓플레이스 설명자와 같은지 확인. 다르면 설치하지 않음 (<code>src/marketplace/resolve/</code>).</p>, badge: "pin" },
          { title: "권한 다이얼로그 — 한 번에 모두", body: <p>manifest 파싱 결과와 호스트가 분류한 도구 위험도를 capabilities / tools / pluginAccess / secrets 별로 묶어 표시. 사용자 확인 후 grant 저장.</p> },
          { title: "최초 활성화", body: <p><code>{"~/.ave/plugins/<pluginId>/"}</code> 자기 namespace 생성 (0o700). 검증된 Skill, Hook, MCP 서버를 익스텐션 런타임과 함께 원자적으로 활성화.</p>, badge: "start()" },
        ]}
      />

      <Callout tone="warn" title="권한 회수 후 동작">
        설치 후에도 호스트 설정 → 익스텐션 → 해당 익스텐션 → 권한 관리에서 grant 회수 가능.
        회수 상태에서 도구 호출이 들어오면 fallback 없이 즉시 reject + 재허용 카드 발사 (Ave no-fallback 룰).
      </Callout>

      <PageNav />
    </article>
  );
}
