import { PageHero } from "@/components/docs/page-hero";
import { StepList } from "@/components/docs/step-list";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { PageNav } from "@/components/docs/page-nav";
import { Apple, MonitorDown, Terminal } from "lucide-react";

export const metadata = { title: "설치 & 첫 실행" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Getting Started"
        title="설치 & 첫 실행"
        description="Ave AI 호스트 앱은 Electron 데스크톱 빌드로 OS별 패키지로 배포됩니다. 설치 → 첫 실행 → 첫 익스텐션 설치 직전까지의 단계."
        tags={["macOS arm64", "Windows x64", "Linux AppImage", "electron-updater"]}
      />

      <FeatureGrid
        items={[
          { icon: <Apple className="h-5 w-5" />, title: "macOS (Apple Silicon)", body: <>`.dmg` 파일을 Applications 로 드래그. Gatekeeper 첫 실행 확인 → 메인 호스트 창 열림.</>, tone: "teal" },
          { icon: <MonitorDown className="h-5 w-5" />, title: "Windows 10+", body: <>`.exe` 인스톨러 더블클릭. 시작 메뉴 등록 후 자동 실행.</> },
          { icon: <Terminal className="h-5 w-5" />, title: "Linux", body: <>`.AppImage` 파일에 실행 권한 (`chmod +x`) 부여 후 실행. <code>latest-linux.yml</code> 가 업데이트 매니페스트.</> },
        ]}
      />

      <h2 id="install">설치 단계</h2>
      <StepList
        steps={[
          { title: "OS에 맞는 빌드 다운로드", body: <p><a href="https://former-site.invalid/#download">former-site.invalid/#download</a> 에서 macOS arm64 / Windows x64 / Linux AppImage 중 하나를 받습니다.</p>, badge: "5분" },
          { title: "실행 권한 부여 & 더블클릭", body: <>
            <p>macOS: 첫 실행 보안 경고 시 <strong>설정 → 개인정보 및 보안</strong>에서 「확인 없이 열기」.</p>
            <p>Linux: <code>chmod +x ave-ai-*.AppImage</code> 후 더블클릭 또는 터미널에서 실행.</p>
          </> },
          { title: "스플래시 → 메인 호스트 (App.tsx)", body: <p>Ave 스플래시가 사라지면 채팅 본문이 비어 있는 메인 호스트가 열립니다 (<code>src/ui/renderer/App.tsx</code>). 이 시점에는 아직 어떤 익스텐션도 등록되지 않은 상태.</p> },
          { title: "deeplink 등록", body: <p>OS 가 <code>ave://</code> protocol handler 를 호스트 앱에 매핑 (<code>src/main/ave-protocol.ts</code>). 이후 <code>ave://install/…</code> 링크가 호스트의 마켓플레이스 화면을 엽니다.</p>, badge: "ave://" },
          { title: "마켓플레이스로 이동", body: <p>익스텐션은 <strong>설정 → 마켓플레이스</strong> 에서 설치합니다. 계정은 필요 없습니다 (<a href="/docs/marketplace">마켓플레이스</a>).</p> },
        ]}
      />

      <Callout tone="security" title="첫 실행 시 권한">
        Ave는 첫 실행 단계에서 외부 데이터 / 파일시스템 / 익스텐션 어디에도 접근하지 않습니다.
        모든 권한은 익스텐션 install / 활성화 시점에 사용자 명시 grant 다이얼로그를 통해 부여됩니다.
        자세한 흐름은 <a href="/docs/plugins/permission-grant">익스텐션 권한 허용 흐름</a>.
      </Callout>

      <PageNav />
    </article>
  );
}
