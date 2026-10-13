import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "로그인 & 첫 화면" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="로그인 & 첫 화면"
        description="Ave 호스트 앱에는 Ave 계정이 없습니다. 마켓플레이스도 로그인 없이 쓰며, 로그인은 Microsoft 365 처럼 외부 서비스를 쓰는 익스텐션이 각자 처리합니다. 인증 창은 익스텐션 측 hostApi.openAuthWindow / hostApi.openAuthPartitionViewer 로 열립니다."
      />

      <h2 id="why">무엇에 로그인하나요?</h2>
      <ul>
        <li><strong>마켓플레이스</strong> — 로그인이 없습니다. 앱이 git 저장소를 직접 읽습니다. 비공개 저장소는 설정 → 마켓플레이스 → 소스의 <strong>토큰 설정</strong> 에 넣은 액세스 토큰이나 이 PC 의 git 자격 증명 도우미로 읽습니다.</li>
        <li><strong>외부 서비스 익스텐션</strong> — 각 익스텐션 자체 OAuth. 토큰은 익스텐션 네임스페이스 에 격리.</li>
      </ul>

      <h2 id="flow">로그인 흐름</h2>
      <StepList
        steps={[
          { title: "익스텐션 설치", body: <p>설정 → 마켓플레이스에서 익스텐션을 설치합니다. 계정 없이 설치 계획을 확인하고 설치합니다.</p> },
          { title: "Extension OAuth — 필요 시", body: <p>외부 서비스 익스텐션의 로그인은 익스텐션 설치 후 첫 사용 시 <code>hostApi.openAuthWindow</code> 로 별도 처리.</p> },
          { title: "토큰 보관", body: <p>익스텐션이 받은 토큰과 마켓플레이스 액세스 토큰은 운영체제의 보안 저장소에 암호화되어 보관됩니다.</p>, badge: "safeStorage" },
        ]}
      />

      <h2 id="first-screen">첫 화면 — 어떤 구성으로 보이나요?</h2>

      <Callout tone="tip" title="로그인 없이도 쓸 수 있는 범위">
        호스트 채팅, 마켓플레이스 설치, 로컬 익스텐션 (예: Local Indexer 의 사전 인덱싱된 폴더) 은 로그인 없이 동작합니다.
        외부 서비스에 접속하는 익스텐션 도구만 그 서비스의 로그인을 요구합니다.
      </Callout>

      <PageNav />
    </article>
  );
}
