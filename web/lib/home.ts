import type { Picture } from "./content";
import type { Locale } from "./i18n";

/**
 * Home page copy and the site-wide notices, from the product copy deck v2
 * (2026-10-27, owner-approved). Every product claim is taken from the app's
 * guide (lib/docs.ts), the feature pages, the marketplace catalog snapshot, or
 * what the captures show; the main line, the hello line and AWE are
 * positioning. The hero's built workspace replays the captures' trail-notes
 * scenario; its UI labels are the app's own English strings (src/i18n).
 *
 * Ave is Latin for hello (avē).
 */

/** A chat message; text between backticks is shown as code. */
export type Said = string;

export interface HelloDemo {
  /** What the built workspace shows, for assistive technology (it is one picture). */
  label: string;
  /** The opening greeting and Ave's answer. */
  hello: Said;
  answer: Said;
  /** The task the person types. */
  ask: Said;
  /** Ave's closing report. */
  done: Said;
}

/**
 * One of the five sections under the hero: a headline, one or two sentences,
 * and its visual: a real capture, or "files" for the built Files tab (no
 * capture of it exists yet).
 */
export interface Section {
  id: "web" | "terminal" | "files" | "models" | "connect";
  title: string;
  body: string;
  pic: Picture | "files";
}

export interface HomeCopy {
  meta: { title: string; description: string };
  hero: { title: string; sub: string; download: string; docs: string; note: string; demo: HelloDemo };
  sections: Section[];
  /** Section 5's names, from the catalog snapshot through pkg(): connectors, then plugins. */
  connectors: { mcp: string[]; plugins: string[]; label: string };
  close: { before: string; hello: string; after: string; body: string; note: string; cta: string };
  footer: { tagline: string; copy: string; menu: string; skip: string };
}

/** Catalog packages section 5 names; pkg() fails the build for one the snapshot lacks. */
const CONNECTORS = ["google-workspace-mcp", "ms-365-mcp", "slack-mcp", "notion-hosted-mcp", "todoist-mcp"];
const PLUGINS = ["meeting", "local-indexer"];

const ko: HomeCopy = {
  meta: {
    title: "Ave — 당신의 에이전트와 모든 것을 탐색하세요",
    description:
      "Ave는 에이전트가 내가 고른 모델로 웹과 파일, 터미널을 다루는 macOS, Windows, Linux용 데스크톱 앱입니다. 바꾸는 일은 실행 전에 묻습니다.",
  },
  hero: {
    title: "Ave — 당신의 에이전트와 모든 것을 탐색하세요.",
    sub: "Ave는 라틴어로 '안녕하세요'라는 뜻입니다. 인사하듯 가볍게, 에이전트와 함께 일하기를 Ave에서 시작해 보세요.",
    download: "Ave 내려받기",
    docs: "문서 읽기",
    note: "Apple Silicon Mac, Windows 10 이상(x64), x86_64 Linux. 공개 빌드는 아직 코드 서명이 없습니다.",
    demo: {
      label:
        "Ave 작업 화면을 다시 그린 장면. hello라고 인사하자 Ave가 답하고, trail-notes 프로젝트에 --json 내보내기를 넣어 달라고 하자 작업 패널이 열려 미리보기에서 트레일 목록을 읽고, src/export.js에 json 분기를 넣고, 터미널에서 npm test 6개가 모두 통과합니다.",
      hello: "hello",
      answer: "hello. trail-notes에서 무엇을 할까요?",
      ask: "트레일 목록을 확인하고 `--json` 내보내기를 넣은 다음 테스트를 돌려 줘.",
      done: "완료했습니다. `trail-notes export --json`이 트레일을 JSON으로 출력합니다. 테스트: `npm test` 6개 중 6개 통과.",
    },
  },
  sections: [
    {
      id: "web",
      title: "웹 조사는 에이전트에게",
      body: "알아볼 페이지를 열어 읽고, 링크를 따라가고, 양식도 채웁니다. 누르거나 입력하기 전에는 먼저 물어봅니다.",
      pic: { k: "browser-live-nav", alt: "메인 영역의 브라우저가 Ridge Loop 상세 페이지로 이동해 있고, 옆 사이드 채팅에 browser snapshot과 browser navigate 단계, 그리고 페이지의 고도 값에 단위가 없다는 답이 보이는 화면" },
    },
    {
      id: "terminal",
      title: "명령어 한 줄도 맡기세요",
      body: "터미널에 뜬 결과를 에이전트가 읽습니다. 실패한 테스트처럼요. 다음 명령은 허락하면 같은 창에서 바로 실행합니다.",
      pic: { k: "terminal-ask", alt: "터미널에 붙인 채팅이 실패한 테스트 출력을 읽은 뒤 같은 터미널에서 실행할 명령을 승인 카드로 보여 주는 화면" },
    },
    {
      id: "files",
      title: "무엇을 고쳤는지, 한눈에",
      body: "메모든 초안이든 코드든, 에이전트가 읽고 쓴 파일이 작업 패널의 파일 탭에 남습니다. IDE가 코드를 쓰는 곳이라면, AWE는 에이전트가 일하는 곳입니다.",
      pic: "files",
    },
    {
      id: "models",
      title: "쓰던 AI를 그대로",
      body: "API 키, 직접 띄운 OpenAI 호환 서버, 이미 구독 중인 ChatGPT나 Claude 요금제로 연결합니다. 대화하다가도 모델을 바꿀 수 있습니다.",
      pic: { k: "model-chooser", alt: "입력창의 모델 선택 팝오버. local-model 선택과 추론 수준 None, Low, Medium, High 슬라이더" },
    },
    {
      id: "connect",
      title: "메일, 일정, 회의록까지 이어서",
      body: "Gmail과 캘린더, Docs와 Sheets, Microsoft 365, Slack, Notion, Todoist를 연결하면 에이전트가 그 내용을 읽고 일을 돕습니다. 회의를 녹음해 요약하는 플러그인, 내 문서를 찾아 주는 익스텐션도 더할 수 있습니다.",
      pic: { k: "marketplace-add", alt: "마켓플레이스 탭의 추가 메뉴. 마켓플레이스 추가, Git URL이나 폴더에서 설치, MCP 서버 추가, 플러그인 만들기, 파일에서 설치" },
    },
  ],
  connectors: { mcp: CONNECTORS, plugins: PLUGINS, label: "공식 마켓플레이스의 연결과 플러그인" },
  close: {
    before: "",
    hello: "hello",
    after: "로 시작하세요. Ave와 함께.",
    body: "인사 한마디면 충분합니다. macOS, Windows, Linux용 데스크톱 앱입니다.",
    note: "공개 빌드는 아직 코드 서명이 없어서 처음 실행할 때 한 단계가 더 필요합니다.",
    cta: "Ave 내려받기",
  },
  footer: {
    tagline: "Ave는 라틴어로 hello. 당신의 에이전트와 모든 것을 탐색하는 데스크톱 앱.",
    copy: "© 2026 Ken Jo",
    menu: "메뉴",
    skip: "본문으로 건너뛰기",
  },
};

