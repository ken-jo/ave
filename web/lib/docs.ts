import type { Locale } from "./i18n";

/**
 * The user guide. One template renders every page; each page is a list of
 * sections built from paragraphs, term lists, bullet lists, code and links
 * to other pages of the site.
 * Facts come from the app's docs and UI strings; when the app changes a
 * label, change it here too.
 */

export type Block =
  | { p: string }
  | { dl: [string, string][] }
  | { ul: string[] }
  | { code: string }
  /** A link to another page of this site, by its canonical (Korean, slashed) path. */
  | { link: { to: string; label: string } };

interface DocSection {
  id: string;
  h: string;
  blocks: Block[];
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  sections: DocSection[];
}

export const DOC_SLUGS = ["start", "models", "workbench", "permissions", "plugins", "marketplace", "automation", "data"] as const;
type DocSlug = (typeof DOC_SLUGS)[number];

const ko: Record<DocSlug, DocPage> = {
  start: {
    slug: "start",
    title: "설치와 첫 실행",
    summary: "지원하는 운영체제, 설치, 첫 대화까지.",
    sections: [
      {
        id: "platforms",
        h: "지원 환경",
        blocks: [
          { dl: [
            ["macOS", "Apple Silicon(arm64)만 지원합니다. Intel Mac은 지원하지 않습니다."],
            ["Windows", "Windows 10 이상, x64 설치 파일."],
            ["Linux", "x86_64 AppImage. 설치 없이 실행 권한만 주면 됩니다."],
          ] },
          { p: "지금 공개하는 빌드는 코드 서명과 공증을 거치지 않았습니다. 그래서 macOS는 처음 실행할 때 격리 표시를 지워야 하고, Windows는 SmartScreen 경고가 뜹니다. 운영체제별 단계는 내려받기 페이지에 있습니다." },
          { link: { to: "/download/", label: "운영체제별 설치 단계" } },
        ],
      },
      {
        id: "first-run",
        h: "처음 열면",
        blocks: [
          { p: "처음 실행하면 회의 플러그인과 로컬 인덱서 플러그인이 공식 마켓플레이스에서 함께 설치됩니다. 설치 상태는 시작 화면에 표시됩니다." },
          { p: "대화를 하려면 먼저 모델을 연결해야 합니다. 설정의 모델 탭에서 제공자를 추가하고 카드마다 저장한 뒤, 모델 선택에서 쓸 모델을 고르세요. 자세한 방법은 ‘모델과 로그인’에 있습니다." },
        ],
      },
      {
        id: "layout",
        h: "창 크기에 맞는 작업 화면",
        blocks: [
          { p: "창은 화면 중앙에 1243×768 크기로 열리고, 너비를 360px까지 줄일 수 있습니다. 공간이 충분하면 대화를 최대 네 칸으로 나누고, 좁아지면 초점이 있는 칸 하나를 보여 줍니다. 숨겨진 대화는 계속 실행되고, 다시 넓히면 기존 배치와 최대화 선택이 돌아옵니다." },
        ],
      },
      {
        id: "where",
        h: "데이터가 저장되는 곳",
        blocks: [
          { p: "Ave가 관리하는 데이터는 대부분 홈 폴더의 ~/.ave 아래에 있습니다(앱 설정 파일만 Electron 사용자 데이터 폴더에 있습니다). AVE_HOME 환경 변수로 다른 위치를 지정할 수 있습니다. 구성은 ‘데이터와 업데이트’에서 설명합니다." },
        ],
      },
    ],
  },
  models: {
    slug: "models",
    title: "모델과 로그인",
    summary: "API 키, 직접 띄운 서버, 구독을 연결하는 방법.",
    sections: [
      {
        id: "providers",
        h: "제공자 추가",
        blocks: [
          { p: "설정 → 모델에서 제공자 추가를 누르고, 카드마다 값을 넣은 뒤 저장합니다. 모델 선택은 하나이고 제공자별로 묶여 보입니다. 모델 목록은 제공자에게서 받아 캐시에 두고, 실행할 때 한 번 또는 새로고침을 누를 때 갱신합니다." },
          { dl: [
            ["기본 제공", "OpenAI, Claude, Gemini, OpenRouter, 그리고 OpenAI 호환 엔드포인트(직접 띄운 서버 포함)"],
            ["마켓플레이스 패키지", "그 밖의 제공자는 마켓플레이스의 제공자(provider) 패키지로 추가합니다."],
          ] },
        ],
      },
      {
        id: "openai-login",
        h: "OpenAI 로그인",
        blocks: [
          { p: "OpenAI는 세 가지로 연결합니다. 브라우저에서 로그인, 디바이스 코드 사용, API 키 대화 사용. 로그인 주소와 토큰은 설정 화면에 나타나지 않습니다." },
        ],
      },
      {
        id: "subscriptions",
        h: "구독으로 연결",
        blocks: [
          { dl: [
            ["ChatGPT 요금제", "내가 설치한 codex CLI를 Ave 전용 격리 폴더에서 실행해 로그인합니다. Ave에는 codex CLI가 들어 있지 않으며, 찾지 못하면 설정에서 공식 설치 방법을 안내합니다."],
            ["Claude 구독", "Ave가 자동으로 찾은 공식 claude CLI를 실행합니다. 앱 전용 설정 폴더를 쓰고, OAuth 토큰을 읽거나 API 키를 재사용하지 않습니다. CLI 자체 도구는 꺼지고 Ave의 도구만 MCP 브리지로 쓰입니다. 이 경로에서는 모델 선택과 이미지 첨부가 없습니다."],
          ] },
          { p: "구독 자격 증명은 API 키가 되지 않고, 경로 사이에서 몰래 다른 경로로 넘어가지 않습니다." },
        ],
      },
      {
        id: "fallback",
        h: "대체 체인과 추론",
        blocks: [
          { p: "대체 체인을 만들면 한 모델이 실패했을 때 다음 모델이 턴을 이어받습니다. 추론을 지원하는 모델은 확장 사고 설정으로 추론 수준을 정합니다." },
        ],
      },
    ],
  },
  workbench: {
    slug: "workbench",
    title: "작업 화면",
    summary: "칸, 입력창, 메시지 동작, 작업 패널, 사이드바.",
    sections: [
      {
        id: "tiles",
        h: "칸",
        blocks: [
          { p: "공간이 충분하면 최대 네 칸을 보여 주고, 캔버스가 좁아지면 초점이 있는 칸 하나를 보여 줍니다. 칸마다 자기 대화 루프를 갖고, 숨겨진 대화도 계속 답을 받습니다. 한 대화는 한 칸에만 열립니다. 사이드바에서 이미 열린 대화를 누르면 그 칸으로 초점이 옮겨 갑니다." },
          { p: "넓은 캔버스에서는 ‘좌우로 분할’과 ‘위아래로 분할’ 중에서 고릅니다. 나눈 칸이 최소 크기보다 작아지는 방향은 고를 수 없게 표시되고, 둘 다 안 되면 이유를 보여 줍니다. 좁은 캔버스에서는 분할, 닫기, 최대화, 새 칸 열기를 제공하지 않습니다." },
          { p: "칸 머리에는 대화 제목과 고정, 내보내기(Markdown 또는 JSON), 가져오기, 그리고 패널 분할, 이 패널만 보기, 패널 닫기가 있습니다." },
        ],
      },
      {
        id: "composer",
        h: "입력창",
        blocks: [
          { dl: [
            ["Enter", "답하는 중이면 메시지가 대기열에 들어갑니다. 진행 중인 턴이 다음 쉼표에서 받아 가고, 턴이 끝날 때 남은 것은 새 메시지로 보냅니다."],
            ["⌘ / Ctrl + Enter", "진행 중인 턴을 멈추고 바로 보냅니다."],
            ["거절된 전송", "호스트가 보내기를 거절하면 글과 첨부가 입력창으로 돌아오고, 이유가 표시됩니다."],
          ] },
          { p: "대기했다 보낸 메시지와 끼어든 메시지에는 표시가 붙고, 사용자가 멈춘 답에는 ‘사용자가 중지함’이 남습니다." },
        ],
      },
      {
        id: "messages",
        h: "메시지 동작",
        blocks: [
          { p: "내 메시지에 마우스를 올리면 편집, 포크, 여기로 돌아가기가 나옵니다. 여기로 돌아가기는 그 메시지 뒤를 대화, 대기열, 디스크의 세션에서 모두 지우고 글을 입력창에 돌려놓습니다. 아직 답이 나오는 중일 때는 쓸 수 없습니다." },
          { p: "체크포인트에서 갈라내기, 고쳐서 다시 보내기, 내보내기, 압축도 지원합니다. 대화가 길어지면 자동 압축이 문맥을 줄입니다. 에이전트가 물어볼 것이 있으면 질문 카드가 그 대화의 칸에 나타납니다." },
        ],
      },
      {
        id: "panel",
        h: "작업 패널",
        blocks: [
          { p: "파일, 미리보기, 브라우저, 터미널, 서브에이전트, 사이드 채팅이 칸 높이만큼의 카드 하나에 모입니다. 칸이 넓으면 대화 옆에 붙고, 좁으면 칸 안에서 대화 위에 뜹니다. 패널을 열어도 운영체제 창 크기는 바뀌지 않습니다." },
          { ul: [
            "브라우저 탭은 세션에서 다룬 웹 출처를 모으고, 요청한 것인지 결과로 받은 것인지 표시합니다.",
            "파일 탭은 세션의 파일과 그 파일에 한 일(읽음, 씀, 첨부, 도구)을 보여 줍니다.",
            "플러그인과 MCP 호출 횟수는 대화 기록에서 다시 계산하므로 새로 불러와도 유지됩니다.",
          ] },
        ],
      },
      {
        id: "sidebar",
        h: "사이드바",
        blocks: [
          { p: "접으면 아이콘 레일이 남습니다. 펼쳤을 때 공간이 충분하면 대화 영역을 밀고, 부족하면 그 위에 겹쳐집니다. 겹쳐진 사이드바는 Escape를 누르거나 바깥을 클릭해 접습니다." },
          { p: "채팅 목록에는 일반 대화, 루틴 실행, 작업 보드 실행, 그리고 시작한 대화 아래에 붙은 사이드 채팅이 함께 있습니다. 일반 대화 줄에서는 이름 바꾸기, 읽지 않음 표시, 읽음 표시, 보관, 공유, 복사, 삭제를 할 수 있습니다." },
          { p: "답하는 중인 대화에는 표시가 붙고, 내가 보지 않는 곳에서 끝난 턴은 확인할 때까지 읽지 않음으로 남습니다. 프로젝트 탭에서는 프로젝트를 고정, 편집, 보관, 제거합니다." },
        ],
      },
    ],
  },
  permissions: {
    slug: "permissions",
    title: "권한과 보안",
    summary: "권한 모드, 리뷰어, 허용 디렉터리, 샌드박스, 감사 로그.",
    sections: [
      {
        id: "modes",
        h: "권한 모드",
        blocks: [
          { dl: [
            ["쓰기만 확인", "기본값. 읽기는 허용하고 바꾸는 작업은 승인을 요청합니다."],
            ["모두 확인", "읽기를 포함한 모든 도구에 승인을 요청합니다."],
            ["자동 검증", "대화에서 저위험·중위험 판정은 감사 기록과 함께 자동 허용하고 고위험만 승인을 요청합니다. 헤드리스 실행은 별도의 실패 폐쇄형 리뷰 대기열을 씁니다."],
            ["모두 허용", "하드 차단 밖은 자동으로 허용합니다. 허용 디렉터리 밖 접근은 따로 승인을 받습니다."],
          ] },
          { p: "도구 호출은 읽기, 쓰기, 셸, 네트워크, 메타로 나뉘고, 위험도는 낮음, 중간, 높음입니다." },
        ],
      },
      {
        id: "order",
        h: "판정 순서",
        blocks: [
          { ul: [
            "하드 차단 규칙이 언제나 먼저 돕니다. 민감한 경로, 잘못된 매니페스트, 샌드박스 한계가 여기에 걸립니다.",
            "리뷰어 설정은 검증 끔(자동 통과), 규칙 기반 검증, LLM 검증, 엄격(모두 보류) 중 하나입니다. LLM 검증은 위험도를 올릴 수만 있고 낮추지 못합니다.",
            "리뷰어가 실패하면 통과가 아니라 보류입니다.",
            "헤드리스 실행에서 저위험이 아닌 요청은 나중에 처리할 대기열로 갑니다.",
          ] },
        ],
      },
      {
        id: "approve",
        h: "승인",
        blocks: [
          { p: "승인 요청은 화면 아래 독에 나타나고 대화를 가리지 않습니다. 버튼은 거절, 한 번만 허용, 항상 허용입니다. 항상 허용은 정확히 그 도구, 그 입력, 그 작업 폴더에만 묶입니다. 대상 이름에 와일드카드가 들어 있으면 규칙을 저장하지 않고 한 번만 허용을 권합니다." },
          { p: "플러그인이 제안한 대화(오버레이 제안)는 내가 받아들여야 시작되고, 그 안의 쓰기, 셸, 네트워크 도구는 다시 확인을 받습니다." },
        ],
      },
      {
        id: "directories",
        h: "허용 디렉터리와 민감한 경로",
        blocks: [
          { p: "허용 디렉터리는 프로젝트 루트, ~/.ave, 전용 임시 폴더, 시스템 임시 폴더(macOS와 Linux는 /tmp 포함)에서 시작하고, 설정의 permissions.additionalDirectories 로 넓힙니다. 그 밖에 접근하면 따로 승인을 받습니다." },
          { p: "~/.ssh 의 키, .env 파일 같은 민감한 경로는 어떤 모드에서도 막힙니다." },
          { p: "사용자와 관리자가 각각 policy.json 을 둘 수 있고, 올바른 관리자 정책이 있으면 사용자가 그 항목을 바꿀 수 없습니다." },
        ],
      },
      {
        id: "sandbox",
        h: "OS 샌드박스",
        blocks: [
          { p: "도구 실행을 운영체제 수준에서 가두는 선택 기능입니다. 기본값은 꺼짐이고, 켜면 다시 시작해야 합니다." },
          { dl: [
            ["macOS", "Seatbelt. 파일, 프로세스, 네트워크를 가둡니다."],
            ["Linux", "bwrap. 파일, 프로세스, 네트워크를 가둡니다."],
            ["Windows", "srt-win. 파일과 네트워크를 가두며, 프로세스 격리는 없습니다."],
          ] },
          { p: "켜져 있으면 네트워크는 기본 차단입니다. 플러그인끼리의 격리는 macOS와 Linux에서만 됩니다." },
        ],
      },
      {
        id: "audit",
        h: "감사 로그와 가림",
        blocks: [
          { p: "~/.ave/audit.log 는 HMAC 체인으로 이어져 있어 중간을 바꾸면 드러납니다. 감사 기록에는 비밀 값을 넣지 않습니다. API 키를 비롯한 자격 증명은 설정과 무관하게 항상 제거하고 보냅니다. 설정의 PII 리댁트(기본값 꺼짐)를 켜면 이메일, 전화번호, 카드 번호 같은 개인정보도 가려 보내고, 가린 개수가 감사 로그에 남습니다." },
        ],
      },
    ],
  },
  plugins: {
    slug: "plugins",
    title: "플러그인 설치와 격리",
    summary: "플러그인이 하는 일, 설치, 격리, 기본 플러그인.",
    sections: [
      {
        id: "what",
        h: "플러그인이란",
        blocks: [
          { p: "플러그인은 plugin.json 매니페스트가 있는 패키지입니다. 도구(MCP와 같은 모양), 화면 패널, 설정, 알림, 스킬, 이벤트를 선언합니다. 실행 방식은 둘 중 하나입니다." },
          { dl: [
            ["entry", "JavaScript 모듈입니다."],
            ["process", "어떤 언어로든 만든 프로그램이 표준 입출력의 JSON-RPC로 호스트와 대화합니다. OS 샌드박스가 켜져 있어야 실행되고, Windows에서는 지원하지 않습니다."],
          ] },
          { p: "현재 출시된 앱용 플러그인은 호스트 프로토콜 3과 최소 앱 버전 0.14.0을 선언합니다. 프로토콜 4는 아직 출시 전입니다. 출시 후에는 루프백 OAuth에 호스트가 발급한 state를 그대로 보내고 PKCE S256을 함께 사용해야 합니다. 새 프로토콜의 출시 전까지 배포 패키지는 프로토콜 3을 유지하세요. 설치된 플러그인은 ~/.ave/plugins/<id>/ 에 있고, 켜진 목록은 registry.json 이 정합니다." },
        ],
      },
      {
        id: "install",
        h: "설치",
        blocks: [
          { p: "마켓플레이스 탭이나 링크로 설치합니다. 링크는 확인 화면만 열고, 설치는 내가 확인한 다음에 일어납니다." },
          { code: "ave://install/<kind>/<name>@<source>\nave://uninstall/<kind>/<name>@<source>\nave://marketplace/add?url=<repository>" },
          { p: "개발 중인 플러그인은 패키징하지 않은 빌드를 AVE_DEV=1 로 실행한 뒤 설정 → 확장 설정 → 개발자 도구 → 로컬 폴더에서 설치로 올립니다." },
        ],
      },
      {
        id: "isolation",
        h: "격리와 네트워크",
        blocks: [
          { ul: [
            "플러그인은 앱 밖의 별도 프로세스에서 돌고, 샌드박스가 켜져 있으면 그 안에서 돕니다.",
            "위험도는 호출마다 호스트가 매기고, 플러그인이 낮출 수 없습니다.",
            "네트워크는 networkAccess.allowedDomains 에 선언한 도메인(최대 16개)으로만 나갑니다. 호스트가 한 번에 한 홉씩 보내고 리디렉션마다 다시 검사합니다.",
            "하나가 시작에 실패해도 나머지 플러그인은 계속 일하고, 실패한 플러그인을 부르면 실제 이유를 돌려줍니다.",
          ] },
        ],
      },
      {
        id: "default",
        h: "기본 플러그인",
        blocks: [
          { dl: [
            ["로컬 인덱서", "문서를 색인하고, 키워드(BM25)와 벡터 검색 결과를 순위 융합(RRF)으로 합쳐 대화에 가져옵니다. 플러그인 데이터는 ~/.ave/plugins/<id>/data 에 있습니다."],
            ["회의", "마이크와 시스템 소리는 호스트가 받아 넘기고, 플러그인이 회의, 받아쓰기, 요약을 맡습니다."],
          ] },
        ],
      },
      {
        id: "alerts",
        h: "알림과 제안",
        blocks: [
          { p: "플러그인이 선언한 알림 종류는 설치할 때 플러그인이 정한 기본값으로 켜지거나 꺼지고, 종류마다 끌 수 있으며, 재알림 간격과 횟수 제한이 있습니다. 카드나 OS 알림으로 나타납니다. host:overlay 권한이 있는 플러그인은 대화를 제안할 수 있지만, 제안은 내가 받아들일 때까지 시작되지 않습니다." },
        ],
      },
    ],
  },
  marketplace: {
    slug: "marketplace",
    title: "마켓플레이스",
    summary: "git 저장소 마켓플레이스, 소스, 무결성, 업데이트, 회수.",
    sections: [
      {
        id: "repo",
        h: "git 저장소 하나",
        blocks: [
          { p: "마켓플레이스는 marketplace.json(schemaVersion 2)이 든 git 저장소입니다. 플러그인, MCP 서버, 스킬, 에이전트, 테마, 글꼴, 언어, 모델 제공자, 메시징 연결을 담을 수 있습니다." },
        ],
      },
      {
        id: "sources",
        h: "소스",
        blocks: [
          { dl: [
            ["공식", "Ave에 들어 있는 소스입니다. 호스트 비밀 값 권한을 받을 수 있는 유일한 소스입니다."],
            ["관리", "기기 정책 파일의 marketplaces.additional 로 조직이 추가합니다."],
            ["사용자 지정", "설정 → 마켓플레이스 → 추가."],
            ["직접", "git 폴더 하나를 패키지 하나로 받습니다."],
          ] },
          { p: "로컬 폴더도 소스로 쓸 수 있습니다." },
        ],
      },
      {
        id: "integrity",
        h: "무결성",
        blocks: [
          { p: "설치는 동기화한 커밋에 고정되고, 받은 산출물은 SHA-256으로 고정됩니다. 설치할 때 파일마다 SHA-256을 적은 영수증을 남기고, 앱이 시작할 때 다시 확인합니다. 맞지 않으면 그 플러그인은 올라오지 않습니다." },
          { p: "평문 http 주소나 내부망 주소는 한 번 확인을 받고, 메타데이터 주소처럼 위험한 주소는 언제나 거부합니다." },
        ],
      },
      {
        id: "updates",
        h: "업데이트",
        blocks: [
          { p: "새 버전은 부팅 때와 정해진 간격으로 확인하고, 적용은 대화가 쉬고 있을 때 한 번에 하나씩 합니다. 자동 적용은 모든 조건이 맞을 때만 일어납니다. 예를 들어 패키지가 켜져 있고, 업그레이드이고, 건너뛴 버전이 아니고, 세 번 실패하지 않았고, 권한·MCP 서버·훅이 승인한 그대로이고, 자동 업데이트 스위치가 켜져 있어야 합니다. 하나라도 어긋나면 검토나 수동 업데이트로 남습니다. 조직이 필수로 지정한 설치는 이 스위치와 상관없이 적용됩니다." },
          { p: "배포자는 버전을 숨기거나(yank), 일부에게만 먼저 내보낼 수 있고, 사용자는 canaryOptIn 설정으로 카나리 버전을 받겠다고 고를 수 있습니다." },
        ],
      },
      {
        id: "revocations",
        h: "회수",
        blocks: [
          { p: "소스는 policy/revocations.json 으로 특정 버전을 끄거나(disable) 지울(uninstall) 수 있습니다. 회수는 그 소스에서 설치한 것에만 적용됩니다." },
        ],
      },
      {
        id: "orgs",
        h: "조직에서 쓰기",
        blocks: [
          { p: "정책 파일로 허용·차단 목록, 기본 설치(defaultInstalls), 필수 설치(requiredInstalls)를 정합니다. 필수 설치 패키지는 지우거나 끌 수 없습니다." },
        ],
      },
    ],
  },
  automation: {
    slug: "automation",
    title: "루틴과 에이전트",
    summary: "루틴, 서브에이전트, 스킬, MCP, 훅, 기억, 원격 대화.",
    sections: [
      {
        id: "routines",
        h: "루틴",
        blocks: [
          { p: "루틴은 일정에 맞춰, 또는 앱을 끌 때 실행됩니다. 반복은 한 번, 매일, 매주, 매월, 일정 간격, cron 식 중에서 고릅니다." },
          { ul: [
            "실행마다 따로 대화 루프가 돌고, 그 결과는 채팅 목록에 세션으로 남습니다.",
            "루틴마다 쓸 수 있는 플러그인과 폴더를 정합니다.",
            "헤드리스로 돌기 때문에 저위험이 아닌 승인은 대기열에서 나를 기다립니다.",
            "필요한 플러그인이 없으면 실행을 건너뛰거나 확인이 필요하다고 표시합니다.",
          ] },
        ],
      },
      {
        id: "subagents",
        h: "서브에이전트와 사이드 채팅",
        blocks: [
          { p: "에이전트는 하위 에이전트를 한 단계 깊이까지 띄웁니다. 하위 에이전트는 작업 패널의 서브에이전트 탭에 보입니다." },
          { dl: [
            ["agent_send", "하위에서 부모나 형제에게 보냅니다."],
            ["agent_guide", "부모가 하위에게 방향을 줍니다."],
            ["agent_spawn(resumeId)", "멈춘 하위 에이전트를 다시 이어 갑니다."],
          ] },
          { p: "우편함은 디스크에 남습니다. 사이드 채팅은 작업 패널의 탭에서 여는 별도 대화로, 사이드바에서 시작한 대화 아래에 붙습니다." },
        ],
      },
      {
        id: "skills",
        h: "스킬",
        blocks: [
          { p: "스킬은 이름, 설명, 트리거만 프롬프트에 두고, 본문은 skill_load 로 필요할 때 불러옵니다. 처음 불러올 때는 승인을 받고, 승인은 내용의 SHA-256에 묶입니다. 스킬은 ~/.ave/skills 에 있습니다." },
        ],
      },
      {
        id: "mcp",
        h: "MCP",
        blocks: [
          { p: "MCP 서버를 연결하고, Claude Desktop 설정을 가져올 수 있습니다. ui:// 카드를 쓰는 MCP 앱은 대화 안에 대화형 카드로 나타납니다. MCP 도구와 플러그인 도구는 같은 권한 경로를 지납니다." },
        ],
      },
      {
        id: "hooks",
        h: "훅",
        blocks: [
          { p: "pre-*.sh 는 PreToolUse, post-*.sh 는 PostToolUse, perm-*.sh 는 PermissionRequest 에 연결되는 셸 스크립트입니다. 그 밖의 이벤트는 신뢰 확인을 거친 hooks.json 설정으로만 연결합니다." },
          { code: "PreToolUse  PostToolUse  PostToolUseFailure\nPermissionRequest  PermissionDenied\nUserPromptSubmit  SessionStart  Stop\nPreCompact  PostCompact" },
        ],
      },
      {
        id: "memory",
        h: "기억과 원격 대화",
        blocks: [
          { p: "기억은 호스트가 프로젝트별로 관리하고, 프로젝트의 AGENTS.md 를 합쳐 읽습니다." },
          { p: "텔레그램 브리지는 개인 대화방 하나를 Ave의 대화 하나에 연결합니다. 기본값은 꺼짐이고, 설정 → 연결 → 원격 표면에서 켭니다." },
        ],
      },
    ],
  },
  data: {
    slug: "data",
    title: "데이터와 업데이트",
    summary: "~/.ave 구성, 앱 업데이트, 서명 없는 빌드, 앱이 스스로 여는 연결.",
    sections: [
      {
        id: "layout",
        h: "~/.ave",
        blocks: [
          { p: "맨 위에는 여러 기능이 함께 쓰는 것만 있습니다. 나머지는 기능마다 자기 폴더를 가지므로, 한 기능을 폴더 하나로 백업하거나 지울 수 있습니다." },
          { dl: [
            ["settings.json", "권한 설정(허용 디렉터리 등). 앱 설정은 Electron 사용자 데이터 폴더의 ave-settings.json 에 있습니다."],
            ["audit.log", "HMAC 체인 감사 로그"],
            ["secrets/", "비밀 값"],
            ["plugins/", "설치한 플러그인과 registry.json"],
            ["skills/", "스킬과 승인 기록"],
            ["sessions/", "대화 세션"],
          ] },
          { p: "위치는 AVE_HOME 환경 변수로 바꿀 수 있습니다." },
        ],
      },
      {
        id: "updates",
        h: "앱 업데이트",
        blocks: [
          { ul: [
            "낮은 버전으로 내려가는 업데이트는 하지 않습니다.",
            "특정 버전은 건너뛸 수 있습니다.",
            "플러그인을 설치하는 중에는 적용하지 않고, 설치 전에 확인을 받습니다.",
          ] },
          { p: "서명 없는 Mac 빌드는 스스로 교체할 수 없습니다. 업데이트를 적용하려 하면 Ave가 이 사이트의 첫 화면을 엽니다. 그곳의 다운로드에서 새 DMG를 받아 앱을 바꾸고 격리 표시를 다시 지우면 됩니다." },
          { link: { to: "/download/", label: "운영체제별 설치 단계" } },
        ],
      },
      {
        id: "unsigned",
        h: "서명 없는 빌드",
        blocks: [
          { p: "지금 공개 빌드는 코드 서명과 공증을 거치지 않습니다. Windows에서는 ‘알 수 없는 게시자’와 SmartScreen 경고가, macOS에서는 Gatekeeper 차단이 나타납니다. 내려받기는 downloads.agent-connector.ai 에서만 하세요." },
        ],
      },
      {
        id: "outbound",
        h: "앱이 스스로 여는 외부 연결",
        blocks: [
          { p: "내가 연결한 제공자, 플러그인, 서버 말고도 앱이 스스로 여는 연결이 몇 가지 있습니다. 업데이트 확인, 이 사이트의 서비스 문서, 그리고 기본으로 켜져 있는 모델 카탈로그 갱신입니다. 이 고정된 출처들은 플러그인에게 추가 접근을 주지 않습니다." },
          { p: "모델 카탈로그 갱신은 컨텍스트 창과 출력 한도 정보를 models.dev 에서 받습니다. 공급자 응답과 사용자 설정도 실제 한도를 정합니다. 사용량의 비용 계산은 기존 단가표와 사용자 단가 설정을 따릅니다." },
          { dl: [
            ["접속 대상", "공개 문서 https://models.dev/api.json 만 요청합니다. 일반 앱은 실행할 때와 매시간 확인하되 하루에 많아야 한 번 요청하고, 실패한 시도도 이 간격에 들어갑니다. 헤드리스 실행은 갱신 요청을 보내지 않습니다."],
            ["보내는 것", "Accept: application/json 을 담은 GET 요청이며, 이전 ETag가 있으면 If-None-Match 에 넣습니다. 계정, API 키, 세션 인증, 쿠키, 프롬프트, 파일, 대화는 보내지 않습니다. 서버는 IP 주소와 사용자 에이전트, 언어 헤더 같은 일반 전송 헤더를 볼 수 있습니다."],
            ["검사 방식", "호스트의 공개 주소 보호 경로가 내부 주소를 거부하고, 리다이렉트는 거부합니다. 인증서 오류가 나도 평문 HTTP로 다시 시도하지 않습니다. 헤더와 본문을 합쳐 15초 안에 받아야 하고, 압축을 푼 본문은 16 MB(16,777,216바이트)로 제한합니다. 유효하지 않은 다운로드는 쓰던 카탈로그를 그대로 둡니다. 다음 실행에서는 번들보다 오래되지 않은 검증된 캐시를, 없으면 번들을 씁니다. 명시적으로 고정한 카탈로그가 있으면 그것이 먼저입니다."],
            ["캐시", "검증한 사본은 내 컴퓨터에 둡니다. 현재 사본과 직전 정상 사본을 포함해 카탈로그 파일을 최대 다섯 개 유지합니다. 오래된 해시 사본은 정리될 수 있으니 오래 재현하려면 별도 파일을 보관하고 절대 경로로 고정하세요. 쓸 수 없는 명시적 고정값은 앱 시작을 막습니다."],
            ["끄는 방법", "설정 → 모델 → 모델 카탈로그에서 ‘카탈로그 매일 갱신’을 끕니다. 관리자는 시스템 정책 파일에 { \"modelCatalog\": { \"refresh\": \"off\" } } 를 두어 끌 수 있고, 정책 파일이 손상되거나 읽히지 않아도 갱신은 꺼집니다. 실행 스크립트에서 AVE_MODEL_CATALOG 를 bundled, 보관 중인 사본의 sha256, 또는 카탈로그 파일의 절대 경로로 고정해도 꺼집니다."],
          ] },
        ],
      },
      {
        id: "service",
        h: "앱이 이 사이트에서 읽는 것",
        blocks: [
          { p: "Ave는 이 사이트의 /.well-known/ave-service.json 을 읽어 공지가 있는지, 서비스 주소가 옮겨졌는지를 확인합니다. 공지는 /announcements/v1.json 에 있습니다." },
        ],
      },
    ],
  },
};

