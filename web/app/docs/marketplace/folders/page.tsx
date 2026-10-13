import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { StepList } from "@/components/docs/step-list";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "폴더 소스" };

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="폴더 소스 — 폴더로 된 마켓플레이스"
        description="이 컴퓨터나 네트워크 공유의 폴더를 마켓플레이스로 쓰거나, 패키지 하나를 담은 폴더로 설치할 수 있습니다. Ave는 git 없이 폴더를 그 자리에서 읽고, 검토한 내용 그대로 설치합니다."
        tags={["git 불필요", "그 자리에서 읽기", "검토한 내용 그대로 설치"]}
      />

      <Callout tone="info" title="Ave 0.14.0부터 적용">
        이전 버전에는 이 페이지의 화면과 메시지 일부가 없거나 다르게 보입니다.
      </Callout>

      <h2 id="when">폴더가 편한 경우</h2>
      <p>
        이미 파일을 공유하는 팀에 패키지를 나누거나, 만들고 있는 패키지를 git 에 올리기 전에 시험하거나, git 이나 인터넷이 없는
        컴퓨터에 설치할 때 폴더가 가장 짧은 길입니다. 폴더 소스는 git 소스와 똑같이 동작합니다. 패키지가 카탈로그에 나오고, 소스
        이름이 붙고, 그 소스에 묶여 있습니다. 다른 점은 Ave가 읽는 방식뿐입니다.
      </p>

      <h2 id="add">폴더 추가하기</h2>
      <StepList
        steps={[
          {
            title: "추가 대화상자 열기",
            body: (
              <p>
                <strong>설정 → 마켓플레이스</strong> 에서 패키지 여러 개가 든 폴더는 <strong>추가 → 마켓플레이스 추가…</strong>,
                패키지 하나가 든 폴더는 <strong>추가 → Git 주소나 폴더로 설치…</strong> 를 고릅니다.
              </p>
            ),
          },
          {
            title: "폴더 고르기",
            body: (
              <>
                <p>
                  <em>폴더 선택…</em> 은 시스템의 폴더 선택 창을 엽니다. <code>/</code>, <code>~</code> 또는 드라이브 문자로
                  시작하는 전체 경로, <code>\\server\share\marketplace</code> 같은 네트워크 경로, <code>file:</code> URL 을
                  직접 입력해도 됩니다. 그러면 대화상자가 “폴더는 있는 그대로 읽으므로 브랜치, 패키지 폴더, 로그인을 받지
                  않습니다.” 라고 알려 줍니다.
                </p>
                <p>
                  git 은 필요 없습니다. git 이 없을 때도 대화상자의 첫 단계에 “폴더를 추가할 때는 git이 필요 없습니다.” 와 함께{" "}
                  <em>폴더 선택…</em> 이 있습니다.
                </p>
              </>
            ),
          },
          {
            title: "네트워크 폴더 확인",
            badge: "네트워크 폴더만",
            body: (
              <p>
                다른 컴퓨터의 폴더는 먼저 “Ave가 연결하기 전에” 아래에서 묻고 <em>계속</em> 과 <em>취소</em> 를 보여 줍니다.
                계속하기 전에는 아무것도 읽지 않습니다. 아래 <a href="#kinds">폴더 종류</a> 를 보세요.
              </p>
            ),
          },
          {
            title: "검토하고 추가",
            body: (
              <p>
                검토 화면은 폴더, Ave가 읽은 내용, 종류별 패키지 수와 배지를 보여 줍니다. 소스 이름을 정하고{" "}
                <em>마켓플레이스 추가</em> 를 누릅니다. 추가해도 아무것도 설치되지 않으며, 패키지마다 설치할 때 검토합니다.
              </p>
            ),
          },
        ]}
      />

      <MockupFrame title="마켓플레이스 추가 — 2 · 검토">
        <div className="grid gap-2.5 text-[13px]">
          <p className="!my-0 font-mono text-[12px] [overflow-wrap:anywhere]">폴더 /Users/me/Documents/agent-marketplace</p>
          <p className="!my-0">
            <span className="font-semibold">Team Marketplace</span>
            <span className="text-muted-foreground"> · 소유자 Platform Team</span>
          </p>
          <p className="!my-0 text-[12px] text-muted-foreground">내용 3f9a1c2</p>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            <span className="rounded-md border border-border px-2 py-0.5">2 익스텐션</span>
            <span className="rounded-md border border-border px-2 py-0.5">4 스킬</span>
          </div>
          <p className="!my-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
            패키지 2개가 이 컴퓨터에서 코드를 실행할 수 있습니다. 소스를 추가해도 아무것도 설치되지 않으며, 익스텐션과 MCP 서버는
            설치할 때 각자 권한을 요청합니다.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">로컬 폴더</span>
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground">
            이 폴더의 변경 사항은 시작할 때, 몇 시간마다, 그리고 새로 고침할 때 반영됩니다.
          </p>
        </div>
      </MockupFrame>

      <p>
        링크를 거치는 경로를 입력했다면 검토 화면이 둘 다 알려 줍니다. “입력한 경로는 ~/ave입니다. 그 경로의 링크가 이곳을
        가리키므로 Ave는 이 폴더를 읽습니다.” 소스는 링크가 아니라 링크가 가리킨 폴더에 묶입니다.
      </p>

      <h2 id="kinds">로컬 · 이동식 · 클라우드 동기화 · 네트워크 폴더</h2>
      <FeatureGrid
        columns={2}
        items={[
          {
            title: "이 컴퓨터의 폴더",
            body: (
              <>
                묻지 않고 읽으며 <strong>로컬 폴더</strong> 배지가 붙습니다. “복사하지 않고 이 컴퓨터에서 그대로 읽습니다. 변경
                사항은 시작할 때, 몇 시간마다, 그리고 새로 고침할 때 반영됩니다.”
              </>
            ),
            tone: "teal",
          },
          {
            title: "이동식 드라이브",
            body: (
              <>
                USB 메모리나 외장 디스크는 연결되어 있는 동안 로컬 폴더입니다. 연결이 끊기면 소스 행에 <em>폴더 없음</em> 이
                표시되고 마지막으로 읽은 패키지는 계속 쓸 수 있으며, 드라이브를 다시 연결한 뒤 다음에 읽을 때 다시 반영됩니다.
              </>
            ),
            tone: "ink",
          },
          {
            title: "클라우드 동기화 폴더",
            body: (
              <>
                클라우드 동기화 서비스가 이 컴퓨터와 동기화하는 폴더는 로컬 폴더처럼 읽습니다. 클라우드에만 있는
                파일은 내려받기 전에는 읽을 수 없으니, 폴더를 오프라인에서도 쓸 수 있게 설정해 두세요.
              </>
            ),
            tone: "ink",
          },
          {
            title: "다른 컴퓨터의 폴더",
            body: (
              <>
                네트워크 경로(<code>\\server\share</code>), Windows 의 네트워크 드라이브, <code>/Network/…</code> 나{" "}
                <code>/net/&lt;host&gt;/…</code> 같은 필요할 때 마운트되는 경로는 네트워크 폴더입니다. 한 번 묻고{" "}
                <strong>네트워크 폴더</strong> 배지를 붙입니다. 직접 마운트한 공유(예: <code>/Volumes</code> 아래)는 마운트할 때
                로그인했으므로 로컬 폴더로 읽습니다.
              </>
            ),
            tone: "citron",
          },
        ]}
      />
      <p>네트워크 폴더 질문은 Ave가 폴더에 대해 알 수 있는 것에 따라 다음 중 하나입니다.</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "네트워크 경로나 네트워크 드라이브 (Windows)",
            message: (
              <>
                \\files.example\ave\marketplace은(는) 다른 컴퓨터의 폴더입니다. 이 폴더를 읽으려고 Windows 계정으로
                files.example에 로그인합니다. 계속할까요?
              </>
            ),
          },
          {
            tone: "warning",
            label: "Windows 가 위치를 알 수 없는 드라이브",
            message: (
              <>
                Z:\marketplace은(는) 이 컴퓨터의 디스크가 아닌 드라이브에 있어 다른 컴퓨터의 폴더일 수 있습니다. 이를 읽으려고
                Windows 계정으로 그 서버에 로그인합니다. 계속할까요?
              </>
            ),
          },
          {
            tone: "warning",
            label: "필요할 때 마운트되는 경로 (macOS, Linux)",
            message: (
              <>
                /Network/Servers/files.example/ave은(는) 필요할 때 마운트되는 다른 컴퓨터(files.example)의 폴더입니다. 이를
                읽으면 그 서버에 연결합니다. 계속할까요?
              </>
            ),
          },
        ]}
      />

      <h2 id="sources">소스 목록에서</h2>
      <p>
        폴더 소스 행은 <em>폴더</em> 와 경로(길면 가운데를 줄이고, 전체 경로는 툴팁에), 읽은 내용을 뜻하는{" "}
        <code>폴더 · &lt;리비전&gt;</code>, 읽기에 성공한 뒤의 “&lt;시각&gt; 읽음” 을 보여 줍니다. <em>토큰 설정…</em> 대신{" "}
        <em>Finder에서 보기</em> (Windows 는 <em>탐색기에서 보기</em>, Linux 는 <em>파일 관리자에서 보기</em>) 가 있습니다.
      </p>
      <MockupFrame title="설정 → 마켓플레이스 → 소스">
        <div className="grid gap-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">team-share</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">직접 추가</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px]">로컬 폴더</span>
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
            폴더 <span className="font-mono">/Users/me/Documents/agent-marketplace</span>
          </p>
          <p className="!my-0 text-[12px]">
            <span className="font-mono">폴더 · 3f9a1c2</span>
            <span className="text-muted-foreground"> · 2분 전 읽음 · 최신</span>
          </p>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-md border border-border px-2 py-0.5">새로 고침</span>
            <span className="rounded-md border border-border px-2 py-0.5">Finder에서 보기</span>
            <span className="rounded-md border border-border px-2 py-0.5 text-red-700">소스 제거</span>
          </div>
        </div>
      </MockupFrame>
      <p>손볼 일이 있는 폴더에는 배지가 두 가지 더 있습니다.</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "네트워크 폴더, 허용 안 됨",
            message: (
              <>
                이 폴더는 이제 다른 컴퓨터에 있지만 이 소스에는 허용하지 않았으므로 Ave가 읽지 않습니다. 소스에서 이 소스 행의
                새로 고침을 누른 뒤, 그 컴퓨터를 믿는다면 허용…을 누르세요.
              </>
            ),
          },
          {
            tone: "warning",
            label: "위치 알 수 없음",
            message: (
              <>
                Ave의 폴더 분류 도구가 없거나 손상되어 이 폴더가 다른 컴퓨터에 있는지 알 수 없습니다. Ave를 다시 설치하세요.
              </>
            ),
          },
        ]}
      />

      <h2 id="changes">변경 사항이 반영되는 방식</h2>
      <ul>
        <li>
          Ave는 시작할 때, 몇 시간마다, 그리고 <em>새로 고침</em> 을 누를 때 폴더를 읽습니다. 패키지가 설치하는 파일을 하나라도
          고치면 폴더의 리비전이 바뀌고, 바뀐 패키지는 버전 번호가 그대로여도 업데이트로 제안됩니다.
        </li>
        <li>
          읽기에 실패하면 마지막으로 읽은 내용을 유지하고, 행에 이유(<em>폴더 없음</em>, <em>폴더를 읽을 수 없음</em>,{" "}
          <em>폴더가 옮겨짐</em>)와 할 일을 적은 문장이 붙습니다 (<a href="/docs/marketplace/troubleshooting#folders">문제 해결</a>{" "}
          참고).
        </li>
        <li>
          소스는 추가할 때의 폴더에 묶여 있습니다. 나중에 경로가 다른 곳을 가리키거나 폴더가 다른 폴더로 바뀌면, Ave는 새 폴더를
          읽지 않고 읽기를 멈춥니다.
        </li>
        <li>Ave가 폴더를 읽는 동안 git 명령이나 폴더 안의 프로그램은 전혀 실행되지 않습니다.</li>
      </ul>

      <h2 id="install">폴더에서 설치되는 것</h2>
      <ul>
        <li>
          <strong>버전 하나.</strong> “폴더에 있는 버전만 설치할 수 있습니다. 폴더에는 파일이 선언한 버전 하나만 있습니다.”
        </li>
        <li>
          <strong>검토한 내용.</strong> 검토는 그때 읽은 내용에 고정됩니다. “폴더 내용 3f9a1c2에 고정: 폴더가 바뀌어도 여기서
          검토한 내용이 설치됩니다” 검토를 연 뒤의 수정은 다음 업데이트로 제안됩니다.
        </li>
        <li>
          <strong>빌드된 파일만.</strong> “폴더는 들어 있는 빌드된 파일을 그대로 설치합니다. 아무것도 내려받거나 이 컴퓨터에서
          빌드하지 않으며, 선언된 릴리스도 쓰지 않습니다.” 익스텐션은 <code>plugin.json</code>, <code>dist/</code>,{" "}
          <code>assets/</code> 만 설치하고, 검토 화면이 빠지는 항목을 알려 줍니다.
        </li>
        <li>
          <strong>폴더 안의 파일.</strong> 링크는 폴더 안을 가리켜야 합니다. 버전 관리 데이터와 시스템 파일(<code>.git/</code>,{" "}
          <code>.DS_Store</code>, <code>._*</code>, <code>Thumbs.db</code>, <code>desktop.ini</code>)은 건너뜁니다.
        </li>
        <li>
          <strong>별도 프로그램을 실행하는 익스텐션.</strong> sha256 으로 고정된 릴리스나 아카이브가 필요하므로 폴더가 아니라 git 마켓플레이스에서
          설치합니다.
        </li>
      </ul>

      <h2 id="overlap">폴더 하나, 소스 하나</h2>
      <p>
        폴더는 한 소스에만 속할 수 있고, 폴더 소스끼리는 겹칠 수 없습니다. 거부된 폴더는 걸리는 소스를 알려 주고{" "}
        <em>&lt;id&gt; 보기</em> 를 제시합니다. 누르면 대화상자를 닫고 소스 화면에서 그 소스를 표시합니다.
      </p>
      <MessageList
        items={[
          {
            message: (
              <>
                /Users/me/Documents/agent-marketplace은(는) 이미 team-share(으)로 추가되어 있습니다. team-share을(를) 쓰거나,
                지운 뒤 이 폴더를 다시 추가하세요.
              </>
            ),
          },
          {
            message: (
              <>
                폴더 소스는 서로 겹칠 수 없습니다. /Users/me/Documents/agent-marketplace/skills은(는) 이미 team-share(으)로 추가된
                /Users/me/Documents/agent-marketplace 안에 있습니다. team-share을(를) 쓰거나, 지운 뒤 원하는 폴더를 추가하세요.
              </>
            ),
          },
          {
            message: (
              <>
                폴더 소스는 서로 겹칠 수 없습니다. /Users/me/Documents은(는) 이미 team-share(으)로 추가된
                /Users/me/Documents/agent-marketplace을(를) 담고 있습니다. 먼저 team-share을(를) 지우거나, 그것을 담지 않는 폴더를
                추가하세요.
              </>
            ),
          },
        ]}
      />

      <Callout tone="security" title="폴더는 직접 추가한 저장소처럼 신뢰합니다">
        폴더의 패키지도 다른 패키지처럼 설치할 때 권한을 묻고, 업데이트도 같은 규칙을 따릅니다 (
        <a href="/docs/marketplace/updates">자동 업데이트</a> 참고). 조직은 폴더 소스를 끄거나 일부 폴더로 제한할 수 있습니다 (
        <a href="/docs/marketplace/warnings#policy">경고와 정책</a> 참고).
      </Callout>

      <PageNav />
    </article>
  );
}