const en: HomeCopy = {
  meta: {
    title: "Ave — browse everything with your agent",
    description:
      "Ave is a desktop app for macOS, Windows and Linux where your agent works on the web, your files and a terminal, with the model you choose. Anything that changes something asks first.",
  },
  hero: {
    title: "Ave — browse everything with your agent.",
    sub: "Ave is Latin for hello. Start naturally: say hello, and begin your agent experience with Ave.",
    download: "Download Ave",
    docs: "Read the docs",
    note: "Apple Silicon Macs, Windows 10 or later (x64), x86_64 Linux. Public builds are not code-signed yet.",
    demo: {
      label:
        "A recreated Ave workspace: you say hello and Ave answers; you ask for a --json export in the trail-notes project; the work panel opens, the agent reads the trail list in Preview, adds the json case to src/export.js, and npm test passes in the terminal, 6 of 6.",
      hello: "hello",
      answer: "hello. What should we work on in trail-notes?",
      ask: "Check the trail list, add a `--json` export, run the tests.",
      done: "Done. `trail-notes export --json` prints the trails as JSON. Tests: `npm test` passes, 6 of 6.",
    },
  },
  sections: [
    {
      id: "web",
      title: "Research the web together",
      body: "Your agent opens pages in Ave's browser, reads them, follows links and fills in forms. Clicks and typing ask first.",
      pic: { k: "browser-live-nav", alt: "The browser in the main area has moved to the Ridge Loop detail page; the side chat beside it shows the browser snapshot and browser navigate steps and reports that the page’s elevation has no unit" },
    },
    {
      id: "terminal",
      title: "Hand over the command line",
      body: "Your agent reads what the terminal printed, like a failed test, and runs the next command in the same window once you allow it.",
      pic: { k: "terminal-ask", alt: "The terminal’s docked chat reads the failed test output and shows an approval card for a command in that same terminal" },
    },
    {
      id: "files",
      title: "See every file it touched",
      body: "Notes, drafts or code: the work panel's Files tab lists each file your agent read or wrote. An IDE is for code; an AWE is where agents work.",
      pic: "files",
    },
    {
      id: "models",
      title: "Bring the AI you already use",
      body: "Connect with an API key, an OpenAI-compatible server you run, or your ChatGPT or Claude plan. Switch models mid-conversation.",
      pic: { k: "model-chooser", alt: "The composer’s model chooser with local-model selected and a reasoning slider from None to High" },
    },
    {
      id: "connect",
      title: "Bring in mail, calendars and meetings",
      body: "Connect Gmail, Calendar, Docs and Sheets, Microsoft 365, Slack, Notion or Todoist, and your agent can read them. Plugins add more, like recording and summarizing meetings.",
      pic: { k: "marketplace-add", alt: "The Marketplace tab’s Add menu: Add marketplace, Install from Git URL or folder, Add MCP server, Create a plugin, Install from file" },
    },
  ],
  connectors: { mcp: CONNECTORS, plugins: PLUGINS, label: "Connectors and plugins in the official marketplace" },
  close: {
    before: "Start with ",
    hello: "hello",
    after: ". Start with Ave.",
    body: "One word is enough to begin. A desktop app for macOS, Windows and Linux.",
    note: "Public builds are not code-signed yet, so the first launch takes one extra step.",
    cta: "Download Ave",
  },
  footer: {
    tagline: "Ave is Latin for hello. A desktop app to browse everything with your agent.",
    copy: "© 2026 Ken Jo",
    menu: "Menu",
    skip: "Skip to content",
  },
};

export function homeCopy(locale: Locale): HomeCopy {
  return locale === "en" ? en : ko;
}