const en: Record<DocSlug, DocPage> = {
  start: {
    slug: "start",
    title: "Install and first run",
    summary: "Supported systems, installing, and your first conversation.",
    sections: [
      {
        id: "platforms",
        h: "Supported systems",
        blocks: [
          { dl: [
            ["macOS", "Apple Silicon (arm64) only. Intel Macs are not supported."],
            ["Windows", "Windows 10 or later, x64 installer."],
            ["Linux", "x86_64 AppImage. No installation; make it executable and run it."],
          ] },
          { p: "Public builds are currently not code-signed or notarised. On macOS you clear the quarantine flag before the first launch; on Windows SmartScreen shows a warning. The steps for each system are on the download page." },
          { link: { to: "/download/", label: "Install steps for each system" } },
        ],
      },
      {
        id: "first-run",
        h: "On first launch",
        blocks: [
          { p: "The meeting plugin and the local indexer plugin are installed from the official marketplace on first run. The start screen shows their progress." },
          { p: "Before you can chat, connect a model. In Settings → Model, add a provider, save each card, then pick a model in the model chooser. Models and sign-in has the details." },
        ],
      },
      {
        id: "layout",
        h: "A workspace that fits the window",
        blocks: [
          { p: "The window opens centered at 1243×768 and can shrink to 360px wide. When there is room, the canvas holds up to four conversation tiles; when narrow, it shows the focused tile. Hidden conversations keep running, and widening restores the layout and your maximized choice." },
        ],
      },
      {
        id: "where",
        h: "Where your data lives",
        blocks: [
          { p: "Most of what Ave keeps is under ~/.ave in your home folder; only the app settings file sits in Electron’s user-data folder. Set the AVE_HOME environment variable to use another location. Data and updates explains the layout." },
        ],
      },
    ],
  },
  models: {
    slug: "models",
    title: "Models and sign-in",
    summary: "Connect an API key, a server you run, or a subscription.",
    sections: [
      {
        id: "providers",
        h: "Adding a provider",
        blocks: [
          { p: "In Settings → Model, choose Add provider, fill in each card and save it. There is one model chooser, grouped by provider. The model list is fetched from the provider, cached, and refreshed once per run or when you press refresh." },
          { dl: [
            ["Built in", "OpenAI, Claude, Gemini, OpenRouter, and any OpenAI-compatible endpoint, including one you run yourself"],
            ["Marketplace packages", "Other providers are added as provider packages from a marketplace."],
          ] },
        ],
      },
      {
        id: "openai-login",
        h: "Signing in to OpenAI",
        blocks: [
          { p: "OpenAI offers three ways in: Sign in in browser, Use device code, and Use API-key chat. Sign-in URLs and tokens never appear on the settings page." },
        ],
      },
      {
        id: "subscriptions",
        h: "Using a subscription",
        blocks: [
          { dl: [
            ["ChatGPT plan", "Sign in through the codex CLI you installed, run in an Ave-only isolated folder. Ave does not ship the CLI; if it is not found, Settings shows the official install methods."],
            ["Claude subscription", "Ave launches the official claude CLI Ave discovers automatically. It uses an app-owned config folder and never reads OAuth tokens or reuses API keys. The CLI’s own tools are off; only Ave’s tools are offered, through its MCP bridge. This route has no model choice and no image attachments."],
          ] },
          { p: "Subscription credentials never become API keys, and there is no silent fallback from one route to another." },
        ],
      },
      {
        id: "fallback",
        h: "Fallback and reasoning",
        blocks: [
          { p: "With a fallback chain, the next model takes over a turn when one fails. For models that reason, Extended Thinking sets the reasoning level." },
        ],
      },
    ],
  },
  workbench: {
    slug: "workbench",
    title: "The workbench",
    summary: "Tiles, the composer, message actions, the work panel and the sidebar.",
    sections: [
      {
        id: "tiles",
        h: "Tiles",
        blocks: [
          { p: "The canvas shows up to four tiles when there is room and the focused tile when narrow. Each tile runs its own conversation loop, including while hidden. A conversation is open in one tile at most; choosing it in the sidebar focuses the tile that already holds it." },
          { p: "On a wide canvas, splitting offers Side by side or Top and bottom. A direction that would make a tile too small is shown as unavailable, and if neither fits, Ave says why. A narrow canvas disables split, close, maximize and new-pane controls." },
          { p: "A tile’s header carries the conversation title, then pin, export (Markdown or JSON) and import, then Split pane, Show only this pane and Close pane." },
        ],
      },
      {
        id: "composer",
        h: "The composer",
        blocks: [
          { dl: [
            ["Enter", "While a turn is running, the message joins the queue. The turn picks it up at its next brake point; anything still waiting when the turn ends is sent as a new message."],
            ["⌘ / Ctrl + Enter", "Stops the running turn and sends now."],
            ["A refused send", "If the host refuses a send, your text and attachments come back to the composer with the reason."],
          ] },
          { p: "Queued and interrupting messages are labelled in the transcript, and an answer you stopped keeps a “stopped by user” badge." },
        ],
      },
      {
        id: "messages",
        h: "Message actions",
        blocks: [
          { p: "Hover your own message for Edit, Fork and Return here. Return here removes everything after that message, from the transcript, the queue and the session on disk, and puts its text back in the composer. It is offered only when no turn is still producing output." },
          { p: "You can also branch from a checkpoint, edit and resend, export and compact. Long conversations are compacted automatically. When the agent needs an answer from you, a question card appears in that conversation’s tile." },
        ],
      },
      {
        id: "panel",
        h: "The work panel",
        blocks: [
          { p: "Files, Preview, Browser, Terminal, Sub-agents and Side chat share one card that stands the full height of its tile, docked beside the transcript when there’s room and floating over it inside the tile when there isn’t. Opening a panel never changes the OS window size." },
          { ul: [
            "The Browser tab lists the session’s web sources and marks each as requested or returned in a result.",
            "The Files tab lists the session’s files with what was done to each: read, written, attached or tool.",
            "Plugin and MCP call counts are rebuilt from the transcript, so they survive a reload.",
          ] },
        ],
      },
      {
        id: "sidebar",
        h: "The sidebar",
        blocks: [
          { p: "Collapsing leaves an icon rail. An expanded sidebar pushes the canvas when there is room and overlays it when there is not. Press Escape or click outside to collapse the overlay." },
          { p: "The Chats list holds main conversations, routine runs, work-board runs, and side chats nested under the conversation they came from. Main conversation rows offer rename, mark unread, mark read, archive, share, copy and delete." },
          { p: "A conversation that is responding shows it, and a turn that finishes where you aren’t looking stays unread until you look. The Projects tab pins, edits, archives and removes projects." },
        ],
      },
    ],
  },
  permissions: {
    slug: "permissions",
    title: "Permissions and security",
    summary: "Permission modes, the reviewer, allowed folders, the sandbox, the audit log.",
    sections: [
      {
        id: "modes",
        h: "Permission modes",
        blocks: [
          { dl: [
            ["Confirm writes", "The default. Reads are allowed; operations that change something ask for approval."],
            ["Confirm all", "Every tool asks for approval, reads included."],
            ["Auto-verify", "In chat, low- and medium-risk verdicts are allowed automatically with an audit trail, and high risk asks. Headless runs use a separate fail-closed reviewer queue."],
            ["Allow all", "Everything outside the hard blocks is allowed. Access outside the allowed folders still needs its own approval."],
          ] },
          { p: "Tool calls fall into read, write, shell, network and meta. Risk is low, medium or high." },
        ],
      },
      {
        id: "order",
        h: "How a request is decided",
        blocks: [
          { ul: [
            "Hard-deny rules always run first: sensitive paths, invalid manifests and sandbox limits.",
            "The reviewer is one of Validation off (auto-pass), Rule-based validation, LLM validation, or Strict (all pending). LLM validation can raise a risk rating, never lower it.",
            "If the reviewer fails, the request is held, not passed.",
            "In headless runs, anything above low risk goes to a deferred queue.",
          ] },
        ],
      },
      {
        id: "approve",
        h: "Approving",
        blocks: [
          { p: "Requests appear in a dock at the bottom of the window that does not cover the conversation. The buttons are Reject, Allow once and Always allow. Always allow is bound to the exact tool, input and working folder; if the target name contains a wildcard, Ave won’t save the rule and suggests Allow once instead." },
          { p: "A conversation a plugin proposes (an overlay suggestion) starts only when you accept it, and write, shell and network tools inside it ask again." },
        ],
      },
      {
        id: "directories",
        h: "Allowed folders and sensitive paths",
        blocks: [
          { p: "Allowed folders start with the project root, ~/.ave, a private scratch folder and the system temporary folder (plus /tmp on macOS and Linux), and grow through permissions.additionalDirectories in settings. Anything outside them asks separately." },
          { p: "Sensitive paths, such as keys under ~/.ssh and .env files, are blocked in every mode." },
          { p: "Users and administrators can each keep a policy.json. A valid administrator policy locks the settings it covers." },
        ],
      },
      {
        id: "sandbox",
        h: "The OS sandbox",
        blocks: [
          { p: "An opt-in feature that confines tool execution at the operating-system level. It is off by default, and turning it on needs a restart." },
          { dl: [
            ["macOS", "Seatbelt. Confines files, processes and network."],
            ["Linux", "bwrap. Confines files, processes and network."],
            ["Windows", "srt-win. Confines files and network, not processes."],
          ] },
          { p: "With the sandbox on, network is denied by default. Isolation between plugins is available on macOS and Linux only." },
        ],
      },
      {
        id: "audit",
        h: "Audit log and masking",
        blocks: [
          { p: "~/.ave/audit.log is HMAC-chained, so a change in the middle shows. Audit records never contain raw secrets. API keys and other credentials are always removed before anything is sent, whatever the settings say. Turn on PII Redaction in settings (off by default) and personal data such as email addresses, phone numbers and card numbers is masked too, with the count recorded in the audit log." },
        ],
      },
    ],
  },
  plugins: {
    slug: "plugins",
    title: "Installing and isolating plugins",
    summary: "What plugins do, installing them, isolation, and the default plugins.",
    sections: [
      {
        id: "what",
        h: "What a plugin is",
        blocks: [
          { p: "A plugin is a package with a plugin.json manifest. It declares tools (shaped like MCP tools), UI panels, settings, alerts, skills and events, and runs in one of two ways." },
          { dl: [
            ["entry", "A JavaScript module."],
            ["process", "A program in any language that talks to the host over JSON-RPC on standard input and output. It runs only with the OS sandbox on and is not supported on Windows."],
          ] },
          { p: "Plugins for released hosts currently declare host protocol 3 and minimum app version 0.14.0. Protocol 4 is upcoming and unreleased: after it ships, loopback OAuth must send the host-issued state unchanged together with PKCE S256. Keep published packages on protocol 3 until that release. Installed plugins live in ~/.ave/plugins/<id>/, and registry.json decides which are active." },
        ],
      },
      {
        id: "install",
        h: "Installing",
        blocks: [
          { p: "Install from the Marketplace tab or from a link. A link only opens a confirmation screen; nothing installs until you confirm." },
          { code: "ave://install/<kind>/<name>@<source>\nave://uninstall/<kind>/<name>@<source>\nave://marketplace/add?url=<repository>" },
          { p: "For a plugin you are building, run an unpackaged build with AVE_DEV=1 and choose Settings → Extension Settings → Developer tools → Install from local folder." },
        ],
      },
      {
        id: "isolation",
        h: "Isolation and network",
        blocks: [
          { ul: [
            "Plugins run in their own processes outside the app, and inside the sandbox when it is on.",
            "The host rates the risk of every call, and a plugin cannot lower it.",
            "Network goes only to the domains declared in networkAccess.allowedDomains, sixteen at most. The host sends one hop at a time and checks every redirect.",
            "If one plugin fails to start, the others keep working, and calls to the failed one return the real reason.",
          ] },
        ],
      },
      {
        id: "default",
        h: "Default plugins",
        blocks: [
          { dl: [
            ["Local indexer", "Indexes your documents and merges keyword (BM25) and vector results by reciprocal rank fusion before they reach the conversation. Plugin data lives in ~/.ave/plugins/<id>/data."],
            ["Meeting", "The host captures microphone and system audio and hands it over; the plugin runs the meeting, the transcript and the summary."],
          ] },
        ],
      },
      {
        id: "alerts",
        h: "Alerts and suggestions",
        blocks: [
          { p: "Each alert kind a plugin declares starts on or off at install as the plugin chooses, and you can switch each kind off; alerts keep to cooldowns and rate limits and arrive as cards or OS notifications. A plugin with the host:overlay capability can suggest a conversation, but it does not start until you accept it." },
        ],
      },
    ],
  },
  marketplace: {
    slug: "marketplace",
    title: "Marketplace",
    summary: "Git marketplaces, sources, integrity, updates and recalls.",
    sections: [
      {
        id: "repo",
        h: "One git repository",
        blocks: [
          { p: "A marketplace is a git repository with a marketplace.json (schemaVersion 2). It can carry plugins, MCP servers, skills, agents, themes, fonts, languages, model providers and messaging connections." },
        ],
      },
      {
        id: "sources",
        h: "Sources",
        blocks: [
          { dl: [
            ["Official", "Built into Ave. The only source whose plugins can be granted host secrets."],
            ["Managed", "Added by an organisation through marketplaces.additional in the machine policy file."],
            ["Custom", "Settings → Marketplace → Add."],
            ["Direct", "One git folder, installed as one package."],
          ] },
          { p: "A local folder can also be a source." },
        ],
      },
      {
        id: "integrity",
        h: "Integrity",
        blocks: [
          { p: "Installs pin the synced commit, and artifacts are pinned by SHA-256. Each install writes a receipt with a SHA-256 per file, which is checked again at launch. A plugin that doesn’t match is not loaded." },
          { p: "Plain http and internal-network addresses ask once; metadata and other unsafe addresses are always refused." },
        ],
      },
      {
        id: "updates",
        h: "Updates",
        blocks: [
          { p: "New versions are checked at launch and on a schedule, and applied one at a time while the conversation is idle. An update applies by itself only when every condition holds; among them: the package is enabled, it is an upgrade, the version is not skipped, it has not failed three times, permissions, MCP servers and hooks match what you approved, and the auto-update switch is on. Otherwise it stays for your review or a manual update. An install the organisation marks as required applies regardless of the switches." },
          { p: "Publishers can yank a version or roll out to a share of installs first, and you can opt into canary versions with the canaryOptIn setting." },
        ],
      },
      {
        id: "revocations",
        h: "Recalls",
        blocks: [
          { p: "A source can disable or uninstall a specific version through policy/revocations.json. A recall applies only to installs from that source." },
        ],
      },
      {
        id: "orgs",
        h: "For organisations",
        blocks: [
          { p: "A policy file sets allow and block lists, default installs (defaultInstalls) and required installs (requiredInstalls). A required package cannot be uninstalled or disabled." },
        ],
      },
    ],
  },
  automation: {
    slug: "automation",
    title: "Routines and agents",
    summary: "Routines, sub-agents, skills, MCP, hooks, memory and remote chat.",
    sections: [
      {
        id: "routines",
        h: "Routines",
        blocks: [
          { p: "Routines run on a schedule or when the app shuts down. Repeat once, daily, weekly, monthly, on an interval, or on a cron expression." },
          { ul: [
            "Each run has its own conversation loop and appears as a session in the chat list.",
            "Each routine has its own list of allowed plugins and folders.",
            "Runs are headless, so approvals above low risk wait for you in the queue.",
            "If a plugin it needs is missing, the run is skipped or marked as needing attention.",
          ] },
        ],
      },
      {
        id: "subagents",
        h: "Sub-agents and side chat",
        blocks: [
          { p: "An agent can start sub-agents one level deep. They appear in the Sub-agents tab of the work panel." },
          { dl: [
            ["agent_send", "From a sub-agent to its parent or a sibling."],
            ["agent_guide", "From the parent to a sub-agent."],
            ["agent_spawn(resumeId)", "Resumes a paused sub-agent."],
          ] },
          { p: "Mailboxes are kept on disk. Side chat is a separate conversation opened from a work-panel tab and nested under its parent in the sidebar." },
        ],
      },
      {
        id: "skills",
        h: "Skills",
        blocks: [
          { p: "Only a skill’s name, description and triggers sit in the prompt; the body is loaded on demand with skill_load. The first load asks for approval, and the approval is bound to the content’s SHA-256. Skills live in ~/.ave/skills." },
        ],
      },
      {
        id: "mcp",
        h: "MCP",
        blocks: [
          { p: "Connect MCP servers or import a Claude Desktop configuration. MCP apps that use ui:// cards appear as interactive cards in the conversation. MCP tools and plugin tools share one permission path." },
        ],
      },
      {
        id: "hooks",
        h: "Hooks",
        blocks: [
          { p: "Shell scripts named pre-*.sh, post-*.sh and perm-*.sh run on PreToolUse, PostToolUse and PermissionRequest. The other events are reached only through a hooks.json configuration you have trusted." },
          { code: "PreToolUse  PostToolUse  PostToolUseFailure\nPermissionRequest  PermissionDenied\nUserPromptSubmit  SessionStart  Stop\nPreCompact  PostCompact" },
        ],
      },
      {
        id: "memory",
        h: "Memory and remote chat",
        blocks: [
          { p: "Memory is kept by the host, per project, and merges the project’s AGENTS.md." },
          { p: "The Telegram bridge pairs one private chat with one Ave conversation. It is off by default; turn it on in Settings → Connections → Remote surfaces." },
        ],
      },
    ],
  },
  data: {
    slug: "data",
    title: "Data and updates",
    summary: "The ~/.ave layout, app updates, unsigned builds and the connections the app opens itself.",
    sections: [
      {
        id: "layout",
        h: "~/.ave",
        blocks: [
          { p: "Only what several features share sits at the top. Everything else lives in a folder per feature, so one feature can be backed up or cleared as one folder." },
          { dl: [
            ["settings.json", "Permission settings, such as allowed folders. App settings live in ave-settings.json in Electron’s user-data folder."],
            ["audit.log", "The HMAC-chained audit log"],
            ["secrets/", "Secret values"],
            ["plugins/", "Installed plugins and registry.json"],
            ["skills/", "Skills and their approvals"],
            ["sessions/", "Conversation sessions"],
          ] },
          { p: "Set AVE_HOME to move it." },
        ],
      },
      {
        id: "updates",
        h: "App updates",
        blocks: [
          { ul: [
            "Ave never offers an older version as an update.",
            "You can skip a specific version.",
            "An update is not applied while a plugin is installing, and Ave asks before installing it.",
          ] },
          { p: "An unsigned Mac build cannot replace itself. When you apply an update, Ave opens this site’s home page: download the new DMG there, replace the app, and clear the quarantine flag again." },
          { link: { to: "/download/", label: "Install steps for each system" } },
        ],
      },
      {
        id: "unsigned",
        h: "Unsigned builds",
        blocks: [
          { p: "Public builds are currently not code-signed or notarised. Windows shows “Unknown publisher” and a SmartScreen warning; macOS shows a Gatekeeper block. Download only from downloads.agent-connector.ai." },
        ],
      },
      {
        id: "outbound",
        h: "Connections the app opens by itself",
        blocks: [
          { p: "Besides the providers, plugins and servers you connect, the app opens a few connections of its own: the update check, this site’s service document, and the model catalog refresh, which is on by default. These fixed sources grant plugins no additional access." },
          { p: "The model catalog refresh fetches context-window and output-limit metadata from models.dev. Endpoint reports and your settings also determine the effective limits. Usage pricing still uses the app’s existing price table and your overrides." },
          { dl: [
            ["Where", "Only https://models.dev/api.json, a public document. The interactive app checks at launch and hourly, but requests at most once a day; failed attempts count too. Headless runs send no refresh request."],
            ["What is sent", "A GET with Accept: application/json and, when available, the previous ETag in If-None-Match. It carries no account, API key, session authentication, cookie, prompt, file or conversation. The server sees your IP address and ordinary transport headers, including the user agent and language header."],
            ["How it is checked", "The host’s public-address guard refuses internal addresses, and redirects are refused. Certificate errors do not trigger a cleartext retry. Headers and body together must arrive within 15 seconds; the body is capped at 16 MB (16,777,216 bytes) after decompression. An invalid download leaves the usable catalog in place. At the next launch the app uses a verified cache no older than its bundled catalog, or the bundle. An explicit pin takes precedence."],
            ["Cache", "Verified copies stay on your computer. At most five catalog files are kept, including the current and the preceding usable copy. An older hash pin may be evicted; for long-term reproducibility keep a separate catalog file and pin its absolute path. An unusable explicit pin prevents startup."],
            ["Turning it off", "Settings → Model → Model catalog, turn off Refresh the catalog daily. An administrator can turn refresh off with { \"modelCatalog\": { \"refresh\": \"off\" } } in the system policy file; a malformed or unreadable policy also disables it. A launcher can pin AVE_MODEL_CATALOG to bundled, a kept copy’s sha256, or an absolute catalog-file path, which disables refresh too."],
          ] },
        ],
      },
      {
        id: "service",
        h: "What the app reads from this site",
        blocks: [
          { p: "Ave reads /.well-known/ave-service.json on this site to learn whether there are announcements and whether the service has moved. Announcements are at /announcements/v1.json." },
        ],
      },
    ],
  },
};

export function docPages(locale: Locale): DocPage[] {
  const set = locale === "en" ? en : ko;
  return DOC_SLUGS.map((slug) => set[slug]);
}

export function docPage(locale: Locale, slug: string): DocPage | undefined {
  const set = locale === "en" ? en : ko;
  return (DOC_SLUGS as readonly string[]).includes(slug) ? set[slug as DocSlug] : undefined;
}
