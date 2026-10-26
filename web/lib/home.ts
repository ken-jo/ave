import type { BentoBlock, Picture, Point } from "./content";
import type { Locale } from "./i18n";

/**
 * Home page copy and the site-wide notices. Every product claim is taken from
 * the app's guide (lib/docs.ts), its UI strings, or what the captures show;
 * the captures are of the real app driven by a scripted demo conversation.
 */

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { eyebrow: string; title: string; sub: string; download: string; docs: string; note: string; pic: Picture };
  /** The feature tour: its heading, plus the label its stage picture carries. The steps come from each feature page's hero (lib/features.ts). */
  tour: { eyebrow: string; title: string; body: string; label: string };
  work: { eyebrow: string; title: string; body: string; points: Point[]; pic: Picture };
  surfaces: BentoBlock;
  models: {
    eyebrow: string;
    title: string;
    body: string;
    ways: { tag: string; title: string; body: string }[];
    pic: Picture;
  };
  safety: BentoBlock;
  safetyFacts: { title: string; body: string }[];
  plugins: { eyebrow: string; title: string; body: string; kinds: { name: string; body: string }[]; cap: string };
  changes: { eyebrow: string; title: string; body: string };
  get: { eyebrow: string; title: string; body: string; cta: string };
  footer: { tagline: string; copy: string; menu: string; skip: string };
}

