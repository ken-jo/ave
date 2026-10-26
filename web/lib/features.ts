import type { BentoBlock, Faq, Picture, Point, SplitBlock } from "./content";
import type { Locale } from "./i18n";
import type { Feature } from "./nav";

/**
 * Feature page copy. Facts come from the app's guide (lib/docs.ts), its UI
 * strings and code, and the captures; numbers (limits, counts) are the
 * app's own constants. The browser-agent tools and the main-area panels are
 * captured from their feature branches' builds (see web/DESIGN.md).
 */

export interface FeaturePage {
  meta: { title: string; description: string };
  hero: { eyebrow: string; title: string; lead: string; pic: Picture };
  first: SplitBlock;
  grid: BentoBlock;
  second?: SplitBlock;
  /** A row of short facts that have no picture of their own. */
  facts?: { title: string; items: { title: string; body: string }[] };
  /** Models only: the three ways to connect. */
  ways?: { title: string; body: string; items: { tag: string; title: string; points: string[] }[] };
  /** Models only: every provider in the app's provider list (lib/providers.ts). */
  providers?: {
    eyebrow: string;
    title: string;
    body: string;
    builtIn: string;
    packages: string;
    tags: { gateway: string; noKey: string; pkg: (v: string) => string; notListed: string };
  };
  /** Plugins only: what the official marketplace's catalog holds (lib/marketplace.ts). */
  catalog?: {
    eyebrow: string;
    title: string;
    body: string;
    meta: (total: number, commit: string) => string;
    kinds: Record<string, string>;
    more: (n: number) => string;
    points: Point[];
  };
  faqTitle: string;
  faqs: Faq[];
  next: { doc: string; feature: string; download: string };
}

type Pages = Record<Feature, FeaturePage>;

