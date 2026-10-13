import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "마켓플레이스" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="마켓플레이스 — git 저장소와 폴더에서 받는 패키지"
        description="익스텐션 · MCP 서버 · 스킬 · 에이전트 · 테마 · 글꼴 · 언어 · 프로바이더 · 메신저 연결은 git 저장소나 폴더로 된 마켓플레이스에서 옵니다. 계정도 업로드 서버도 없습니다. 앱은 소스를 읽고, 읽은 커밋이나 폴더 내용에 고정하고, 거기에 고정된 파일만 설치합니다."
        tags={["저장소가 곧 카탈로그", "계정 없이 설치", "커밋에 고정된 설치"]}
      />

      <h2 id="where">어디서 보나요?</h2>
      <p>
        <strong>설정 → 마켓플레이스</strong> 탭입니다. 종류별 탭으로 패키지를 나눠 보고, 소스 필터로 한 마켓플레이스만
        골라 보고, <strong>설치됨</strong> 탭에서 이 PC 에 설치한 것을 확인합니다. 로그인은 필요 없습니다.
      </p>

      <h2 id="sources">소스 — 패키지가 오는 곳</h2>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "공식 (ave)",
            body: <>앱에 내장된 마켓플레이스입니다. 호스트 비밀값을 받을 수 있는 익스텐션은 이 소스가 고정한 배포 파일로 설치된 공식 익스텐션뿐입니다.</>,
            tone: "teal",
          },
          {
            title: "관리형",
            body: <>회사가 시스템 정책 파일로 등록한 사내 마켓플레이스입니다. 기본 설치나 필수 설치를 지정할 수 있고, 필수 패키지는 제거 · 비활성화할 수 없습니다.</>,
            tone: "ink",
          },
          {
            title: "사용자 지정",
            body: <><strong>추가 → 마켓플레이스 추가…</strong> 에 저장소 주소를 넣거나 이 컴퓨터 · 네트워크 공유의 폴더를 골라 직접 등록한 마켓플레이스입니다 (<a href="/docs/marketplace/folders">폴더 소스</a> 참고).</>,
            tone: "ink",
          },
          {
            title: "직접 설치",
            body: <><strong>추가 → Git 주소나 폴더로 설치…</strong> 로 마켓플레이스 없이 패키지 하나를 담은 저장소나 폴더를 설치합니다.</>,
            tone: "citron",
          },
        ]}
      />
      <p>
        어느 소스에서 왔든 실행 중에 패키지가 할 수 있는 일은 같습니다. 어떤 패키지도 스스로를 잠그거나, 스스로에게 비밀값을
        주거나, 다른 소스의 패키지를 회수할 수 없습니다. 설치한 패키지는 설치한 소스에 계속 묶여 있고, 업데이트도 그 소스에서만 받습니다.
      </p>

      <h2 id="flow">추가부터 제거까지</h2>
      <StepList
        steps={[
          {
            title: "마켓플레이스 추가",
            body: <p>저장소 주소(https, http 또는 ssh)를 넣거나 폴더를 고릅니다. 평문 http, 사내망, 다른 컴퓨터의 폴더라면 먼저 묻습니다 (<a href="/docs/marketplace/warnings">경고와 정책</a> 참고). 그다음 앱이 소스를 읽고, 종류별 패키지 수와 이 앱이 받아들이지 않는 패키지를 이유와 함께 미리 보여 줍니다.</p>,
          },
          {
            title: "설치",
            body: <p>카탈로그에서 설치를 누르면 설치 계획이 먼저 나옵니다. 익스텐션은 권한 · 네트워크 호스트 · 비밀값 요청을 보여 주고, 사용자가 확인한 뒤에야 설치됩니다.</p>,
            badge: "사용자 확인",
          },
          {
            title: "업데이트",
            body: <p>앱은 시작할 때와 하루에 한 번 소스를 확인합니다. 동의한 내용을 바꾸지 않는 업데이트는 대화가 진행 중이지 않을 때 스스로 설치되고, 더 많은 것을 요청하는 업데이트는 커밋 범위와 모든 변경을 보여 주는 검토를 기다립니다 (<a href="/docs/marketplace/updates">자동 업데이트</a> 참고).</p>,
          },
          {
            title: "소스 제거와 패키지 제거",
            body: <p>소스를 제거해도 그 소스에서 설치한 패키지는 남지만 더 이상 업데이트되지 않습니다. 패키지는 <strong>설치됨</strong> 탭에서 제거합니다.</p>,
          },
        ]}
      />

      <h2 id="links">설치 링크</h2>
      <p>
        웹 페이지나 문서의 링크로 설치 화면을 열 수 있습니다. <code>ave://install/&lt;kind&gt;/&lt;name&gt;@&lt;source&gt;</code> 는 마켓플레이스 탭에서 그 패키지를,{" "}
        <code>ave://marketplace/add?url=&lt;저장소&gt;</code> 는 마켓플레이스 추가 화면을 엽니다. 링크는 화면만 열 뿐이고, 설치는 항상 사용자가 확인합니다.
      </p>

      <Callout tone="security" title="무엇을 믿고 설치하나요">
        앱은 동기화한 커밋과 그 커밋이 고정한 값만 믿습니다. 익스텐션 배포 파일은 고정된 SHA-256 과, 저장소 트리로 받은 익스텐션은 고정된 커밋과 대조하고, 설치 기록(receipt)에 파일마다
        해시를 남겨 실행 전에 다시 확인합니다. 마켓플레이스는 <code>policy/revocations.json</code> 으로 자기 소스에서 설치된 버전을 비활성화하거나 제거할 수 있습니다.
      </Callout>

      <Callout tone="info" title="무언가 거부되었다면">
        모든 거부는 무슨 일이 있었고 무엇을 하면 되는지 말합니다. <a href="/docs/marketplace/troubleshooting">문제 해결</a> 에 확인할 것과 함께 모아 두었습니다.
      </Callout>

      <Callout tone="info" title="패키지를 만들고 싶다면">
        저장소 구조와 종류별 파일은 <a href="/docs/marketplace/authors">패키지 작성자 가이드</a> 에 있습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