const ko: HomeCopy = {
  meta: {
    title: "Ave — 에이전트가 내 컴퓨터에서 일하는 데스크톱 작업대",
    description:
      "Ave는 에이전트가 내가 고른 모델로 내 컴퓨터의 파일과 터미널, 브라우저를 다루는 macOS, Windows, Linux용 데스크톱 앱입니다. 바꾸는 일은 실행 전에 묻습니다.",
  },
  hero: {
    eyebrow: "macOS · Windows · Linux 데스크톱 앱",
    title: "에이전트가 내 컴퓨터에서 일하는 작업대",
    sub: "Ave는 에이전트가 내 프로젝트의 파일을 읽고 고치고, 터미널과 브라우저를 다루는 데스크톱 앱입니다. 모델은 내가 고르고, 무언가를 바꾸는 작업은 실행 전에 내 승인을 거칩니다.",
    download: "내려받기",
    docs: "문서 읽기",
    note: "Apple Silicon Mac, Windows 10 이상(x64), x86_64 Linux. 공개 빌드는 아직 코드 서명이 없습니다.",
    pic: {
      k: "app-conversation",
      alt: "Ave 대화 화면. 프로젝트 trail-notes에서 에이전트가 export 명령에 --json 플래그를 넣고 테스트 6개가 통과했다고 답한 대화",
    },
  },
  tour: {
    eyebrow: "기능",
    title: "다섯 가지로 살펴보는 Ave",
    body: "브라우저, 터미널, 모델, 플러그인, 보안. 각 기능을 실제 앱 화면과 함께 봅니다.",
    label: "현재 단계의 앱 화면",
  },
  work: {
    eyebrow: "작업 화면",
    title: "대화 넷을 나란히, 각자 따로 굴러갑니다",
    body: "창 폭에 맞춰 대화를 최대 네 칸까지 나란히 보여 줍니다. 좁은 창에서는 포커스된 대화 하나를 보여 주고 나머지는 유지합니다. 칸마다 루프가 따로 있어서, 한쪽이 승인을 기다리는 동안 다른 칸은 계속 답합니다.",
    points: [
      ["칸 나누기.", "나란히 또는 위아래로 나눕니다. 칸이 너무 작아지는 방향은 고를 수 없게 표시됩니다."],
      ["Enter는 대기열로.", "답하는 중에 보낸 메시지는 대기열에 들어가 다음 쉼표에서 이어집니다. ⌘/Ctrl+Enter는 지금 멈추고 바로 보냅니다."],
      ["질문 카드.", "에이전트가 내 결정이 필요하면 그 대화 칸에 선택지가 담긴 카드를 띄웁니다."],
      ["되돌리기와 갈래.", "내 메시지에서 ‘여기로 돌아가기’는 그 뒤를 지우고 글을 입력창에 돌려놓고, ‘포크’는 그 지점에서 새 대화를 엽니다."],
      ["작업 패널.", "파일, 미리보기, 브라우저, 터미널, 서브에이전트, 사이드 채팅이 칸 옆 카드 하나에 모입니다."],
    ],
    pic: {
      k: "app-subagents",
      alt: "세 칸에 각각 다른 대화가 열려 있는 화면. 왼쪽은 --json 플래그를 넣고 테스트 6개가 통과한 대화, 오른쪽 위는 서브에이전트 탭에 두 리뷰가 완료로 표시된 대화, 오른쪽 아래는 1.2.0 릴리스 체크리스트",
    },
  },
  surfaces: {
    eyebrow: "에이전트가 다루는 것",
    title: "파일, 터미널, 브라우저, 그리고 서브에이전트",
    body: "에이전트는 대화 안에서만 일하지 않습니다. 작업 패널과 메인 영역의 실제 도구를 함께 씁니다.",
    cards: [
      {
        title: "페이지에 붙인 채팅",
        body: "브라우저 창 안의 채팅에서 페이지를 읽고 이동을 요청합니다. 그 창이 채팅의 대상이 되고, 도구 실행은 권한 검사를 거칩니다.",
        pic: { k: "browser-done", alt: "Ridge Loop 상세 페이지와 그 브라우저 창에 붙인 채팅. 페이지를 읽고 이동한 실제 도구 결과와 고도 단위가 빠졌다는 점검 결과" },
        w: 4,
      },
      {
        title: "질문 카드",
        body: "버전처럼 내가 정해야 할 일은 추천 표시가 붙은 선택지 카드로 묻고, 고르면 바로 이어 갑니다.",
        pic: { k: "question-card", alt: "‘이번 릴리스는 어느 버전인가요?’ 질문과 1.2.0(추천), 1.1.1, 2.0.0 선택지가 있는 질문 카드" },
        w: 2,
        inset: true,
      },
      {
        title: "메인 영역의 터미널",
        body: "실제 셸이 도는 터미널을 사이드 패널에서 메인 영역으로 옮겨도 셸과 출력이 그대로 이어집니다.",
        pic: { k: "terminal-main", alt: "메인 영역에 대화와 터미널이 나란히 있고, 터미널에 git log와 npm test 결과가 보이는 화면" },
        w: 3,
      },
      {
        title: "서브에이전트",
        body: "에이전트는 한 단계 깊이까지 서브에이전트를 띄워 일을 나눕니다. 진행과 결과는 서브에이전트 탭에서 봅니다.",
        pic: { k: "app-subagents", alt: "서브에이전트 탭에 ‘Parser edge cases’와 ‘Test coverage’ 두 서브에이전트가 완료로 표시된 화면" },
        w: 3,
      },
    ],
  },
  models: {
    eyebrow: "모델",
    title: "모델을 연결하는 세 가지 길",
    body: "설정의 모델 탭에서 제공자를 추가합니다. 모델 선택은 하나로, 제공자별로 묶여 보입니다.",
    ways: [
      { tag: "API 키", title: "제공자 키로", body: "OpenAI, Claude, Gemini, OpenRouter를 키로 연결합니다. 다른 제공자는 마켓플레이스 패키지로 추가합니다." },
      { tag: "직접 띄운 서버", title: "OpenAI 호환 엔드포인트", body: "로컬이나 사내에서 띄운 OpenAI 호환 서버를 주소만으로 붙입니다. 모델 목록은 서버에서 받아 옵니다." },
      { tag: "구독", title: "이미 쓰는 요금제로", body: "ChatGPT 요금제는 내가 설치한 codex CLI를 격리해 실행하는 방식으로, Claude 구독은 Ave가 자동으로 찾은 공식 claude CLI로 로그인합니다. 구독 자격 증명은 API 키가 되지 않습니다." },
    ],
    pic: { k: "model-chooser", alt: "입력창의 모델 선택 팝오버. local-model이 선택돼 있고 아래에 추론 수준 None, Low, Medium, High 슬라이더가 있는 화면" },
  },
  safety: {
    eyebrow: "보안",
    title: "바꾸는 일은 실행 전에 보여 주고 묻습니다",
    body: "기본 권한 모드는 읽기는 허용하고 쓰기, 셸, 네트워크는 승인을 받습니다. 승인 창은 대화를 가리지 않는 아래쪽 독에 뜹니다.",
    cards: [
      {
        title: "명령 하나하나를 보고 승인",
        body: "셸 명령은 위험도, 실행 위치, 격리 여부를 보여 주고 거절, 항상 허용, 한 번 허용 중에서 고르게 합니다.",
        pic: { k: "approval-shell", alt: "builtin:bash 승인 창. 중간 위험, OS 격리 활성(asrt), 명령마다 임시 HOME을 쓴다는 설명과 거절, 항상 허용, 한 번 허용 버튼" },
        w: 4,
        inset: true,
      },
      {
        title: "변조가 드러나는 감사 로그",
        body: "도구 호출, 승인, 결정이 HMAC 체인으로 이어진 감사 로그에 남아 중간을 고치면 드러납니다.",
        pic: { k: "audit-log", alt: "감사 탭의 결과 표. turn, tool_call, allow, approval, ask 항목이 시간순으로 나열된 화면" },
        w: 2,
        inset: true,
      },
      {
        title: "내 탭과 에이전트 탭을 구분",
        body: "에이전트가 연 탭은 사이트별로 Ave를 다시 시작할 때까지만 허용을 기억하고, 내가 연 탭에서 누르고 입력하는 동작은 매번 묻습니다.",
        pic: { k: "browser-approval", alt: "builtin:browser_click 승인 창. 에이전트가 연 탭의 페이지이며 Ave를 다시 시작할 때까지 이 사이트에서 허용한다는 안내가 적힌 화면" },
        w: 6,
        inset: true,
      },
    ],
  },
  safetyFacts: [
    { title: "OS 샌드박스", body: "켜면 macOS는 Seatbelt, Linux는 bwrap, Windows는 srt-win이 도구 실행을 운영체제 수준에서 가둡니다. 네트워크는 기본으로 막힙니다." },
    { title: "민감한 경로", body: "~/.ssh 아래 키나 .env 파일 같은 경로는 ‘모두 허용’을 포함해 어떤 권한 모드에서도 막힙니다." },
    { title: "자격 증명은 빼고 보냅니다", body: "API 키 같은 자격 증명은 모델로 가기 전에 항상 제거합니다. 개인 정보 가리기(PII 리댁트)는 설정에서 켜는 기능입니다." },
  ],
  plugins: {
    eyebrow: "플러그인",
    title: "git에서 오고, 해시로 확인합니다",
    body: "마켓플레이스는 marketplace.json이 든 git 저장소입니다. 설치는 동기화한 커밋에 고정되고, 파일마다 SHA-256을 기록해 실행할 때 다시 확인합니다.",
    kinds: [
      { name: "플러그인", body: "도구, 패널, 설정, 알림" },
      { name: "MCP 서버", body: "같은 권한 경로로" },
      { name: "스킬", body: "필요할 때만 본문을 불러옴" },
      { name: "에이전트", body: "역할과 지시" },
      { name: "모델 제공자", body: "모델 탭에 추가" },
      { name: "테마", body: "밝은 테마와 어두운 테마" },
      { name: "글꼴", body: "앱 전체 글꼴" },
      { name: "언어", body: "UI 번역" },
      { name: "메시징 연결", body: "원격 대화 창구" },
      { name: "로컬 폴더", body: "개발 중인 패키지" },
    ],
    cap: "공식 마켓플레이스 카탈로그에 실제로 있는 패키지를 종류마다 하나씩, 설치 검토 창에 나오는 항목(출처, 커밋, 호환, 버전)으로 보여 줍니다. 글꼴, 메시징 연결, 로컬 폴더는 공식 카탈로그에 패키지가 없습니다.",
  },
  changes: {
    eyebrow: "변경 기록",
    title: "최근 릴리스",
    body: "버전마다 무엇이 바뀌었는지 저장소의 CHANGELOG.md 그대로 옮겨 둡니다.",
  },
  get: {
    eyebrow: "내려받기",
    title: "세 운영체제에서 실행됩니다",
    body: "공개 빌드는 코드 서명이 없어서 처음 실행할 때 한 단계가 더 필요합니다. 운영체제별 단계는 내려받기 페이지에 있습니다.",
    cta: "내려받기 페이지로",
  },
  footer: {
    tagline: "에이전트가 내가 고른 모델로 내 컴퓨터에서 일하는 데스크톱 작업대.",
    copy: "© 2026 Ken Jo",
    menu: "메뉴",
    skip: "본문으로 건너뛰기",
  },
};

