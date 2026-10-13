import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "앱 업데이트" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="앱 업데이트"
        description="Ave는 백그라운드에서 새 버전이 있는지 주기적으로 살펴봅니다. 사용자 동의 없이 다운로드되거나 강제로 설치되지 않습니다."
        tags={["자동 다운로드 X", "재시작은 사용자가", "롤백 가능"]}
      />

      <h2 id="how">업데이트가 적용되는 방식</h2>
      <ul>
        <li>호스트가 일정 시간 간격으로 새 버전이 있는지만 확인합니다.</li>
        <li>새 버전이 감지되어도 자동으로 다운로드하지 않습니다.</li>
        <li>다운로드 완료 시 채팅 영역 상단에 「재시작하여 업데이트」 카드가 나타납니다.</li>
        <li>사용자가 「재시작」을 누르는 순간에만 새 빌드가 적용됩니다.</li>
      </ul>

      <Callout tone="info" title="롤백">
        업데이트 후 문제가 생기면 호스트가 이전 버전으로 되돌아가는 경로를 안내합니다.
        패키지는 별도로, 마켓플레이스 운영자가 문제가 된 버전을 회수(yank)하거나 폐기 목록에 올려 그 소스에서 설치된 버전을 일괄 비활성화 · 제거할 수 있습니다.
      </Callout>

      <PageNav />
    </article>
  );
}