const ko: Pages = {
  browser: {
    meta: {
      title: "브라우저",
      description: "Ave의 에이전트는 자기 탭을 열어 페이지를 읽고 누르고 입력합니다. 내가 연 탭에서 누르고 입력하고 이동하는 동작은 매번 묻습니다.",
    },
    hero: {
      eyebrow: "브라우저",
      title: "에이전트가 웹 페이지를 열고, 읽고, 확인합니다",
      lead: "에이전트는 작업 패널의 브라우저에서 자기 탭을 열고 페이지를 읽은 뒤 링크를 누르고 양식에 입력합니다. 누르고 입력하는 동작은 실행 전에 묻고, 내가 연 탭에서는 그런 동작을 매번 따로 묻습니다.",
      pic: { k: "browser-live-nav", alt: "메인 영역의 브라우저가 Ridge Loop 상세 페이지로 이동해 있고, 옆 사이드 채팅에 browser snapshot과 browser navigate 단계, 그리고 페이지의 고도 값에 단위가 없다는 답이 보이는 화면" },
    },
    first: {
      eyebrow: "에이전트의 도구",
      title: "페이지를 텍스트로 읽고, 요소를 짚어서 다룹니다",
      body: "에이전트는 화면 좌표가 아니라 페이지의 접근성 구조를 읽습니다. 버튼과 입력란에 붙은 참조로 무엇을 누를지 정확히 짚습니다.",
      points: [
        ["browser_snapshot", "은 페이지를 접근성 구조로 읽습니다. 최대 50,000자이며 요소마다 [ref=e12] 같은 참조가 붙습니다."],
        ["browser_click, browser_type, browser_press_key", "는 참조로 짚은 요소를 누르고, 입력하고, Enter·Tab·화살표 같은 키를 보냅니다."],
        ["browser_navigate", "는 http와 https 주소만 열고, 다른 사이트로 넘기는 리다이렉트는 따라가지 않습니다."],
        ["browser_wait", "는 글자가 나타날 때까지, 또는 최대 30초까지 기다립니다."],
        ["browser_tabs, browser_tab_new, browser_tab_close", "로 대화가 열린 창의 탭을 보고 열고 닫습니다. 내가 연 탭도 여기에 포함됩니다. 루틴과 헤드리스 실행에는 브라우저가 없습니다."],
      ],
      pic: { k: "browser-live", alt: "메인 영역의 브라우저에 트레일 목록 페이지가 열려 있고, 사이드 채팅이 browser snapshot으로 목록을 읽은 뒤 browser_navigate 승인을 요청하는 화면" },
    },
    grid: {
      eyebrow: "안전 장치",
      title: "누구의 탭인지에 따라 다르게 묻습니다",
      body: "승인 창은 페이지 주소와 함께 그 탭을 누가 열었는지 적습니다. 페이지에서 읽어 온 내용은 신뢰할 수 없는 웹 데이터로 표시되어 모델에 전달됩니다.",
      cards: [
        {
          title: "에이전트가 연 탭",
          body: "‘이번 세션 동안 허용’은 사이트별로 Ave를 다시 시작할 때까지만 유지됩니다. 항상 허용은 없습니다.",
          pic: { k: "browser-approval", alt: "browser_click 승인 창. 에이전트가 연 탭의 페이지이며 Ave를 다시 시작할 때까지 이 사이트에서 허용한다는 안내" },
          w: 3,
          inset: true,
        },
        {
          title: "새 탭을 여는 것도 확인",
          body: "browser_tab_new는 네트워크 동작으로 분류되어, 어느 주소를 열려는지 보여 주고 승인을 받습니다.",
          pic: { k: "browser-tab-approval", alt: "browser_tab_new 승인 창. 네트워크 범주, 열려는 페이지 주소, 거절과 허용 버튼" },
          w: 3,
          inset: true,
        },
        {
          title: "메인 영역의 웹 패널",
          body: "사이드 패널에서 연 페이지를 메인 영역으로 옮기면 웹 패널이 됩니다. 페이지 상태는 옮겨도 유지됩니다.",
          pic: { k: "web-main", alt: "메인 영역에 trail-notes 미리보기 웹 패널과 터미널이 나란히 열린 화면" },
          w: 4,
        },
        {
          title: "작업 패널의 브라우저",
          body: "주소창 하나와 방문한 사이트 목록이 함께 있습니다. 목록은 요청함, 결과에서 같은 출처 표시를 붙입니다.",
          pic: { k: "browser-side", alt: "대화 옆 작업 패널의 브라우저 탭에 trail-notes 미리보기가 열린 화면" },
          w: 2,
        },
      ],
    },
    facts: {
      title: "읽는 방법도 고릅니다",
      items: [
        { title: "조작할 수 있는 것만", body: "스냅숏은 링크, 버튼, 입력란처럼 사람이 조작할 수 있는 요소만 평평한 목록으로 줄 수 있습니다." },
        { title: "바뀐 부분만", body: "같은 탭을 다시 읽을 때는 이전 스냅숏 뒤에 바뀐 부분만 받아, 긴 페이지를 처음부터 다시 읽지 않습니다." },
        { title: "지시가 아니라 데이터", body: "페이지에서 읽은 글은 사이트 운영자가 쓴 데이터로 표시되어, 페이지 안에 적힌 지시를 따르지 않습니다." },
      ],
    },
    faqTitle: "자주 묻는 질문",
    faqs: [
      { q: "에이전트가 내가 로그인해 둔 탭을 마음대로 쓸 수 있나요?", a: "내가 연 탭에서 누르기, 입력, 키 누르기, 이동, 닫기는 어떤 권한 모드에서든 매번 묻고 기억되지 않습니다. 물어볼 사람이 없으면 거부됩니다. 그 탭을 읽거나 캡처하는 것은 네트워크 동작으로, 사이트별로 이번 세션 동안 한 번 묻고 ‘모두 허용’에서는 묻지 않습니다." },
      { q: "비밀번호도 입력하나요?", a: "아니요. 에이전트는 비밀번호, 결제 카드, 일회용 코드 입력란에는 입력하지 않습니다." },
      { q: "승인 창이 떠 있는 동안 페이지가 바뀌면요?", a: "그 동작은 아무것도 하지 않습니다. 에이전트가 다시 시도하면 바뀐 페이지를 기준으로 다시 묻습니다." },
      { q: "에이전트가 일하는 동안 제가 페이지를 만지면요?", a: "에이전트는 동작하는 순간에만 페이지 포커스를 잡고 바로 돌려줍니다. 탭의 중지 버튼을 누르거나 페이지를 직접 누르고 입력하면 대기 중인 동작이 멈춥니다." },
      { q: "열 수 없는 주소는 어떻게 되나요?", a: "http나 https가 아니거나 주소에 자격 증명이 들어 있으면 승인 창을 띄우지 않고 바로 거부합니다." },
      { q: "화면을 캡처할 수도 있나요?", a: "네. browser_screenshot은 탭에 보이는 화면을 캡처합니다. 텍스트 개요만으로 부족할 때 씁니다." },
      { q: "루틴에서도 브라우저를 쓸 수 있나요?", a: "아니요. 루틴과 헤드리스 실행에는 브라우저 도구가 주어지지 않습니다." },
    ],
    next: {
      doc: "작업 패널의 브라우저 탭과 출처 표시는 작업 화면 문서에 있습니다.",
      feature: "실제 셸을 돌리는 터미널과, 에이전트가 그 출력을 읽는 방법.",
      download: "macOS, Windows, Linux에서 내려받기와 첫 실행 단계.",
    },
  },
  terminal: {
    meta: {
      title: "터미널",
      description: "Ave의 터미널은 운영체제 샌드박스 안에서 실제 셸을 돌립니다. 사이드 패널과 메인 영역을 오가고, 에이전트는 결과를 읽거나 권한 검사를 거쳐 같은 터미널에 명령을 실행합니다.",
    },
    hero: {
      eyebrow: "터미널",
      title: "실제 셸, 샌드박스 안에서",
      lead: "Ave의 터미널은 운영체제 샌드박스 안에서 실제 셸을 돌리는 PTY입니다. 사이드 패널에서 열어 메인 영역으로 옮길 수 있습니다. 터미널에 붙인 채팅에서 에이전트가 실행 결과를 읽고, 승인받은 다음 명령을 같은 셸에 실행합니다.",
      pic: { k: "terminal-live", alt: "메인 영역의 터미널과 그 창에 붙인 채팅. 에이전트가 terminal_read로 실패한 테스트를 읽고, terminal_run 승인을 받아 같은 터미널에서 다시 실행한 뒤 원인을 설명하는 화면" },
    },
    first: {
      eyebrow: "명령 블록",
      title: "명령마다 하나의 블록",
      body: "셸 통합이 명령의 시작과 끝을 표시해서, 명령마다 명령어, 작업 폴더, 종료 코드, 걸린 시간을 블록으로 묶습니다.",
      points: [
        ["복사와 첨부.", "블록마다 복사, 대화에 첨부가 있고, ‘마지막 블록 첨부’로 방금 실행한 결과를 바로 대화에 넣습니다."],
        ["탭마다 셸 하나.", "탭마다 오래 도는 셸이 하나씩 있고, 최대 16개까지 엽니다. 스크롤백 256KB는 다시 붙을 때 그대로 재생됩니다."],
        ["셸 선택.", "$SHELL이 절대 경로면 그 셸을, 아니면 macOS는 zsh, 그 밖에는 bash를 씁니다."],
        ["작업 공간에서 시작.", "기본 폴더는 홈이 아니라 ~/.ave/workspace입니다. 셸마다 버리는 임시 HOME을 써서 내 rc 파일은 읽지 않습니다."],
      ],
      pic: { k: "terminal-side", alt: "대화 옆 사이드 패널의 터미널. Blocks 4와 Attach last 버튼, git log와 실패한 테스트 1개가 있는 npm test 결과" },
    },
    grid: {
      eyebrow: "에이전트와 함께",
      title: "결과를 읽고, 다음 명령은 승인받아서",
      body: "terminal_read는 명령 블록과 출력을 읽고, terminal_run은 권한 검사를 거쳐 한 줄 명령을 같은 터미널에 실행합니다. 승인 카드의 대상 터미널과 현재 작업 폴더가 고정되며, 셸이 실행 중이거나 아직 제출하지 않은 입력이 있으면 명령을 보내지 않습니다. 읽은 출력은 신뢰할 수 없는 데이터로 표시됩니다.",
      cards: [
        {
          title: "같은 터미널에서 다시 실행",
          body: "실패한 npm test 출력을 읽고, 같은 터미널에서 테스트를 다시 실행할 명령을 승인 카드로 보여 줍니다.",
          pic: { k: "terminal-ask", alt: "터미널에 붙인 채팅이 실패한 테스트 출력을 읽은 뒤 같은 터미널에서 실행할 명령을 승인 카드로 보여 주는 화면" },
          w: 4,
        },
        {
          title: "사이드 채팅의 대상",
          body: "마지막으로 앞에 둔 터미널이나 페이지가 사이드 채팅의 대상이 되고, 입력창 위에 표시됩니다.",
          pic: { k: "side-chat-target", alt: "사이드 채팅 탭의 입력창 위에 ‘Terminal 1’ 대상 칩이 붙어 있는 화면" },
          w: 2,
        },
        {
          title: "에이전트의 셸 명령",
          body: "에이전트가 직접 돌리는 명령은 따로 한 번씩 실행되고, 실행 위치와 격리 상태를 보여 주며 승인을 받습니다.",
          pic: { k: "approval-shell", alt: "builtin:bash 승인 창. OS 격리 활성(asrt), 명령마다 임시 HOME, 로그인 상태를 물려받지 않는다는 설명" },
          w: 4,
          inset: true,
        },
        {
          title: "작업 공간에서 열기",
          body: "빈 사이드 패널에서 터미널, 브라우저, 파일, 서브에이전트, 사이드 채팅을 바로 엽니다.",
          pic: { k: "workspace-launcher", alt: "‘작업 공간에서 열기’ 목록. Review, Terminal, Browser, Files, Sub-agents, Activity, Side chat과 단축키" },
          w: 2,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "샌드박스",
      title: "샌드박스가 셸을 담지 못하면 시작하지 않습니다",
      body: "터미널은 운영체제 샌드박스 안에서만 돕니다. 샌드박스가 셸을 담을 수 없으면 터미널은 시작을 거부하고, 샌드박스 없이 도는 대체 경로는 없습니다.",
      points: [
        ["macOS는 Seatbelt, Linux는 bwrap.", "파일 쓰기, 프로세스, 네트워크를 함께 가둡니다. 네트워크는 기본으로 막힙니다."],
        ["직접 입력한 명령은 따로 묻지 않습니다.", "내가 터미널에 친 명령에는 승인 단계가 없고, 샌드박스가 그 경계입니다."],
        ["샌드박스는 직접 켭니다.", "설정의 권한 탭에서 켜고, 켠 뒤에는 앱을 다시 시작해야 합니다."],
      ],
      pic: { k: "settings-sandbox", alt: "권한 설정의 OS 도구 샌드박스 항목이 켜져 있고, macOS에서 무엇을 가두는지 설명이 보이는 화면" },
      flip: true,
    },
    faqTitle: "자주 묻는 질문",
    faqs: [
      { q: "터미널이 열리지 않아요.", a: "터미널은 OS 샌드박스가 켜져 있어야 돕니다. 설정 → 권한에서 OS 도구 샌드박스를 켜고 앱을 다시 시작하세요. 샌드박스가 셸을 담을 수 없는 환경이면 터미널은 시작하지 않습니다." },
      { q: "터미널을 메인 영역으로 옮기면 셸이 다시 시작되나요?", a: "아니요. ‘메인 영역으로 이동’이나 끌어 놓기로 옮겨도 셸과 출력이 그대로 이어집니다. 터미널은 한 번에 한 곳에만 보이고, 메인 영역의 패널을 닫으면 셸도 끝납니다." },
      { q: "에이전트가 제 터미널에 명령을 입력하나요?", a: "네. terminal_run은 권한 검사를 통과한 한 줄 명령을 지정된 터미널에서 실행합니다. 승인 카드에 표시된 터미널과 현재 작업 폴더가 실행 때도 같아야 하며, 셸이 실행 중이거나 아직 제출하지 않은 입력이 있으면 거부됩니다. terminal_read는 출력 읽기만 담당합니다." },
      { q: "오래 걸리는 명령이 끝나면 알려 주나요?", a: "셸이 알림 이스케이프(OSC 9 또는 OSC 777)를 보내면 그 패널에 표시가 붙고, 창이 앞에 있지 않을 때는 운영체제 알림이 뜹니다." },
      { q: "닫은 패널을 다시 열 수 있나요?", a: "⌘⇧T는 같은 종류의 새 패널을 같은 위치에 엽니다. 닫힌 셸 프로세스가 되살아나지는 않습니다." },
    ],
    next: {
      doc: "작업 패널과 칸 구성은 작업 화면 문서에 있습니다.",
      feature: "API 키, 직접 띄운 서버, 구독으로 모델을 연결하는 방법.",
      download: "macOS, Windows, Linux에서 내려받기와 첫 실행 단계.",
    },
  },
  models: {
    meta: {
      title: "모델",
      description: "Ave는 API 키, 직접 띄운 OpenAI 호환 서버, ChatGPT와 Claude 구독으로 모델을 연결합니다. 모델 선택은 하나, 대체 체인과 추론 수준도 설정합니다.",
    },
    hero: {
      eyebrow: "모델",
      title: "모델은 내가 고르고, 연결은 세 가지 중 하나로",
      lead: "설정 → 모델에서 제공자를 추가하고 카드마다 저장합니다. 모델 목록은 제공자에서 받아 캐시해 두고, 실행할 때 한 번 또는 새로 고침을 누를 때 갱신합니다.",
      pic: { k: "settings-model", alt: "모델 설정 화면. OpenAI 호환 사용자 지정 제공자가 연결됨으로 표시되고, 추론과 대체 체인 항목이 이어지는 화면" },
    },
    ways: {
      title: "연결하는 세 가지 길",
      body: "어느 길로 연결하든 모델 선택은 하나이고, 제공자별로 묶여 보입니다.",
      items: [
        { tag: "API 키", title: "제공자 키로", points: ["기본 제공: OpenAI, Claude, Gemini, OpenRouter", "그 밖의 제공자는 마켓플레이스의 제공자 패키지로", "OpenAI는 API 키 채팅으로도 연결"] },
        { tag: "직접 띄운 서버", title: "OpenAI 호환 엔드포인트", points: ["로컬이나 사내 서버를 주소로 연결", "모델 목록은 엔드포인트에서 동기화", "이미지 입력 지원 여부를 직접 지정 가능"] },
        { tag: "구독", title: "ChatGPT와 Claude 요금제", points: ["ChatGPT: 브라우저 로그인이나 기기 코드로, 내가 설치한 codex CLI를 격리해 실행", "Claude: Ave가 자동으로 찾은 공식 claude CLI를 앱 전용 설정 폴더로 실행", "구독 자격 증명은 API 키로 바뀌지 않음"] },
      ],
    },
    first: {
      eyebrow: "입력창에서",
      title: "대화하면서 모델과 추론 수준을 바꿉니다",
      body: "입력창 아래의 모델 이름을 누르면 같은 선택 창이 열립니다. 추론하는 모델은 여기서 추론 수준을 정합니다.",
      points: [
        ["대체 체인.", "한 모델이 실패하면 체인의 다음 모델이 그 턴을 이어받습니다."],
        ["경로 사이의 조용한 대체는 없습니다.", "구독 경로에서 API 키 경로로 몰래 넘어가지 않습니다."],
        ["로그인 정보는 설정 화면에 나오지 않습니다.", "로그인 주소와 토큰은 설정 페이지에 노출되지 않고, 브라우저 로그인은 메인 프로세스가 엽니다."],
      ],
      pic: { k: "model-chooser", alt: "입력창의 모델 선택 팝오버. local-model 선택과 추론 수준 None, Low, Medium, High 슬라이더" },
    },
    grid: {
      eyebrow: "제공자 관리",
      title: "추가, 확인, 그리고 한도",
      body: "제공자 카드는 연결 상태와 동기화한 모델 수를 보여 줍니다. 컨텍스트 창과 출력 한도는 앱에 든 모델 카탈로그와 제공자가 알려 주는 값으로 판단합니다.",
      cards: [
        {
          title: "제공자 추가",
          body: "‘제공자 추가’ 메뉴에서 OpenAI, Anthropic Claude, Google Gemini, OpenRouter 같은 제공자를 고릅니다.",
          pic: { k: "settings-providers", alt: "모델 설정의 ‘제공자 추가’ 메뉴에 OpenAI, Moonshot, xAI, Claude Code, Anthropic Claude, Google Gemini, OpenRouter가 나열된 화면" },
          w: 3,
        },
        {
          title: "칸마다 따로 도는 대화",
          body: "칸마다 자기 대화 루프가 있어서, 여러 대화가 동시에 답을 받습니다.",
          pic: { k: "app-subagents", alt: "세 칸에 각각 다른 대화가 열려 있는 화면" },
          w: 3,
        },
        {
          title: "턴마다 남는 기록",
          body: "어느 제공자와 모델로 턴이 돌았는지 감사 로그에 남습니다.",
          pic: { k: "audit-log", alt: "감사 로그 표에 openai-compatible/local-model로 기록된 turn 항목이 보이는 화면" },
          w: 6,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "어떤 모델이든",
      title: "모델이 바뀌어도 작업대는 같습니다",
      body: "아래 화면은 직접 띄운 OpenAI 호환 서버의 local-model로 돌린 대화입니다. 파일을 고치고 테스트를 돌리는 흐름은 어느 제공자로 연결해도 같습니다.",
      points: [
        ["도구와 승인은 호스트가 정합니다.", "권한 모드, 승인, OS 샌드박스는 모델과 관계없이 똑같이 적용됩니다."],
        ["긴 대화는 자동으로 정리됩니다.", "언제 정리할지는 모델 카탈로그가 알려 주는 그 모델의 컨텍스트 창을 기준으로 합니다."],
        ["사용량은 모델별로.", "사용량 탭에서 모델별 토큰과 비용을 보고 CSV로 내보냅니다."],
      ],
      pic: { k: "app-conversation", alt: "local-model이 export 명령에 --json 플래그를 넣고 테스트 6개가 통과했다고 답한 대화" },
      flip: true,
    },
    providers: {
      eyebrow: "제공자",
      title: "앱이 아는 제공자 전부",
      body: "앱의 제공자 목록에서 빌드할 때 그대로 읽어 옵니다. 다섯은 앱에 들어 있고, 나머지는 공식 마켓플레이스의 제공자 패키지로 추가한 뒤 설정 → 모델에서 연결합니다.",
      builtIn: "앱에 포함",
      packages: "제공자 패키지로 추가",
      tags: { gateway: "게이트웨이", noKey: "키 없이 연결", pkg: (v) => `패키지 ${v}`, notListed: "공식 카탈로그에 없음" },
    },
    faqTitle: "자주 묻는 질문",
    faqs: [
      { q: "Claude 구독으로 연결하면 무엇이 달라지나요?", a: "Ave가 자동으로 찾은 공식 claude CLI를 앱 전용 설정 폴더로 실행하고, OAuth 토큰을 읽거나 API 키를 재사용하지 않습니다. CLI 자체 도구는 꺼지고 Ave의 도구만 MCP 브리지로 제공됩니다. 이 경로는 모델 선택과 이미지 첨부가 없습니다." },
      { q: "직접 띄운 모델 서버도 쓸 수 있나요?", a: "OpenAI 호환 엔드포인트라면 주소로 연결합니다. 모델 목록은 서버에서 받아 오고, 이미지 입력 지원 여부는 직접 정할 수 있습니다." },
      { q: "모델 정보는 어디서 오나요?", a: "컨텍스트 창과 출력 한도는 models.dev의 공개 카탈로그를 하루에 많아야 한 번 받아 씁니다. 계정, 키, 대화는 보내지 않고, 설정 → 모델 → 모델 카탈로그에서 끌 수 있습니다." },
      { q: "목록에 없는 제공자는요?", a: "마켓플레이스의 제공자 패키지로 추가합니다. 설정의 모델 탭에 ‘마켓플레이스에서 제공자 더 보기’ 버튼이 있습니다." },
      { q: "사용량 단가를 바꿀 수 있나요?", a: "모델 탭의 단가 보정에서 백만 토큰당 달러 단가를 모델별로 정하면, 사용량 탭과 CSV 내보내기에 그 단가가 쓰입니다." },
    ],
    next: {
      doc: "제공자 추가, 로그인, 구독, 대체 체인을 단계별로 설명합니다.",
      feature: "플러그인과 마켓플레이스, 그리고 설치 전에 보는 것.",
      download: "macOS, Windows, Linux에서 내려받기와 첫 실행 단계.",
    },
  },
  plugins: {
    meta: {
      title: "플러그인",
      description: "Ave의 플러그인, MCP 서버, 스킬, 테마는 git 마켓플레이스에서 옵니다. 설치는 커밋과 SHA-256에 고정되고, 플러그인은 각자의 프로세스에서 돕니다.",
    },
    hero: {
      eyebrow: "플러그인",
      title: "확장은 git에서, 설치 전에 검토하고",
      lead: "플러그인, MCP 서버, 스킬, 에이전트, 테마, 글꼴, 언어, 모델 제공자, 메시징 연결이 모두 같은 방식으로 들어옵니다. git 저장소나 폴더에서 받아 출처와 해시를 검토한 뒤 설치합니다.",
      pic: { k: "install-review", alt: "Nord 테마 패키지의 설치 검토 창. 출처 폴더, 내용 해시, 호환 버전과 설치 버튼" },
    },
    first: {
      eyebrow: "추가하는 길",
      title: "마켓플레이스, git 주소, 폴더, 파일",
      body: "마켓플레이스 탭의 추가 메뉴에서 마켓플레이스 저장소를 더하거나, git 주소나 폴더에서 패키지 하나를 바로 설치합니다.",
      points: [
        ["공식.", "Ave에 들어 있는 출처이며, 호스트 비밀 값을 받을 수 있는 유일한 출처입니다."],
        ["관리.", "조직이 시스템 정책 파일의 marketplaces.additional로 더합니다."],
        ["사용자 지정과 직접.", "설정 → 마켓플레이스 → 추가로 저장소를 더하거나, git 폴더 하나를 패키지 하나로 설치합니다."],
        ["링크로 설치.", "ave://install 링크는 확인 화면만 엽니다. 확인하기 전에는 아무것도 설치되지 않습니다."],
      ],
      pic: { k: "marketplace-add", alt: "마켓플레이스 탭의 추가 메뉴. 마켓플레이스 추가, Git URL이나 폴더에서 설치, MCP 서버 추가, 플러그인 만들기, 파일에서 설치" },
    },
    grid: {
      eyebrow: "설치 과정",
      title: "검토한 그대로 설치됩니다",
      body: "설치 계획은 검토한 내용의 해시에 묶입니다. 그 사이 폴더가 바뀌어도 설치되는 것은 검토한 내용이고, 계획은 몇 분 뒤 만료됩니다.",
      cards: [
        {
          title: "주소를 확인",
          body: "어떤 종류의 패키지인지, 코드를 실행하는지, 어디서 오는지를 먼저 보여 줍니다.",
          pic: { k: "install-check", alt: "Git 주소나 폴더에서 설치 창의 검토 단계. 테마 패키지이며 코드를 실행하지 않는다는 표시" },
          w: 2,
          inset: true,
        },
        {
          title: "설치 계획",
          body: "‘검토한 것이 설치됩니다’와 함께 내용 해시와 만료 시간을 보여 줍니다.",
          pic: { k: "install-plan", alt: "Nord 1.0.1 설치 계획. 폴더 내용 해시에 묶여 있고 계획이 만료되기까지 남은 시간" },
          w: 4,
          inset: true,
        },
        {
          title: "바로 적용되는 테마",
          body: "설치한 테마는 테마 설정에 마켓플레이스 표시와 함께 나타납니다. 어두운 화면의 사진은 Tokyo Night 테마를 켠 모습입니다.",
          pic: { k: "settings-theme", alt: "테마 설정의 색 테마 목록에 Moonstone, Gallery와 마켓플레이스에서 설치한 Tokyo Night 테마가 있는 화면. 어두운 버전은 Tokyo Night을 켠 상태" },
          w: 3,
        },
        {
          title: "제공자도 패키지로",
          body: "기본으로 없는 모델 제공자는 마켓플레이스 패키지로 더합니다.",
          pic: { k: "settings-model", alt: "모델 설정 화면 오른쪽 위의 ‘마켓플레이스에서 제공자 더 보기’ 버튼" },
          w: 3,
        },
      ],
    },
    facts: {
      title: "만드는 사람에게",
      items: [
        { title: "두 가지 실행 방식", body: "entry는 JavaScript 모듈, process는 표준 입출력의 JSON-RPC로 호스트와 대화하는 아무 언어의 프로그램입니다. process는 OS 샌드박스가 켜져 있어야 돌고 Windows에서는 지원하지 않습니다." },
        { title: "나눠서 내보내기", body: "게시자는 특정 버전을 회수하거나 설치본의 일부에 먼저 내보낼 수 있고, 사용자는 canaryOptIn 설정으로 카나리 버전을 받을 수 있습니다." },
        { title: "알림은 종류별로", body: "플러그인이 선언한 알림 종류는 설치할 때 플러그인이 정한 기본값으로 켜지거나 꺼지고, 종류마다 따로 끌 수 있습니다. 쿨다운과 빈도 제한을 지켜 카드나 OS 알림으로 옵니다. 플러그인이 제안한 대화는 수락해야 시작합니다." },
      ],
    },
    catalog: {
      eyebrow: "공식 마켓플레이스",
      title: "공식 카탈로그에 있는 것",
      body: "공식 마켓플레이스는 git 저장소 ken-jo/agent-marketplace이고, 그 안의 marketplace.json이 모든 패키지를 나열합니다. 아래 숫자와 이름은 그 파일을 기록한 커밋에서 그대로 읽었습니다.",
      meta: (total, commit) => `패키지 ${total}개 · 카탈로그 커밋 ${commit}`,
      kinds: { plugin: "플러그인", "agent-plugin": "에이전트 플러그인", mcp: "MCP 서버", skill: "스킬", agent: "에이전트", theme: "테마", language: "언어", provider: "모델 제공자" },
      more: (n) => `외 ${n}개`,
      points: [
        ["커밋에 고정.", "카탈로그의 버전마다 설치할 git 커밋이 적혀 있고, 설치는 그 커밋에 묶입니다."],
        ["코드는 릴리스 압축 파일로.", "플러그인 버전은 릴리스 압축 파일과 그 SHA-256을 적어 둬서, 카탈로그가 설치할 바이트를 정확히 고정합니다."],
        ["필요한 버전을 선언.", "버전마다 필요한 가장 낮은 Ave 버전을 적고, 더 새 Ave가 필요한 버전은 설치하지 않습니다."],
        ["네트워크도 선언.", "플러그인은 접속할 수 있는 주소를 적어 두고(최대 16개), 카탈로그가 그 목록을 함께 싣습니다."],
      ],
    },
    faqTitle: "자주 묻는 질문",
    faqs: [
      { q: "플러그인이 앱 안에서 그대로 실행되나요?", a: "아니요. 설치 경로와 관계없이 모든 플러그인은 앱 밖의 자기 프로세스에서 돌고, 샌드박스를 켜면 그 안에서 돕니다. 하나가 시작에 실패해도 나머지는 계속 동작합니다." },
      { q: "플러그인이 아무 사이트에나 접속할 수 있나요?", a: "networkAccess.allowedDomains에 선언한 도메인에만, 많아야 16개까지 접속합니다. 호스트가 한 번에 한 홉씩 보내고 리다이렉트마다 다시 확인합니다." },
      { q: "설치한 파일이 바뀌면 어떻게 되나요?", a: "설치할 때 파일마다 SHA-256을 영수증에 기록하고 실행할 때 다시 확인합니다. 맞지 않는 플러그인은 올라오지 않습니다." },
      { q: "업데이트는 자동인가요?", a: "실행할 때와 정해진 주기로 새 버전을 확인하고, 대화가 쉬는 동안 하나씩 적용합니다. 권한이나 MCP 서버, 훅이 승인한 것과 달라지면 자동으로 적용하지 않고 검토를 기다립니다." },
      { q: "조직에서 설치를 관리할 수 있나요?", a: "정책 파일로 허용·차단 목록, 기본 설치, 필수 설치를 정합니다. 필수 패키지는 지우거나 끌 수 없습니다." },
      { q: "마켓플레이스 주소에는 제한이 있나요?", a: "일반 http와 내부망 주소는 한 번 묻고, 클라우드 메타데이터 주소처럼 안전하지 않은 주소는 항상 거부합니다." },
      { q: "직접 만든 플러그인은 어떻게 시험하나요?", a: "패키징하지 않은 빌드를 AVE_DEV=1로 실행하고 설정 → 확장 설정 → 개발자 도구 → 로컬 폴더에서 설치를 고릅니다." },
    ],
    next: {
      doc: "플러그인 매니페스트, 실행 방식, 격리와 네트워크를 설명합니다.",
      feature: "권한 모드, 승인, 샌드박스, 감사 로그.",
      download: "macOS, Windows, Linux에서 내려받기와 첫 실행 단계.",
    },
  },
  security: {
    meta: {
      title: "보안",
      description: "Ave는 바꾸는 작업을 실행 전에 묻고, 민감한 경로는 항상 막고, OS 샌드박스로 도구를 가두고, HMAC 체인 감사 로그를 남깁니다.",
    },
    hero: {
      eyebrow: "보안",
      title: "무엇이 바뀌는지 보고 나서 허용합니다",
      lead: "도구 호출은 읽기, 쓰기, 셸, 네트워크, 메타로 나뉘고 위험도는 낮음, 중간, 높음입니다. 기본 모드는 읽기만 허용하고, 바꾸는 작업은 대화를 가리지 않는 승인 독에서 묻습니다.",
      pic: { k: "approval-shell", alt: "builtin:bash 승인 창. 중간 위험, OS 격리 활성, 명령마다 임시 HOME, 거절·항상 허용·한 번 허용 버튼" },
    },
    first: {
      eyebrow: "권한 모드",
      title: "얼마나 자주 물을지는 내가 정합니다",
      body: "모드와 상관없이 강제 차단 규칙이 먼저 돕니다. 민감한 경로, 잘못된 매니페스트, 샌드박스 한계가 여기에 걸립니다.",
      points: [
        ["쓰기만 확인.", "기본값입니다. 읽기는 허용하고 쓰기, 셸, 네트워크는 승인을 받습니다."],
        ["모두 확인.", "읽기를 포함해 모든 도구가 승인을 받습니다."],
        ["자동 검증.", "대화에서 낮음과 중간 위험은 감사 기록을 남기고 자동 허용하고, 높은 위험만 묻습니다. 헤드리스 실행은 별도의 리뷰 대기열을 씁니다."],
        ["모두 허용.", "강제 차단 밖은 허용하지만, 허용된 폴더 밖 접근은 따로 승인을 받습니다."],
      ],
      pic: { k: "settings-permissions", alt: "권한 설정의 권한 정책 목록. 모두 확인, 쓰기만 확인(선택됨), 자동 검증, 모두 허용" },
    },
    grid: {
      eyebrow: "실제 화면",
      title: "승인, 격리, 기록",
      body: "승인 창은 무엇을, 어디서, 어떤 격리 아래 실행하는지 보여 줍니다. ‘항상 허용’은 정확히 그 도구, 그 입력, 그 작업 폴더에만 묶입니다.",
      cards: [
        {
          title: "파일 쓰기 승인",
          body: "어느 파일을 고치는지와 함께, 기억할 경우 어떤 범위로 기억하는지 승인 창 아래에 적습니다.",
          pic: { k: "approval-edit", alt: "builtin:edit_file 승인 창. 중간 위험, 쓰기 범주, 이 작업 폴더의 이 파일에서 edit_file을 기억한다는 안내" },
          w: 3,
          inset: true,
        },
        {
          title: "브라우저 동작 승인",
          body: "에이전트 탭의 허용은 Ave를 다시 시작할 때까지만 유지되고, 내 탭에서 누르고 입력하는 동작은 매번 묻습니다.",
          pic: { k: "browser-approval", alt: "browser_click 승인 창. 에이전트가 연 탭이며 Ave를 다시 시작할 때까지 이 사이트에서 허용한다는 안내" },
          w: 3,
          inset: true,
        },
        {
          title: "OS 샌드박스",
          body: "macOS는 Seatbelt, Linux는 bwrap, Windows는 srt-win으로 도구 실행을 운영체제 수준에서 가둡니다.",
          pic: { k: "settings-sandbox", alt: "OS 도구 샌드박스가 켜져 있고 macOS에서 파일 쓰기, 프로세스, 네트워크를 가둔다는 설명이 보이는 설정 화면" },
          w: 4,
        },
        {
          title: "감사 로그",
          body: "~/.ave/audit.log는 HMAC 체인으로 이어집니다. 원문 비밀 값은 기록하지 않습니다.",
          pic: { k: "audit-log", alt: "감사 탭 결과 표에 turn, tool_call, allow, approval, ask 항목이 나열된 화면" },
          w: 2,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "검증된 설치",
      title: "플러그인도 같은 원칙을 따릅니다",
      body: "플러그인은 자기 프로세스에서 돌고, 호스트가 모든 호출의 위험도를 매깁니다. 플러그인은 그 등급을 낮출 수 없습니다.",
      points: [
        ["해시로 고정.", "설치는 커밋과 SHA-256에 묶이고, 실행할 때마다 다시 확인합니다."],
        ["선언한 도메인만.", "네트워크는 선언한 도메인에만, 리다이렉트마다 다시 확인합니다."],
        ["회수.", "출처는 특정 버전을 끄거나 지울 수 있고, 그 출처에서 설치한 것에만 적용됩니다."],
      ],
      pic: { k: "install-plan", alt: "설치 계획 화면. 검토한 내용의 해시에 묶여 있고 계획 만료까지 남은 시간이 보이는 화면" },
      flip: true,
    },
    facts: {
      title: "그 밖에 정해 둔 것",
      items: [
        { title: "허용 디렉터리", body: "프로젝트 루트, ~/.ave, 전용 임시 폴더, 시스템 임시 폴더(macOS와 Linux는 /tmp 포함)에서 시작하고 설정의 permissions.additionalDirectories로 늘립니다. 그 밖은 따로 묻습니다." },
        { title: "검토기 선택", body: "검증 끔(자동 통과), 규칙 기반 검증, LLM 검증, 엄격(모두 보류) 중에서 고릅니다. 엄격은 바꾸는 작업을 모두 보류 대기열로 보내 직접 승인하게 합니다." },
        { title: "정책 파일", body: "사용자와 관리자가 각자 policy.json을 둘 수 있고, 유효한 관리자 정책은 다루는 설정을 잠급니다." },
      ],
    },
    faqTitle: "자주 묻는 질문",
    faqs: [
      { q: "‘항상 허용’은 무엇을 기억하나요?", a: "정확히 그 도구, 그 입력, 그 작업 폴더입니다. 대상 이름에 와일드카드가 있으면 규칙을 저장하지 않고 ‘한 번 허용’을 권합니다." },
      { q: "검토기가 실패하면요?", a: "요청은 통과되지 않고 보류됩니다. LLM 검토는 위험도를 올릴 수만 있고 내릴 수는 없습니다." },
      { q: "헤드리스 실행이나 루틴에서는 누가 승인하나요?", a: "낮은 위험을 넘는 요청은 지연 대기열에 들어가 내가 볼 때까지 기다립니다." },
      { q: "어떤 경로는 항상 막히나요?", a: "~/.ssh 아래 키나 .env 파일 같은 민감한 경로는 어떤 모드에서도 막힙니다." },
      { q: "모델에 비밀 값이 넘어가나요?", a: "API 키를 비롯한 자격 증명은 설정과 무관하게 항상 제거하고 보냅니다. 이메일, 전화번호, 카드 번호 같은 개인 정보는 설정의 PII 리댁트(기본값 꺼짐)를 켜면 [REDACTED:*]로 바꿔 보내고, 가린 개수를 감사 로그에 남깁니다." },
      { q: "플러그인이 스스로 대화를 시작할 수 있나요?", a: "host:overlay 기능이 있는 플러그인은 대화를 제안할 수 있지만, 수락해야 시작합니다. 그 대화 안에서도 쓰기, 셸, 네트워크 도구는 다시 묻습니다." },
      { q: "Windows에서는 무엇이 다른가요?", a: "srt-win은 파일과 네트워크를 가두지만 프로세스는 가두지 않습니다. 플러그인끼리의 격리는 macOS와 Linux에서만 됩니다." },
      { q: "OS 샌드박스는 기본으로 켜져 있나요?", a: "아니요. 직접 켜는 기능이고, 켜면 앱을 다시 시작해야 합니다. 켜면 네트워크는 기본으로 막힙니다." },
    ],
    next: {
      doc: "권한 모드, 결정 순서, 허용 폴더, 샌드박스, 감사 로그를 설명합니다.",
      feature: "",
      download: "macOS, Windows, Linux에서 내려받기와 첫 실행 단계.",
    },
  },
};

const en: Pages = {
  browser: {
    meta: {
      title: "Browser",
      description: "Ave’s agents open their own tabs, read pages, click and type. In tabs you opened, clicking, typing and navigating ask every time.",
    },
    hero: {
      eyebrow: "Browser",
      title: "Agents open web pages, read them and check them",
      lead: "In the work panel’s browser, the agent opens its own tab, reads the page, then follows links and fills in forms. Clicking and typing ask before they run, and in tabs you opened those actions ask every time.",
      pic: { k: "browser-live-nav", alt: "The browser in the main area has moved to the Ridge Loop detail page; the side chat beside it shows the browser snapshot and browser navigate steps and reports that the page’s elevation has no unit" },
    },
    first: {
      eyebrow: "The agent’s tools",
      title: "Pages read as text, elements picked by reference",
      body: "The agent reads the page’s accessibility structure, not screen coordinates. Buttons and fields carry references, so it names exactly what it will press.",
      points: [
        ["browser_snapshot", " reads the page as an accessibility outline of up to 50,000 characters, with references such as [ref=e12] on each element."],
        ["browser_click, browser_type, browser_press_key", " press, type into, or send keys such as Enter, Tab and the arrows to an element by its reference."],
        ["browser_navigate", " opens http and https addresses only and does not follow redirects to another site."],
        ["browser_wait", " waits for text to appear, or for up to 30 seconds."],
        ["browser_tabs, browser_tab_new, browser_tab_close", " list, open and close tabs in the window where the conversation is open, your own tabs included. Routines and headless runs get no browser."],
      ],
      pic: { k: "browser-live", alt: "The browser in the main area shows the trail list; the side chat has read it with browser snapshot and asks for approval to run browser_navigate" },
    },
    grid: {
      eyebrow: "Safeguards",
      title: "It asks differently depending on whose tab it is",
      body: "Approval cards name the page and who opened the tab. What the agent reads from a page reaches the model marked as untrusted web data.",
      cards: [
        {
          title: "Tabs the agent opened",
          body: "Allow for this session holds per site until Ave restarts. There is no always-allow for browser actions.",
          pic: { k: "browser-approval", alt: "An approval card for browser_click: the page is in a tab the agent opened, and the approval holds on this site until Ave restarts" },
          w: 3,
          inset: true,
        },
        {
          title: "Opening a tab asks too",
          body: "browser_tab_new counts as a network action, so it shows the address it will open and waits for approval.",
          pic: { k: "browser-tab-approval", alt: "An approval card for browser_tab_new in the network category, with the address it will open and Reject and Allow buttons" },
          w: 3,
          inset: true,
        },
        {
          title: "A web panel in the main area",
          body: "Move a page from the side panel to the main area and it becomes a web panel; the page keeps its state.",
          pic: { k: "web-main", alt: "The main area with the trail-notes preview in a web panel beside a terminal" },
          w: 4,
        },
        {
          title: "The work panel’s browser",
          body: "One address bar and the list of visited sites, each marked as requested or found in a result.",
          pic: { k: "browser-side", alt: "The work panel’s Browser tab showing the trail-notes preview beside the conversation" },
          w: 2,
        },
      ],
    },
    facts: {
      title: "It chooses how to read, too",
      items: [
        { title: "Only what can be used", body: "A snapshot can list just the elements a person can act on, such as links, buttons and fields, as a flat list." },
        { title: "Only what changed", body: "Reading the same tab again, the agent can ask for just what changed since its previous snapshot instead of the whole page." },
        { title: "Data, not instructions", body: "Text read from a page is marked as written by whoever runs the site, so instructions written inside a page are treated as data." },
      ],
    },
    faqTitle: "Questions",
    faqs: [
      { q: "Can the agent use a tab I’m signed in to?", a: "In a tab you opened, clicking, typing, pressing keys, navigating and closing ask every time, in every permission mode, and nothing is remembered; with no one to ask, they are denied. Reading or capturing that tab is a network action: it asks once per site for the session, and passes under Allow all." },
      { q: "Does it type passwords?", a: "No. The agent does not type into password, payment-card or one-time-code fields." },
      { q: "What if the page changes while the approval card is open?", a: "The action does nothing. If the agent tries again, it asks about the page as it is now." },
      { q: "What if I touch the page while the agent works?", a: "The agent holds the page’s focus only while it acts, then gives it back. Press Stop on the tab, or click or type in the page, and its pending actions stop." },
      { q: "What about addresses it can’t open?", a: "Anything that isn’t http or https, or that carries credentials in the address, is refused without showing an approval card." },
      { q: "Can it take a screenshot?", a: "Yes. browser_screenshot captures what a tab shows, for when the text outline isn’t enough." },
      { q: "Can routines use the browser?", a: "No. Routines and headless runs are not given the browser tools." },
    ],
    next: {
      doc: "The work panel’s Browser tab and its source labels are in the workbench guide.",
      feature: "A terminal that runs a real shell, and how the agent reads its output.",
      download: "Getting Ave on macOS, Windows and Linux, and the first-launch steps.",
    },
  },
  terminal: {
    meta: {
      title: "Terminal",
      description: "Ave’s terminal runs a real shell inside the OS sandbox. It moves between the side panel and the main area; agents read its output or run a command there through the permission check.",
    },
    hero: {
      eyebrow: "Terminal",
      title: "A real shell, inside the sandbox",
      lead: "Ave’s terminal is a PTY running a real shell inside the operating-system sandbox. Open it in the side panel and move it to the main area. In the terminal’s own chat, the agent reads your output and runs an approved next command in the same shell.",
      pic: { k: "terminal-live", alt: "The main-area terminal with its own docked chat. The agent reads the failing test with terminal_read, runs it again in the same terminal after terminal_run approval, and explains the cause" },
    },
    first: {
      eyebrow: "Command blocks",
      title: "One block per command",
      body: "Shell integration marks where each command starts and ends, so every command becomes a block with its command line, folder, exit code and duration.",
      points: [
        ["Copy and attach.", "Each block has Copy and Attach to chat, and Attach last puts the result you just got straight into the conversation."],
        ["One shell per tab.", "Each tab keeps one long-running shell, up to 16 terminals. Up to 256 KB of scrollback replays when a view reattaches."],
        ["Your shell.", "$SHELL when it is an absolute path; otherwise zsh on macOS and bash elsewhere."],
        ["Starts in the workspace.", "The default folder is ~/.ave/workspace, not your home. Each shell gets a throwaway HOME, so your rc files are not read."],
      ],
      pic: { k: "terminal-side", alt: "A terminal in the side panel beside the conversation, showing Blocks 4, Attach last, git log and an npm test run with one failure" },
    },
    grid: {
      eyebrow: "With the agent",
      title: "Read the output. Approve the next command.",
      body: "terminal_read lists tabs and reads command blocks and output; terminal_run sends one line through the permission check into the same terminal. The approval card fixes the terminal and its working directory. Ave refuses the command while the shell is busy or you have typed input without submitting it. Output reaches the agent marked as untrusted data.",
      cards: [
        {
          title: "Run it again in the same terminal",
          body: "It reads the failed npm test output and shows an approval card for the command that will run the test again in the same terminal.",
          pic: { k: "terminal-ask", alt: "The terminal’s docked chat reads the failed test output and shows an approval card for a command in that same terminal" },
          w: 4,
        },
        {
          title: "The side chat’s target",
          body: "The terminal or page you last brought forward becomes the side chat’s target, shown above its composer.",
          pic: { k: "side-chat-target", alt: "The side chat tab with a Terminal 1 target chip above its composer" },
          w: 2,
        },
        {
          title: "The agent’s own commands",
          body: "Commands the agent runs go through its shell tool, one process each, and show where they run and how they are isolated before you approve.",
          pic: { k: "approval-shell", alt: "An approval card for builtin:bash: OS isolation active (asrt), a temporary HOME for each command, no inherited sign-in state" },
          w: 4,
          inset: true,
        },
        {
          title: "Open in workspace",
          body: "An empty side panel opens a terminal, browser, files, sub-agents or a side chat in one click.",
          pic: { k: "workspace-launcher", alt: "The Open in workspace list: Review, Terminal, Browser, Files, Sub-agents, Activity and Side chat, with shortcuts" },
          w: 2,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "Sandbox",
      title: "If the sandbox can’t hold the shell, it doesn’t start",
      body: "The terminal runs only inside the OS sandbox. When the sandbox cannot contain a shell, the terminal refuses to start; there is no unsandboxed fallback.",
      points: [
        ["Seatbelt on macOS, bwrap on Linux.", "Files, processes and network are confined together, and network is denied by default."],
        ["Commands you type don’t ask.", "There is no per-command approval for what you type yourself; the sandbox is the boundary."],
        ["You turn the sandbox on.", "Enable it in Settings → Permissions, then restart the app."],
      ],
      pic: { k: "settings-sandbox", alt: "The OS Tool Sandbox setting turned on, with a description of what it confines on macOS" },
      flip: true,
    },
    faqTitle: "Questions",
    faqs: [
      { q: "The terminal won’t open.", a: "The terminal needs the OS sandbox. Turn on OS Tool Sandbox in Settings → Permissions and restart Ave. Where the sandbox cannot contain a shell, the terminal does not start." },
      { q: "Does moving a terminal to the main area restart the shell?", a: "No. Move to main area, or dragging the tab, keeps the shell and its output. A terminal shows in one place at a time, and closing its main-area pane ends the shell." },
      { q: "Does the agent type into my terminal?", a: "Yes. terminal_run sends one line into the selected terminal through the permission check. The terminal and its current working directory must still match the approval card at execution time. Ave refuses the command while the shell is busy or you have typed input without submitting it. terminal_read only reads output." },
      { q: "Can it tell me when a long command finishes?", a: "When the shell sends a notification escape (OSC 9 or OSC 777), the pane is marked, and if the Ave window isn’t focused the system shows a notification." },
      { q: "Can I reopen a closed panel?", a: "⌘⇧T opens a new panel of the same kind at the same address. A closed shell process is not revived." },
    ],
    next: {
      doc: "The work panel and tile layout are in the workbench guide.",
      feature: "Connect a model with an API key, your own server or a subscription.",
      download: "Getting Ave on macOS, Windows and Linux, and the first-launch steps.",
    },
  },
  models: {
    meta: {
      title: "Models",
      description: "Connect Ave to a model with an API key, an OpenAI-compatible server you run, or a ChatGPT or Claude subscription. One chooser, a fallback chain and reasoning levels.",
    },
    hero: {
      eyebrow: "Models",
      title: "You choose the model, and connect it one of three ways",
      lead: "Add a provider in Settings → Model and save each card. The model list is fetched from the provider, cached, and refreshed once per run or when you press refresh.",
      pic: { k: "settings-model", alt: "The Model settings with a custom OpenAI-compatible provider shown as connected, followed by reasoning and fallback settings" },
    },
    ways: {
      title: "Three ways to connect",
      body: "Whichever way you connect, there is one model chooser, grouped by provider.",
      items: [
        { tag: "API key", title: "With a provider key", points: ["Built in: OpenAI, Claude, Gemini, OpenRouter", "Other providers as marketplace provider packages", "OpenAI also through API-key chat"] },
        { tag: "Your own server", title: "An OpenAI-compatible endpoint", points: ["A local or company server, by address", "The model list syncs from the endpoint", "Declare image input support yourself if needed"] },
        { tag: "Subscription", title: "ChatGPT and Claude plans", points: ["ChatGPT: sign in in the browser or with a device code, through the codex CLI you installed, run in isolation", "Claude: the official claude CLI Ave discovers automatically, with an app-owned config folder", "Subscription credentials never become API keys"] },
      ],
    },
    first: {
      eyebrow: "From the composer",
      title: "Change the model and reasoning level mid-conversation",
      body: "Click the model name under the composer to open the same chooser. For models that reason, set the reasoning level here.",
      points: [
        ["Fallback chain.", "When a model fails, the next one in the chain takes over that turn."],
        ["No silent switching between routes.", "A subscription route never quietly falls back to an API-key route."],
        ["Sign-in stays out of settings.", "Sign-in URLs and tokens never appear on the settings page; browser sign-in is opened by the main process."],
      ],
      pic: { k: "model-chooser", alt: "The composer’s model chooser with local-model selected and a reasoning slider from None to High" },
    },
    grid: {
      eyebrow: "Managing providers",
      title: "Add, check, and know the limits",
      body: "Provider cards show whether they are connected and how many models were synced. Context windows and output limits come from the app’s bundled model catalog and what the provider reports.",
      cards: [
        {
          title: "Add provider",
          body: "Pick a provider such as OpenAI, Anthropic Claude, Google Gemini or OpenRouter from the Add provider menu.",
          pic: { k: "settings-providers", alt: "The Add provider menu in the Model settings listing OpenAI, Moonshot, xAI, Claude Code, Anthropic Claude, Google Gemini and OpenRouter" },
          w: 3,
        },
        {
          title: "Each tile on its own loop",
          body: "Every tile runs its own conversation loop, so several conversations get answers at once.",
          pic: { k: "app-subagents", alt: "Three tiles, each holding a different conversation" },
          w: 3,
        },
        {
          title: "Every turn on record",
          body: "The audit log records which provider and model each turn ran on.",
          pic: { k: "audit-log", alt: "The audit log table with a turn entry recorded as openai-compatible/local-model" },
          w: 6,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "Any model",
      title: "Change the model, keep the workbench",
      body: "This conversation ran on local-model, served by an OpenAI-compatible server. Editing files and running tests work the same whichever provider you connect.",
      points: [
        ["The host decides tools and approvals.", "Permission modes, approvals and the OS sandbox apply the same way whatever the model."],
        ["Long conversations are compacted automatically.", "When to compact follows the model’s context window from the model catalog."],
        ["Usage per model.", "The Usage tab shows tokens and cost per model and exports them as CSV."],
      ],
      pic: { k: "app-conversation", alt: "A conversation where local-model added a --json flag to the export command and reports that all six tests pass" },
      flip: true,
    },
    providers: {
      eyebrow: "Providers",
      title: "Every provider the app knows",
      body: "Read at build time from the app’s own provider list. Five ship in the app; the rest are added as provider packages from the official marketplace and then connected in Settings → Model.",
      builtIn: "Built in",
      packages: "Added as a provider package",
      tags: { gateway: "Gateway", noKey: "No key needed", pkg: (v) => `package ${v}`, notListed: "not in the official catalog" },
    },
    faqTitle: "Questions",
    faqs: [
      { q: "What changes when I connect a Claude subscription?", a: "Ave launches the official claude CLI Ave discovers automatically with an app-owned config folder, and never reads OAuth tokens or reuses API keys. The CLI’s own tools are off; only Ave’s tools are offered, through its MCP bridge. This route has no model choice and no image attachments." },
      { q: "Can I use a model server I run myself?", a: "If it is an OpenAI-compatible endpoint, connect it by address. The model list comes from the server, and you can declare whether it accepts images." },
      { q: "Where does model information come from?", a: "Context windows and output limits come from the public models.dev catalog, fetched at most once a day. No account, key or conversation is sent, and you can turn it off in Settings → Model → Model catalog." },
      { q: "What about a provider that isn’t listed?", a: "Add it as a provider package from a marketplace. The Model tab has a More providers in Marketplace button." },
      { q: "Can I change the usage prices?", a: "Price corrections in the Model tab set dollars per million tokens per model; the Usage tab and its CSV export use those rates." },
    ],
    next: {
      doc: "Adding providers, signing in, subscriptions and the fallback chain, step by step.",
      feature: "Plugins, marketplaces, and what you review before installing.",
      download: "Getting Ave on macOS, Windows and Linux, and the first-launch steps.",
    },
  },
  plugins: {
    meta: {
      title: "Plugins",
      description: "Ave’s plugins, MCP servers, skills and themes come from git marketplaces. Installs are pinned to a commit and SHA-256, and plugins run in their own processes.",
    },
    hero: {
      eyebrow: "Plugins",
      title: "Extensions from git, reviewed before they install",
      lead: "Plugins, MCP servers, skills, agents, themes, fonts, languages, model providers and messaging connections all arrive the same way: from a git repository or a folder, installed after you review the source and its hash.",
      pic: { k: "install-review", alt: "The install review for the Nord theme package showing its source folder, contents hash, compatibility and an Install button" },
    },
    first: {
      eyebrow: "Ways in",
      title: "Marketplaces, git addresses, folders and files",
      body: "From the Marketplace tab’s Add menu, add a marketplace repository, or install one package straight from a git address or a folder.",
      points: [
        ["Official.", "Built into Ave, and the only source whose plugins can be granted host secrets."],
        ["Managed.", "Added by an organisation through marketplaces.additional in the machine policy file."],
        ["Custom and direct.", "Add a repository in Settings → Marketplace → Add, or install one git folder as one package."],
        ["Install links.", "An ave://install link only opens a confirmation screen; nothing installs until you confirm."],
      ],
      pic: { k: "marketplace-add", alt: "The Marketplace tab’s Add menu: Add marketplace, Install from Git URL or folder, Add MCP server, Create a plugin, Install from file" },
    },
    grid: {
      eyebrow: "Installing",
      title: "What you review is what installs",
      body: "The install plan is bound to the hash of what you reviewed. If the folder changes in the meantime, what installs is still what you reviewed, and the plan expires after a few minutes.",
      cards: [
        {
          title: "Check the address",
          body: "First it shows what kind of package this is, whether it runs code, and where it comes from.",
          pic: { k: "install-check", alt: "The review step of Install from a git address or folder: a theme package that runs no code" },
          w: 2,
          inset: true,
        },
        {
          title: "The install plan",
          body: "“What you review here is what installs”, with the contents hash and when the plan expires.",
          pic: { k: "install-plan", alt: "The install plan for Nord 1.0.1, bound to the folder’s contents hash, with the time left before it expires" },
          w: 4,
          inset: true,
        },
        {
          title: "Themes apply right away",
          body: "An installed theme appears in Theme settings marked as coming from the marketplace. The dark picture shows the Tokyo Night theme turned on.",
          pic: { k: "settings-theme", alt: "The color theme list in Theme settings with Moonstone, Gallery and the Tokyo Night theme installed from the marketplace; the dark version shows Tokyo Night turned on" },
          w: 3,
        },
        {
          title: "Providers are packages too",
          body: "A model provider that isn’t built in is added as a marketplace package.",
          pic: { k: "settings-model", alt: "The Model settings with a More providers in Marketplace button at the top right" },
          w: 3,
        },
      ],
    },
    facts: {
      title: "For people who build them",
      items: [
        { title: "Two ways to run", body: "An entry plugin is a JavaScript module; a process plugin is a program in any language that talks to the host over JSON-RPC on standard input and output. Process plugins need the OS sandbox and are not supported on Windows." },
        { title: "Staged releases", body: "Publishers can yank a version or roll it out to a share of installs first, and you can opt into canary versions with the canaryOptIn setting." },
        { title: "Alerts by kind", body: "Each alert kind a plugin declares starts on or off at install as the plugin chooses, and you can switch each kind off. Alerts keep to cooldowns and rate limits, as cards or system notifications. A conversation a plugin suggests starts only when you accept it." },
      ],
    },
    catalog: {
      eyebrow: "Official marketplace",
      title: "What the official catalog holds",
      body: "The official marketplace is the git repository ken-jo/agent-marketplace, and its marketplace.json lists every package. The counts and names below are read from that file at a recorded commit.",
      meta: (total, commit) => `${total} packages · catalog commit ${commit}`,
      kinds: { plugin: "Plugins", "agent-plugin": "Agent plugins", mcp: "MCP servers", skill: "Skills", agent: "Agents", theme: "Themes", language: "Languages", provider: "Model providers" },
      more: (n) => `and ${n} more`,
      points: [
        ["Pinned to commits.", "Every catalog version names the git commit it installs from, and the install is bound to that commit."],
        ["Code ships as a release archive.", "A plugin version names its release archive and that archive’s SHA-256, so the catalog pins the exact bytes."],
        ["Compatibility is declared.", "Each version states the oldest Ave it needs; a version that needs a newer Ave is not installed."],
        ["So is network access.", "A plugin lists the hosts it may reach (sixteen at most), and the catalog carries that list."],
      ],
    },
    faqTitle: "Questions",
    faqs: [
      { q: "Do plugins run inside the app?", a: "No. Whatever way they were installed, every plugin runs in its own process outside the app, and inside the sandbox when it is on. If one fails to start, the others keep working." },
      { q: "Can a plugin reach any site?", a: "Only the domains it declares in networkAccess.allowedDomains, sixteen at most. The host sends one hop at a time and checks every redirect." },
      { q: "What if installed files change?", a: "Each install writes a receipt with a SHA-256 per file, checked again at launch. A plugin that doesn’t match is not loaded." },
      { q: "Are updates automatic?", a: "New versions are checked at launch and on a schedule, and applied one at a time while the conversation is idle. If permissions, MCP servers or hooks differ from what you approved, the update waits for your review." },
      { q: "Can an organisation manage installs?", a: "A policy file sets allow and block lists, default installs and required installs. A required package cannot be uninstalled or disabled." },
      { q: "Are there limits on marketplace addresses?", a: "Plain http and internal-network addresses ask once; metadata and other unsafe addresses are always refused." },
      { q: "How do I try a plugin I’m building?", a: "Run an unpackaged build with AVE_DEV=1 and choose Settings → Extension Settings → Developer tools → Install from local folder." },
    ],
    next: {
      doc: "The plugin manifest, how plugins run, isolation and network.",
      feature: "Permission modes, approvals, the sandbox and the audit log.",
      download: "Getting Ave on macOS, Windows and Linux, and the first-launch steps.",
    },
  },
  security: {
    meta: {
      title: "Security",
      description: "Ave asks before anything changes, always blocks sensitive paths, confines tools with the OS sandbox, and keeps an HMAC-chained audit log.",
    },
    hero: {
      eyebrow: "Security",
      title: "See what will change, then allow it",
      lead: "Tool calls fall into read, write, shell, network and meta, and risk is low, medium or high. The default mode allows reads only; anything that changes something asks in an approval dock that does not cover the conversation.",
      pic: { k: "approval-shell", alt: "An approval card for builtin:bash: medium risk, OS isolation active, a temporary HOME for each command, and Reject, Always allow and Allow once" },
    },
    first: {
      eyebrow: "Permission modes",
      title: "You decide how often it asks",
      body: "In every mode, hard-deny rules run first: sensitive paths, invalid manifests and sandbox limits.",
      points: [
        ["Confirm writes.", "The default. Reads are allowed; writes, shell commands and network requests ask for approval."],
        ["Confirm all.", "Every tool asks for approval, reads included."],
        ["Auto-verify.", "In chat, low and medium risk are allowed automatically with an audit trail, and only high risk asks. Headless runs use a separate reviewer queue."],
        ["Allow all.", "Everything outside the hard blocks is allowed, but access outside the allowed folders still asks."],
      ],
      pic: { k: "settings-permissions", alt: "The permission policy list in Permissions settings: Confirm all, Confirm writes (selected), Auto-verify and Allow all" },
    },
    grid: {
      eyebrow: "In the app",
      title: "Approvals, isolation and a record",
      body: "An approval card shows what runs, where, and under which isolation. Always allow is bound to exactly that tool, input and working folder.",
      cards: [
        {
          title: "Approving a file write",
          body: "The card names the file being changed, and says exactly what would be remembered if you allow it always.",
          pic: { k: "approval-edit", alt: "An approval card for builtin:edit_file: medium risk, write category, and what Always allow would remember for this file and folder" },
          w: 3,
          inset: true,
        },
        {
          title: "Approving a browser action",
          body: "In agent tabs an approval lasts until Ave restarts; in your own tabs, clicking and typing ask every time.",
          pic: { k: "browser-approval", alt: "An approval card for browser_click in a tab the agent opened, allowed on this site until Ave restarts" },
          w: 3,
          inset: true,
        },
        {
          title: "The OS sandbox",
          body: "Seatbelt on macOS, bwrap on Linux and srt-win on Windows confine tool execution at the operating-system level.",
          pic: { k: "settings-sandbox", alt: "The OS Tool Sandbox setting turned on, describing how it confines file writes, processes and network on macOS" },
          w: 4,
        },
        {
          title: "The audit log",
          body: "~/.ave/audit.log is HMAC-chained, and audit records never contain raw secrets.",
          pic: { k: "audit-log", alt: "The Audit tab’s results table listing turn, tool_call, allow, approval and ask entries" },
          w: 2,
          inset: true,
        },
      ],
    },
    second: {
      eyebrow: "Verified installs",
      title: "Plugins follow the same rules",
      body: "Plugins run in their own processes, and the host rates the risk of every call. A plugin cannot lower it.",
      points: [
        ["Pinned by hash.", "Installs are bound to a commit and SHA-256, and checked again at every launch."],
        ["Declared domains only.", "Network goes only to declared domains, and every redirect is checked again."],
        ["Recalls.", "A source can disable or uninstall a specific version; a recall applies only to installs from that source."],
      ],
      pic: { k: "install-plan", alt: "An install plan bound to the hash of the reviewed contents, with the time left before it expires" },
      flip: true,
    },
    facts: {
      title: "Also decided for you",
      items: [
        { title: "Allowed folders", body: "They start with the project root, ~/.ave, a private scratch folder and the system temporary folder (plus /tmp on macOS and Linux), and grow through permissions.additionalDirectories in settings. Anything outside them asks separately." },
        { title: "Choose the reviewer", body: "Validation off (auto-pass), rule-based validation, LLM validation, or strict, where every request that changes something waits in a queue for you." },
        { title: "Policy files", body: "Users and administrators can each keep a policy.json, and a valid administrator policy locks the settings it covers." },
      ],
    },
    faqTitle: "Questions",
    faqs: [
      { q: "What does Always allow remember?", a: "Exactly that tool, input and working folder. If the target name contains a wildcard, Ave won’t save the rule and suggests Allow once instead." },
      { q: "What if the reviewer fails?", a: "The request is held, not passed. LLM validation can raise a risk rating, never lower it." },
      { q: "Who approves in routines and headless runs?", a: "Anything above low risk goes to a deferred queue and waits for you." },
      { q: "Which paths are always blocked?", a: "Sensitive paths, such as keys under ~/.ssh and .env files, are blocked in every mode." },
      { q: "Do secrets reach the model?", a: "API keys and other credentials are always removed before anything is sent, whatever the settings say. Personal data such as email addresses, phone numbers and card numbers is replaced with [REDACTED:*] when you turn on PII Redaction (off by default), and the count is recorded in the audit log." },
      { q: "Can a plugin start a conversation by itself?", a: "A plugin with the host:overlay capability can suggest one, but it starts only when you accept it, and write, shell and network tools inside it ask again." },
      { q: "What is different on Windows?", a: "srt-win confines files and network, not processes, and isolation between plugins is available on macOS and Linux only." },
      { q: "Is the OS sandbox on by default?", a: "No. You turn it on, and it needs a restart. With the sandbox on, network is denied by default." },
    ],
    next: {
      doc: "Permission modes, how a request is decided, allowed folders, the sandbox and the audit log.",
      feature: "",
      download: "Getting Ave on macOS, Windows and Linux, and the first-launch steps.",
    },
  },
};

export function featurePage(locale: Locale, feature: Feature): FeaturePage {
  return (locale === "en" ? en : ko)[feature];
}