const en: HomeCopy = {
  meta: {
    title: "Ave — a desktop workbench where agents work on your computer",
    description:
      "Ave is a desktop app for macOS, Windows and Linux where agents read and change your files, use a terminal and a browser, with the model you choose. Anything that changes something asks first.",
  },
  hero: {
    eyebrow: "Desktop app for macOS, Windows and Linux",
    title: "A workbench where agents work on your computer",
    sub: "Ave is a desktop app where agents read and edit your project’s files, use a terminal and drive a browser. You pick the model, and anything that changes something waits for your approval first.",
    download: "Download",
    docs: "Read the docs",
    note: "Apple Silicon Macs, Windows 10 or later (x64), x86_64 Linux. Public builds are not code-signed yet.",
    pic: {
      k: "app-conversation",
      alt: "An Ave conversation in the trail-notes project: the agent added a --json flag to the export command and reports that all six tests pass",
    },
  },
  tour: {
    eyebrow: "Features",
    title: "Ave in five parts",
    body: "The browser, the terminal, models, plugins and security, each shown on the real app.",
    label: "The app screen for the current step",
  },
  work: {
    eyebrow: "Workbench",
    title: "Four conversations side by side, each on its own loop",
    body: "Window width determines how many of up to four tiles fit. A narrow window shows the focused conversation and keeps the others running. Each tile has its own conversation and loop, so one can wait for an approval while the others keep answering.",
    points: [
      ["Split either way.", "Side by side or top and bottom. A direction that would make a tile too small is shown as unavailable."],
      ["Enter queues.", "A message sent while a turn runs joins the queue and is picked up at the next brake point. ⌘/Ctrl+Enter stops the turn and sends now."],
      ["Question cards.", "When the agent needs a decision, a card with choices appears in that conversation’s tile."],
      ["Return and fork.", "Return here removes everything after one of your messages and puts its text back in the composer; Fork starts a new conversation from that point."],
      ["The work panel.", "Files, Preview, Browser, Terminal, Sub-agents and Side chat share one card beside the tile."],
    ],
    pic: {
      k: "app-subagents",
      alt: "Three tiles, each holding a different conversation: the --json change with six passing tests on the left, a parser review with its two finished sub-agents at the top right, and a release checklist for 1.2.0 below it",
    },
  },
  surfaces: {
    eyebrow: "What agents work with",
    title: "Files, a terminal, a browser and sub-agents",
    body: "Agents don’t only talk. They use the same tools you see in the work panel and the main area.",
    cards: [
      {
        title: "Chat beside the page",
        body: "Read and navigate a page from the browser pane’s own chat. That pane is the chat’s target, and tool execution goes through the permission check.",
        pic: { k: "browser-done", alt: "The Ridge Loop detail page with the browser pane’s own chat, showing real snapshot and navigation results and the finding that the elevation has no unit" },
        w: 4,
      },
      {
        title: "Question cards",
        body: "Decisions such as a version number come as a card of choices with a recommended one; picking a choice lets the turn continue.",
        pic: { k: "question-card", alt: "A question card asking “Which version should this release be?” with 1.2.0 (recommended), 1.1.1 and 2.0.0" },
        w: 2,
        inset: true,
      },
      {
        title: "A terminal in the main area",
        body: "A terminal runs a real shell. Move it from the side panel to the main area and the shell and its output carry on.",
        pic: { k: "terminal-main", alt: "The main area with a conversation beside a terminal showing git log and npm test output" },
        w: 3,
      },
      {
        title: "Sub-agents",
        body: "An agent can start sub-agents one level deep to split the work. Their progress and results are in the Sub-agents tab.",
        pic: { k: "app-subagents", alt: "The Sub-agents tab listing two finished sub-agents, Parser edge cases and Test coverage" },
        w: 3,
      },
    ],
  },
  models: {
    eyebrow: "Models",
    title: "Three ways to connect a model",
    body: "Add providers in Settings → Model. There is one model chooser, grouped by provider.",
    ways: [
      { tag: "API key", title: "With a provider key", body: "Connect OpenAI, Claude, Gemini or OpenRouter with a key. Other providers are added as marketplace packages." },
      { tag: "Your own server", title: "An OpenAI-compatible endpoint", body: "Point Ave at an OpenAI-compatible server you run, locally or in your company. The model list comes from the server." },
      { tag: "Subscription", title: "A plan you already have", body: "Sign in to a ChatGPT plan through the codex CLI you installed, run in isolation, or to a Claude subscription through the official claude CLI Ave discovers automatically. Subscription credentials never become API keys." },
    ],
    pic: { k: "model-chooser", alt: "The composer’s model chooser with local-model selected and a reasoning slider set from None to High" },
  },
  safety: {
    eyebrow: "Security",
    title: "Changes are shown and asked about before they run",
    body: "The default permission mode allows reads and asks for writes, shell commands and network requests. Requests appear in a dock at the bottom that does not cover the conversation.",
    cards: [
      {
        title: "Approve each command",
        body: "A shell command shows its risk, where it runs and whether it is isolated, then offers Reject, Always allow or Allow once.",
        pic: { k: "approval-shell", alt: "An approval card for builtin:bash: medium risk, OS isolation active (asrt), a temporary HOME for each command, and Reject, Always allow and Allow once" },
        w: 4,
        inset: true,
      },
      {
        title: "An audit log that shows tampering",
        body: "Tool calls, approvals and decisions go into an HMAC-chained audit log, so a change in the middle shows.",
        pic: { k: "audit-log", alt: "The Audit tab’s results table listing turn, tool_call, allow, approval and ask entries in time order" },
        w: 2,
        inset: true,
      },
      {
        title: "Your tabs and the agent’s tabs",
        body: "In tabs the agent opened, an approval holds per site until Ave restarts. In tabs you opened, clicking, typing and navigating ask every time.",
        pic: { k: "browser-approval", alt: "An approval card for builtin:browser_click saying the page is in a tab the agent opened and the approval holds on this site until Ave restarts" },
        w: 6,
        inset: true,
      },
    ],
  },
  safetyFacts: [
    { title: "The OS sandbox", body: "Turned on, Seatbelt on macOS, bwrap on Linux and srt-win on Windows confine tool execution at the operating-system level, and network is denied by default." },
    { title: "Sensitive paths", body: "Paths such as keys under ~/.ssh and .env files are blocked in every permission mode, Allow all included." },
    { title: "Credentials stay out", body: "API keys and other credentials are always removed before anything goes to the model. Masking personal data (PII Redaction) is a setting you turn on." },
  ],
  plugins: {
    eyebrow: "Plugins",
    title: "From git, checked by hash",
    body: "A marketplace is a git repository with a marketplace.json. Installs pin the synced commit, and each file’s SHA-256 is recorded and checked again at launch.",
    kinds: [
      { name: "Plugins", body: "Tools, panels, settings, alerts" },
      { name: "MCP servers", body: "On the same permission path" },
      { name: "Skills", body: "Body loaded only when needed" },
      { name: "Agents", body: "Roles and instructions" },
      { name: "Model providers", body: "Added to the Model tab" },
      { name: "Themes", body: "Light and dark themes" },
      { name: "Fonts", body: "The app’s typeface" },
      { name: "Languages", body: "UI translations" },
      { name: "Messaging", body: "Remote chat connections" },
      { name: "Local folders", body: "Packages you are building" },
    ],
    cap: "One real package of each kind from the official marketplace’s catalog, with what the install review shows: source, commit, compatibility and version. Fonts, messaging connections and local folders have no package in the official catalog.",
  },
  changes: {
    eyebrow: "Changelog",
    title: "The latest release",
    body: "Every version’s changes, from the repository’s CHANGELOG.md.",
  },
  get: {
    eyebrow: "Download",
    title: "Runs on three systems",
    body: "Public builds are not code-signed, so the first launch takes one extra step. The steps for each system are on the download page.",
    cta: "Go to the download page",
  },
  footer: {
    tagline: "A desktop workbench where agents work on your computer, with the model you choose.",
    copy: "© 2026 Ken Jo",
    menu: "Menu",
    skip: "Skip to content",
  },
};

export function homeCopy(locale: Locale): HomeCopy {
  return locale === "en" ? en : ko;
}
