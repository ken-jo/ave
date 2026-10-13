import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "경고와 정책" };

const cell = "border border-border p-2.5 align-top";

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="연결 경고와 조직 정책"
        description="평문 http, 사내망 주소, 다른 컴퓨터의 폴더도 쓸 수 있지만 조용히 넘어가지는 않습니다. Ave는 연결하기 전에 한 번 묻고 위험이 무엇인지 말하며, 답은 배지로 남깁니다. 조직은 이 중 무엇이든 규칙으로 정할 수 있습니다."
        tags={["연결 전에 확인", "소스마다 기억", "정책으로 결정 가능"]}
      />

      <Callout tone="info" title="Ave 0.14.0부터 적용">
        이전 버전에는 이 페이지의 화면과 메시지 일부가 없거나 다르게 보입니다.
      </Callout>

      <h2 id="before-connect">Ave가 연결하기 전에</h2>
      <p>
        결정이 필요한 주소라면 추가 대화상자는 어떤 연결도 하기 전에 멈추고, “Ave가 연결하기 전에” 아래에 위험마다 한 문장씩과{" "}
        <em>계속</em>, <em>취소</em> 를 보여 줍니다. 계속하면 답이 소스와 함께 저장되고, 그 소스의 행과 패키지에 무엇을
        허용했는지 알리는 배지가 붙습니다. 같은 소스에 대해서는 주소의 성격이 바뀌지 않는 한 — 예를 들어 호스트가 사내망 주소로
        옮겨 가지 않는 한 — 다시 묻지 않습니다.
      </p>
      <MockupFrame title="마켓플레이스 추가 — 1 · 주소">
        <div className="grid gap-2.5 text-[13px]">
          <p className="!my-0 font-medium">Git 주소 또는 폴더</p>
          <p className="!my-0 rounded-md border border-border px-2.5 py-1.5 font-mono text-[12px] [overflow-wrap:anywhere]">
            http://git.lab.example/ave/marketplace.git
          </p>
          <div className="grid gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900">
            <p className="!my-0 font-semibold">Ave가 연결하기 전에</p>
            <p className="!my-0">
              git.lab.example은(는) http를 씁니다. 연결이 암호화되지 않아 네트워크 경로에 있는 누구나 내려받는 내용을 보고 바꿀 수
              있으며, 이 소스의 업데이트는 자동으로 설치되지 않습니다. 계속할까요?
            </p>
            <p className="!my-0">
              git.lab.example은(는) 사내망 주소(10.0.0.1)입니다. 이 소스의 서버만 허용하며, 마켓플레이스가 가리키는 다른 사내
              호스트에서 내려받는 것은 따로 묻습니다. 조직 내부의 소스가 맞을 때만 계속하세요. 계속할까요?
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <span className="rounded-md px-2 py-0.5">취소</span>
              <span className="rounded-md bg-ink px-2 py-0.5 text-white">계속</span>
            </div>
          </div>
        </div>
      </MockupFrame>

      <h2 id="warnings">Ave가 묻는 것</h2>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>상황</th>
              <th className={cell}>묻는 때</th>
              <th className={cell}>이후 배지</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className={cell}>주소가 평문 http</td><td className={cell}>추가할 때</td><td className={cell}>암호화 안 됨(http)</td></tr>
            <tr><td className={cell}>로그인 정보가 http 로 전송됨</td><td className={cell}>토큰과 함께 추가하거나 <em>토큰 설정…</em> 을 누를 때</td><td className={cell}>—</td></tr>
            <tr><td className={cell}>서버가 사내망에 있음</td><td className={cell}>추가할 때</td><td className={cell}>사내망</td></tr>
            <tr><td className={cell}>서버가 이 컴퓨터</td><td className={cell}>추가할 때</td><td className={cell}>이 컴퓨터</td></tr>
            <tr><td className={cell}>마켓플레이스가 다른 사내 호스트에서 내려받게 함</td><td className={cell}>그 마켓플레이스에서 설치할 때 (<em>사내 다운로드 허용</em>)</td><td className={cell}>사내 다운로드</td></tr>
            <tr><td className={cell}>폴더가 다른 컴퓨터에 있음</td><td className={cell}>추가할 때</td><td className={cell}>네트워크 폴더</td></tr>
            <tr><td className={cell}>http 소스의 자동 업데이트</td><td className={cell}>켤 때 (<em>그래도 켜기</em>)</td><td className={cell}>—</td></tr>
          </tbody>
        </table>
      </div>
      <p>Ave가 보여 주는 문장 그대로입니다.</p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "평문 http",
            message: (
              <>
                git.lab.example은(는) http를 씁니다. 연결이 암호화되지 않아 네트워크 경로에 있는 누구나 내려받는 내용을 보고 바꿀
                수 있으며, 이 소스의 업데이트는 자동으로 설치되지 않습니다. 계속할까요?
              </>
            ),
          },
          {
            tone: "warning",
            label: "http 로 보내는 로그인",
            message: (
              <>
                git.lab.example 로그인 정보가 암호화되지 않은 채 전송되어 네트워크 경로에 있는 누구나 복사할 수 있습니다.
                계속할까요?
              </>
            ),
            fix: <p>이를 허용하기 전에는 조직이 목록에 넣은 호스트라도 Ave가 토큰을 http 로 보내지 않습니다.</p>,
          },
          {
            tone: "warning",
            label: "사내망 주소",
            message: (
              <>
                git.lab.example은(는) 사내망 주소(10.0.0.1)입니다. 이 소스의 서버만 허용하며, 마켓플레이스가 가리키는 다른 사내
                호스트에서 내려받는 것은 따로 묻습니다. 조직 내부의 소스가 맞을 때만 계속하세요. 계속할까요?
              </>
            ),
            fix: (
              <p>
                일부 프록시 도구가 모든 호스트를 그 범위로 알려 주는 주소라면 “일부 프록시 도구는 모든 주소를 이 범위로 알려
                줍니다.” 가 덧붙습니다.
              </p>
            ),
          },
          {
            tone: "warning",
            label: "이 컴퓨터",
            message: <>localhost은(는) 이 컴퓨터(127.0.0.1)입니다. 직접 실행한 서버일 때만 계속하세요. 계속할까요?</>,
          },
          {
            tone: "warning",
            label: "사내 다운로드",
            message: (
              <>
                lab 마켓플레이스가 다른 사내 주소 10.0.0.2에서 내려받게 합니다. 이를 허용하면 마켓플레이스가 Ave를 통해 공유기
                설정 페이지 같은 사내망 장비로 요청을 보낼 수 있고, 이미 보낸 요청은 나중에 검사에 실패해도 되돌릴 수 없습니다.
                허용할까요?
              </>
            ),
          },
          {
            tone: "warning",
            label: "다른 컴퓨터의 폴더",
            message: (
              <>
                \\files.example\ave\marketplace은(는) 다른 컴퓨터의 폴더입니다. 이 폴더를 읽으려고 Windows 계정으로
                files.example에 로그인합니다. 계속할까요?
              </>
            ),
            fix: (
              <p>
                이 질문의 다른 형태는 <a href="/docs/marketplace/folders#kinds">폴더 소스</a> 에 있습니다.
              </p>
            ),
          },
          {
            tone: "warning",
            label: "http 로 받는 자동 업데이트",
            message: (
              <>
                lab의 업데이트는 http로 전달됩니다. 네트워크 경로에 있는 누구든 이를 자신의 코드로 바꿀 수 있고, 그 코드는 묻지
                않고 설치될 수 있습니다. 그래도 자동 업데이트를 켤까요?
              </>
            ),
          },
        ]}
      />
      <p>
        마켓플레이스에서 http 로 내려받는 파일도 마켓플레이스가 git 에 고정한 sha256 과 대조합니다. 패키지 시트의 전달 방식 줄에
        “암호화되지 않은 다운로드 — 고정된 sha256으로 검증” 이라고 표시됩니다.
      </p>

      <h2 id="allow-later">나중에 허용하기</h2>
      <p>
        이미 추가한 소스가 새로 확인을 필요로 하게 되면 — 호스트가 사내망 주소로 옮겨 갔거나, 공유 폴더가 이제 다른 컴퓨터에
        있으면 — Ave는 연결을 멈추고 마지막으로 읽은 내용을 계속 씁니다. <strong>소스</strong> 화면의 행에는 <em>확인 필요</em>{" "}
        가 표시됩니다. 서버가 이제 http 로 로그인을 요구하면 행에는 대신 <em>인증 필요</em> 가 표시되고, 허용하기 전까지 Ave는
        로그인 정보를 보내지 않습니다. 어느 쪽이든 행에 <em>허용…</em> 이 있고, “&lt;소스&gt;에 허용할까요?” 에서 위험을 다시
        설명한 뒤 <em>허용</em> 을 받습니다.
      </p>
      <MessageList
        items={[
          {
            tone: "warning",
            message: (
              <>
                이 소스가 쓰는 주소에 소스가 받지 않은 확인이 필요해져 Ave가 연결하지 않았습니다. 소스에서 이 소스의 허용…을 눌러
                의미를 읽고 허용하세요.
              </>
            ),
          },
          {
            tone: "warning",
            message: (
              <>
                git.lab.example에 로그인이 필요한데 이 소스는 http를 쓰므로, 허용하기 전까지 Ave는 로그인 정보를 보내지 않습니다.
                소스에서 이 소스의 허용…을 누른 뒤 토큰 설정…을 누르세요.
              </>
            ),
          },
        ]}
      />

      <h2 id="refused">어떤 확인으로도 통과하지 못하는 것</h2>
      <p>절대 안전할 수 없는 주소는 사용자나 마켓플레이스가 무엇을 고르든 바로 거부합니다.</p>
      <ul>
        <li>링크 로컬이나 클라우드 메타데이터 주소(클라우드 컴퓨터가 자격 증명을 두는 곳), 또는 어느 네트워크에서도 닿을 수 없는 주소로 이어지는 주소</li>
        <li>이 컴퓨터에서 내려받게 하는 마켓플레이스</li>
        <li>주소에 적힌 비밀번호나 토큰, 그리고 내려받으려고 프로그램을 실행하는 <code>&lt;helper&gt;::</code> 주소</li>
        <li>이 컴퓨터의 폴더를 지정하려는 링크(<code>ave://marketplace/add</code>)</li>
      </ul>
      <p>
        거부마다 고유한 문장이 있으며, <a href="/docs/marketplace/troubleshooting#network">문제 해결</a> 에 모아 두었습니다.
      </p>

      <h2 id="policy">조직이 정할 수 있는 것</h2>
      <p>
        관리자는 시스템 정책 파일의 <code>marketplaces</code> 섹션에 규칙을 둡니다. 위치는 macOS 가{" "}
        <code>/Library/Application Support/Ave/policy.json</code>, Windows 가 <code>%ProgramData%\Ave\policy.json</code>,
        Linux 가 <code>/etc/ave/policy.json</code> 입니다. 마켓플레이스 규칙 변경은 재시작 없이 다음 마켓플레이스 작업부터
        적용됩니다. 규칙이 정한 것에는 자물쇠와 “조직에서 설정함” 이 붙고, 문장이 규칙과 파일을 알려 줍니다.
      </p>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>키</th>
              <th className={cell}>효과</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className={cell}><code>allow</code>, <code>block</code></td><td className={cell}>쓸 수 있는 소스. <code>host:&lt;호스트&gt;</code>, 저장소 URL(끝에 <code>*</code> 를 붙이면 그 아래 모든 저장소), 폴더는 <code>path:&lt;폴더&gt;</code> (<code>path:/srv/ave/*</code>, <code>path:*</code>). <code>block</code> 이 <code>allow</code> 보다 우선하며, <code>path:</code> 패턴이 없는 <code>allow</code> 목록은 폴더를 하나도 허용하지 않습니다.</td></tr>
            <tr><td className={cell}><code>allowHttpHosts</code></td><td className={cell}>평문 http 를 써도 되는 호스트. 정책이 적은 호스트(여기, <code>allow</code>, 또는 <code>additional</code> 소스)는 http · 사내망 · 이 컴퓨터 확인을 묻지 않습니다. http 로 보내는 로그인은 여전히 묻습니다.</td></tr>
            <tr><td className={cell}><code>requireHttps</code></td><td className={cell}><code>true</code> 면 <code>allowHttpHosts</code> 를 빼고 평문 http 를 거부합니다.</td></tr>
            <tr><td className={cell}><code>blockPrivateNetworks</code></td><td className={cell}><code>true</code> 면 정책이 적은 호스트를 빼고 사내망 · 이 컴퓨터 주소를 거부합니다.</td></tr>
            <tr><td className={cell}><code>allowLocalSources</code></td><td className={cell}><code>false</code> 면 모든 폴더를 소스로도, 직접 설치로도 거부합니다.</td></tr>
            <tr><td className={cell}><code>allowDirectInstall</code></td><td className={cell}><code>false</code> 면 마켓플레이스를 거친 설치만 허용합니다.</td></tr>
            <tr><td className={cell}><code>additional</code></td><td className={cell}>조직 소스. <code>url</code>, 폴더는 <code>path</code> 로 적습니다. 사용자가 제거하거나 숨길 수 없고, 여기 적은 폴더는 네트워크 폴더 확인을 묻지 않습니다.</td></tr>
            <tr><td className={cell}><code>defaultInstalls</code>, <code>requiredInstalls</code></td><td className={cell}>모든 사용자에게 설치하는 패키지. 필수 패키지는 제거하거나 끌 수 없고 항상 업데이트됩니다 (<a href="/docs/marketplace/updates#organization">자동 업데이트</a> 참고).</td></tr>
            <tr><td className={cell}><code>autoUpdate</code></td><td className={cell}><code>&quot;on&quot;</code> 이나 <code>&quot;off&quot;</code> 로 모든 사용자의 자동 업데이트를 정하고 스위치를 잠급니다.</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        이 시스템 파일은 도구 권한 정책 파일로도 쓰입니다. <code>marketplaces</code>나 <code>service</code>만 설정해도
        최상위에 숫자 <code>version: 1</code>을 넣어야 합니다. 빠뜨리면 Ave는 도구 실행에 명시적 승인을 요구하고 앱에서
        권한 정책을 편집할 수 없게 합니다. 아래는 관리자가 사용하는 <code>policy.json</code> 파일 전체 예시입니다.
      </p>
      <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-secondary/50 p-4 text-[12.5px] leading-relaxed">
{`{
  "version": 1,
  "marketplaces": {
    "allow": ["host:git.example.com", "path:/srv/ave/*"],
    "allowHttpHosts": ["git.example.com"],
    "requireHttps": true,
    "blockPrivateNetworks": false,
    "allowLocalSources": true,
    "allowDirectInstall": false,
    "additional": [
      { "id": "team", "url": "http://git.example.com/ave/marketplace.git" },
      { "id": "team-share", "path": "/srv/ave/marketplace" }
    ],
    "autoUpdate": "on"
  }
}`}
      </pre>
      <p>규칙이 적용되면 사용자에게 이렇게 보입니다.</p>
      <MessageList
        items={[
          {
            tone: "policy",
            label: "requireHttps",
            message: (
              <>
                조직 정책상 https만 쓸 수 있는데 http://git.lab.example/ave/marketplace.git은(는) http를 씁니다. 소스에 https
                주소가 있으면 그 주소를 쓰고, 아니면 관리자에게 호스트를 목록에 넣어 달라고 요청하세요. 정책은 /Library/Application
                Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
          {
            tone: "policy",
            label: "blockPrivateNetworks",
            message: (
              <>
                조직 정책이 사내망과 이 컴퓨터의 소스를 막는데, git.lab.example은(는) 10.0.0.1(으)로 연결됩니다. 관리자에게
                문의하세요. 정책은 /Library/Application Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allowLocalSources",
            message: (
              <>
                조직 정책이 폴더 소스를 허용하지 않아 /Users/me/Documents/agent-marketplace을(를) 읽을 수 없습니다. 관리자에게
                문의하세요. 정책은 /Library/Application Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allowDirectInstall",
            message: (
              <>
                조직 정책상 마켓플레이스를 거쳐서만 설치할 수 있어 https://github.com/acme/proofread을(를) 직접 설치할 수 없습니다.
                관리자에게 문의하세요. 정책은 /Library/Application Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
          {
            tone: "policy",
            label: "block",
            message: (
              <>
                조직 정책이 https://github.com/acme/tools을(를) 차단합니다(규칙 host:github.com). 관리자에게 문의하세요. 규칙은
                /Library/Application Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
          {
            tone: "policy",
            label: "allow",
            message: (
              <>
                조직 정책이 허용한 소스만 쓸 수 있고, https://github.com/acme/tools은(는) 목록에 없습니다. 관리자에게 문의하세요.
                목록은 /Library/Application Support/Ave/policy.json에 있습니다.
              </>
            ),
          },
        ]}
      />

      <Callout tone="warn" title="정책 파일에 실수가 있으면">
        Ave는 이 섹션을 정확히 읽습니다. 모르는 키, 중복 키, 해석할 수 없는 패턴이 있으면 섹션 전체가 무효가 되어, 파일을 고칠
        때까지 공식 마켓플레이스만 동작합니다. “조직의 마켓플레이스 정책을 읽을 수 없어(…) 공식 마켓플레이스만 동작합니다.
        관리자에게 수정을 요청하세요.” 0.13.0까지의 앱은 <code>requireHttps</code>, <code>blockPrivateNetworks</code>,{" "}
        <code>allowLocalSources</code>, <code>path:</code> 규칙, <code>additional</code> 의 폴더, <code>autoUpdate</code> 를
        모르므로, 이 키들은 Ave 0.14.0부터의 앱에만 배포하세요.
      </Callout>

      <PageNav />
    </article>
  );
}
