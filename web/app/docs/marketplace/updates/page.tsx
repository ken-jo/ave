import { PageHero } from "@/components/docs/page-hero";
import { Callout } from "@/components/docs/callout";
import { FeatureGrid } from "@/components/docs/feature-grid";
import { MockupFrame } from "@/components/docs/mockup-frame";
import { MessageList } from "@/components/docs/message-list";
import { PageNav } from "@/components/docs/page-nav";

export const metadata = { title: "자동 업데이트" };

const cell = "border border-border p-2.5 align-top";

export default function Page() {
  return (
    <article>
      <PageHero
        eyebrow="Marketplace"
        title="자동 업데이트"
        description="Ave는 시작할 때와 하루에 한 번 소스를 확인합니다. 동의한 내용을 바꾸지 않는 업데이트는 대화가 진행 중이지 않을 때 스스로 설치되고, 그 밖의 업데이트는 이유와 함께 검토를 기다립니다."
        tags={["시작할 때와 매일 확인", "대화 중에는 적용 안 함", "동의 변경은 검토 후"]}
      />

      <Callout tone="info" title="Ave 0.14.0부터 적용">
        이전 버전에는 이 페이지의 화면과 메시지 일부가 없거나 다르게 보입니다.
      </Callout>

      <h2 id="where">어디서 보나요?</h2>
      <p>
        <strong>설정 → 마켓플레이스 → 유지 관리 → 업데이트</strong> 입니다. 카드에 “시작할 때와 하루에 한 번 업데이트를
        확인합니다”, 마지막 확인과 다음 확인 시각, <em>지금 확인</em> 이 있습니다. 사용자가 할 일이 있는 업데이트는 도구 모음에도
        표시됩니다.
      </p>
      <MockupFrame title="설정 → 마켓플레이스 → 유지 관리">
        <div className="grid gap-2.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">업데이트</span>
            <span className="ml-auto rounded-md border border-border px-2 py-0.5 text-[12px]">지금 적용</span>
            <span className="rounded-md border border-border px-2 py-0.5 text-[12px]">지금 확인</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>패키지 자동 업데이트</span>
            <span className="h-4 w-7 shrink-0 rounded-full bg-ink" aria-hidden="true" />
          </div>
          <p className="!my-0 text-[12px] text-muted-foreground">
            시작할 때와 하루에 한 번 업데이트를 확인합니다 · 마지막 확인 3시간 전 · 다음 확인 21시간 후
          </p>
          <p className="!my-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            업데이트 2개가 대화가 멈추기를 기다리고 있습니다.
          </p>
          <ul className="!my-0 grid list-none divide-y divide-border rounded-md border border-border !pl-0 text-[12px]">
            <li className="!my-0 grid gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Issue Sync</span>
                  <span className="text-muted-foreground">익스텐션 · <span className="font-mono">2.0.3 → 2.1.0</span></span>
                </span>
                <span className="text-muted-foreground">검토가 필요합니다</span>
                <span className="rounded-md border border-border px-2 py-0.5">검토</span>
                <span className="rounded-md border border-border px-2 py-0.5">기본값(켬)</span>
              </div>
              <span className="text-muted-foreground">동의한 내용과 다른 것을 요청합니다</span>
            </li>
            <li className="!my-0 grid gap-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Meeting</span>
                  <span className="text-muted-foreground">익스텐션 · <span className="font-mono">0.8.4 → 0.9.0</span></span>
                </span>
                <span className="text-muted-foreground">대화가 멈추면 적용합니다</span>
                <span className="rounded-md border border-border px-2 py-0.5">기본값(켬)</span>
              </div>
            </li>
          </ul>
        </div>
      </MockupFrame>

      <h2 id="checks">언제 확인하나요?</h2>
      <ul>
        <li>시작할 때와 하루에 한 번입니다. 연결하지 못한 소스는 한 시간 안에 다시 시도하며, 그때까지 그 소스의 패키지는 설치된 버전으로 표시됩니다.</li>
        <li><em>지금 확인</em> 은 바로 확인합니다. 폴더 소스는 몇 시간마다, 그리고 그 행의 <em>새로 고침</em> 을 누를 때도 다시 읽습니다.</li>
        <li>
          오프라인이면 카드에 “오프라인 — 마지막 확인 3시간 전. 네트워크가 돌아오면 다시 확인합니다.” 라고, 일부 소스만 답했으면
          “일부 소스에 연결하지 못해 그 소스의 패키지는 설치된 버전으로 표시됩니다. 소스마다 이유는 소스 화면에 있으며, 한 시간
          안에 다시 시도합니다.” 와 <em>소스 보기</em> 가 표시됩니다.
        </li>
      </ul>

      <h2 id="automatic">스스로 설치되는 업데이트</h2>
      <p>다음을 모두 만족할 때만 업데이트가 스스로 설치됩니다.</p>
      <ul>
        <li>패키지가 켜져 있고, 소스가 표시되어 있으며, 그 패키지의 자동 업데이트가 켜져 있습니다 (<a href="#switches">스위치</a> 참고).</li>
        <li>같은 소스의 새 버전이거나, 폴더라면 버전은 같고 파일이 바뀌었습니다.</li>
        <li>설치할 때 동의한 것과 다른 것을 요청하지 않습니다. 권한, 네트워크 호스트, 비밀 값, 로그인이 같고, 승인한 MCP 서버와 훅이 모두 그대로입니다.</li>
        <li>소스의 히스토리가 다시 쓰이지 않았고, 건너뛴 버전이 아닙니다.</li>
        <li>http 소스라면 그 소스의 http 자동 업데이트를 허용했습니다.</li>
        <li>조직 정책이 여전히 그 소스를 허용하고, 그 버전의 자동 시도가 세 번 실패하지 않았습니다.</li>
      </ul>
      <p>
        업데이트는 한 번에 하나씩, 대화 턴이 진행 중이지 않을 때만 설치되므로 답변 도중에 바뀌는 일이 없습니다. 그동안 행에는
        “대화가 멈추면 적용합니다” 가 표시됩니다. 30분이 지나면 카드에 “업데이트 2개가 대화가 멈추기를 기다리고 있습니다.” 가
        나오고 도구 모음에도 표시되며, <em>지금 적용</em> 은 기다리지 않고 설치합니다. 플러그인은 실행 중인 호출이 끝날 때까지도
        기다립니다(“실행 중인 호출이 끝나기를 기다립니다”).
      </p>
      <p>
        적용한 업데이트는 24시간 동안 “자동으로 업데이트됨” 아래에 <em>변경 내용</em> (커밋 범위)과 함께 남습니다. 설치했지만 아직
        실행되지 않은 패키지는 “설치했지만 실행되지 않음 — Ave를 다시 시작하세요” 로 표시됩니다.
      </p>

      <h2 id="review">검토를 기다리는 업데이트와 그 이유</h2>
      <p>모든 행이 상태와 이유를 알려 줍니다.</p>
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="bg-secondary text-left">
              <th className={cell}>상태</th>
              <th className={cell}>표시되는 이유</th>
              <th className={cell}>할 일</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={cell}>검토가 필요합니다</td>
              <td className={cell}>
                “동의한 내용과 다른 것을 요청합니다” · “동의한 내용을 읽을 수 없어 한 번 확인해야 합니다” · “이전 Ave 버전에서
                승인한 구성 요소를 다시 확인해야 합니다”
              </td>
              <td className={cell}><em>검토</em> 가 업데이트 검토를 엽니다.</td>
            </tr>
            <tr>
              <td className={cell}>업데이트 가능</td>
              <td className={cell}>
                “패키지가 꺼져 있습니다” · “소스 기록이 다시 작성되어 검토를 기다립니다” · “같은 소스의 새 버전이 아닙니다” · “소스가
                http를 쓰며, 이 소스의 자동 업데이트를 허용하지 않았습니다” · “자동 업데이트가 꺼져 있습니다”
              </td>
              <td className={cell}><em>검토</em> 를 거쳐 설치합니다.</td>
            </tr>
            <tr>
              <td className={cell}>업데이트 가능</td>
              <td className={cell}>“소스가 숨겨져 있습니다”</td>
              <td className={cell}>
                먼저 <strong>소스</strong> 화면에서 그 소스의 스위치를 켜 다시 표시하세요. 그전에는 검토를 거쳐도 그 소스에서 아무것도
                설치되지 않습니다.
              </td>
            </tr>
            <tr>
              <td className={cell}>업데이트 가능</td>
              <td className={cell}>“조직 정책이 더 이상 이 소스에서의 설치를 허용하지 않습니다”</td>
              <td className={cell}>
                정책이 그대로인 동안에는 그 소스에서 아무것도 설치되지 않습니다. 관리자에게 정책 변경을 요청하세요. 설치된 버전은
                그대로 남습니다.
              </td>
            </tr>
            <tr>
              <td className={cell}>업데이트 실패</td>
              <td className={cell}>“자동 시도가 세 번 실패했습니다. 다시 시도하면 검토 후 설치합니다” · “이 버전의 실패한 시도: 3회”</td>
              <td className={cell}><em>세부 정보</em> 가 이유를 보여 주고, <em>다시 시도</em> 는 검토를 거쳐 설치합니다.</td>
            </tr>
            <tr>
              <td className={cell}>구성 요소가 승인을 기다립니다</td>
              <td className={cell}>조직이 필수 패키지를 업데이트했고, 새로 생기거나 바뀐 구성 요소는 승인할 때까지 꺼져 있습니다.</td>
              <td className={cell}><em>검토</em> 가 플러그인이면 “&lt;이름&gt;의 구성 요소 승인” 을, 익스텐션이면 그 익스텐션의 설정을 엽니다.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        업데이트 검토는 “동의한 내용이 바뀝니다” 아래에 달라진 권한 · 호스트 · 비밀 값 · 구성 요소를 <code>이전 → 이후</code> 로
        하나씩 보여 줍니다. “바뀌었거나 새로 추가된 서버나 훅은 승인해야 실행됩니다. 선택하지 않으면 꺼진 채로 업데이트가
        설치됩니다.” 코드가 아닌 파일만 바뀌었다면 검토는 “코드가 아닌 다음 파일만 바뀌었습니다:” 한 줄이고, <em>업데이트 승인</em>{" "}
        으로 한 번에 받아들입니다. <em>&lt;버전&gt; 유지</em> 는 설치된 버전을 그대로 둡니다.
      </p>
      <p>
        “마지막 확인에서 소스에 연결하지 못해 이전 확인의 상태로 표시합니다.” 가 붙은 행은 이전 확인의 결과이며, 소스가 응답하면
        최신 상태로 바뀝니다.
      </p>

      <h2 id="switches">스위치</h2>
      <FeatureGrid
        columns={3}
        items={[
          { title: "패키지 자동 업데이트", body: <>업데이트 카드의 전체 스위치입니다.</>, tone: "teal" },
          { title: "소스별 자동 업데이트", body: <>업데이트 카드에 소스마다 선택 상자가 하나씩 있습니다.</>, tone: "ink" },
          {
            title: "자동 업데이트",
            body: <>패키지마다 하나씩: 업데이트 카드의 행과, 업데이트가 있든 없든 패키지 시트에 있습니다.</>,
            tone: "citron",
          },
        ]}
      />
      <p>
        소스와 패키지의 선택 상자에는 그대로 둘 때 적용되는 값을 보여 주는 <em>기본값(켬)</em> 또는 <em>기본값(끔)</em> 과,{" "}
        <em>켬</em>, <em>끔</em> 이 있습니다. 먼저 정해진 것이 결정합니다. 조직 정책, 패키지, 소스, 전체 스위치 순입니다. 모두
        기본값이면 업데이트가 켜져 있되, http 로 직접 추가한 소스만 꺼져 있습니다.
      </p>
      <MessageList
        items={[
          {
            tone: "warning",
            label: "http 소스를 켤 때",
            message: (
              <>
                lab의 업데이트는 http로 전달됩니다. 네트워크 경로에 있는 누구든 이를 자신의 코드로 바꿀 수 있고, 그 코드는 묻지
                않고 설치될 수 있습니다. 그래도 자동 업데이트를 켤까요?
              </>
            ),
            fix: <p><em>그래도 켜기</em> 는 그 소스에 대해 이를 받아들이고, <em>취소</em> 는 꺼진 채로 둡니다.</p>,
          },
        ]}
      />

      <h2 id="skip">버전 건너뛰기</h2>
      <p>
        도구 모음의 업데이트 표시에서 “다음 업데이트까지 건너뛰기” 를 고르면 그 버전들은 더 이상 제안되지 않고, 그다음 새 버전이
        제안됩니다. 건너뛴 버전은 카드 목록에서 빠지므로, 확인 뒤 보여 줄 것이 없으면 카드는 모두 최신이라고 하지 않고 “검토할
        업데이트가 없습니다.” 라고 씁니다.
      </p>

      <h2 id="organization">조직이 필수로 지정한 패키지</h2>
      <p>
        정책의 <code>requiredInstalls</code> 에 있는 패키지는 항상 자동으로 업데이트됩니다. 정책이 사용자의 동의를 대신하므로
        스위치는 켜진 채 잠기고(“조직이 필수로 지정한 패키지입니다. 이 스위치와 상관없이 자동으로 업데이트됩니다.”), 건너뛰기 ·
        세 번 실패 중단 · 검토가 막지 않습니다. 폐기되었거나 호환되지 않는 버전은 여전히 제안되지 않습니다. 이런 업데이트가 아직
        승인하지 않은 플러그인 구성 요소를 가져오면 업데이트는 설치되고, 그 구성 요소는 “&lt;이름&gt;의 구성 요소 승인” 에서
        승인할 때까지 꺼져 있습니다.
      </p>
      <p>
        정책의 <code>autoUpdate</code> 로 모든 사용자의 자동 업데이트를 정할 수도 있습니다. 그러면 전체 스위치가 잠기고 “조직이
        설정함: 패키지가 자동으로 업데이트됩니다.” 또는 “조직이 설정함: 검토한 업데이트만 설치됩니다.” 가 표시됩니다.
      </p>

      <h3 id="unmet">필수인데 설치되지 않은 패키지</h3>
      <p>필수 패키지를 설치할 수 없으면 카드의 “조직이 필수로 지정했지만 설치되지 않은 패키지” 아래에 이유와 할 수 있는 일이 나옵니다.</p>
      <MessageList
        items={[
          {
            tone: "warning",
            message: <>조직이 acme의 docs-search을(를) 필수로 지정했지만, 이 마켓플레이스가 Ave에 추가되어 있지 않습니다.</>,
            fix: <p>관리자에게 문의하세요. 정책이 그 마켓플레이스도 등록해야 합니다.</p>,
          },
          {
            tone: "warning",
            message: <>조직이 acme의 docs-search을(를) 필수로 지정했지만, 아직 이 마켓플레이스에 연결하지 못했습니다.</>,
            fix: <p><em>소스 새로 고침</em> 으로 바로 다시 시도합니다. 계속 실패하면 네트워크나 VPN 을 확인하세요.</p>,
          },
          {
            tone: "warning",
            message: (
              <>
                조직이 acme의 docs-search을(를) 필수로 지정했지만, 이 마켓플레이스가 숨겨져 있어 아무것도 설치되지 않습니다. 소스에서
                다시 표시하세요.
              </>
            ),
            fix: <p><em>소스 보기</em> 로 소스 화면을 열고 그 소스를 다시 켭니다.</p>,
          },
          {
            tone: "warning",
            message: <>조직이 acme의 docs-search을(를) 필수로 지정했지만, 이 마켓플레이스 목록에 없습니다.</>,
            fix: <p>방금 게시되었을 수 있으니 <em>소스 새로 고침</em> 을 누르고, 그래도 없으면 관리자에게 알리세요.</p>,
          },
          {
            tone: "warning",
            message: <>조직이 acme의 docs-search을(를) 필수로 지정했지만, Ave 0.15.0 이상이 필요합니다.</>,
            fix: <p>Ave 를 업데이트하세요.</p>,
          },
          {
            tone: "warning",
            message: (
              <>
                조직이 acme의 docs-search을(를) 필수로 지정했지만, 아직 이 기기에 제공되는 릴리스가 없습니다: 릴리스가 단계적 배포로
                보류되었거나 사전 릴리스뿐입니다. 이 기기에 릴리스가 제공되면 설치할 수 있습니다.
              </>
            ),
          },
          {
            tone: "warning",
            message: <>조직이 acme의 docs-search을(를) 필수로 지정했지만, 이 마켓플레이스가 이 설치에 제공하는 릴리스가 없습니다.</>,
          },
          {
            tone: "warning",
            message: <>docs-search이(가) 대신 team-tools에서 설치되어 있어 필수 패키지 설치를 막을 수 있습니다.</>,
            fix: (
              <p>
                <em>team-tools에서 제거…</em> 는 먼저 묻습니다. “team-tools에서 설치된 docs-search을(를) 제거할까요? 조직이 요구하는
                패키지가 아닙니다. 제거해도 그 패키지가 설치되지는 않으며, corp에서 받을 수 있을 때까지 필수 요건은 충족되지 않은
                채로 남습니다.”
              </p>
            ),
          },
        ]}
      />
      <p>사용자가 할 수 있는 일이 없는 행에는 “해결되지 않으면 관리자에게 문의하세요.” 가 붙습니다.</p>

      <Callout tone="info" title="카드 자체에 문제가 있을 때">
        “마지막 확인을 끝내지 못해 목록이 최신이 아닐 수 있습니다. 한 시간 안에 다시 시도하며, 계속되면 Ave를 다시 시작하세요.”
        카드를 아예 불러오지 못하면 “지금은 업데이트를 확인할 수 없습니다. Ave를 다시 시작하고, 계속되면 세부 정보를 복사해 알려
        주세요.” 업데이트 기록을 잃어도 확인 시각만 초기화되고 설치된 패키지는 그대로입니다.
      </Callout>

      <PageNav />
    </article>
  );
}
