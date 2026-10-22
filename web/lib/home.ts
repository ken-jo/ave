import type { Locale } from "./i18n";

/**
 * Home page copy. Every product claim here is taken from the app's own docs
 * and UI strings (provider list, marketplace source kinds, work mode keys),
 * so the site names what a user will see. "Ave" is Latin for hello; the
 * greeting and the harness picture are the page's frame, the facts are the
 * app's.
 */

export interface HomeCopy {
  meta: { title: string; description: string };
  nav: { models: string; plugins: string; docs: string; download: string; lang: string; langLabel: string; menu: string };
  hero: { pill: string; title: string; sub: string; cta: string; ctaMac: string; ctaWin: string; ctaLinux: string; docs: string };
  harness: {
    label: string;
    you: string;
    youSays: string;
    ave: string;
    aveRole: string;
    models: string;
    computer: string;
    computerItems: string[];
    toolLine: string;
  };
  intro: { claim: string; rest: string; control: string; controlLink: string };
  wb: {
    title: string;
    body: string;
    windowTitle: string;
    keys: { key: string; body: string }[];
    quad: { title: string; state: string; tone: "go" | "warn" | "plain"; line: string; excerpt: string }[];
  };
  models: { title: string; body: string; subs: string; providers: string[]; local: string[] };
  plugins: {
    title: string;
    body: string;
    codeNote: string;
    codeComment1: string;
    codeComment2: string;
    sceneLabel: string;
    repo: string;
    check: string;
    /** Five of the ten package kinds the marketplace accepts, then the rest as a count. */
    kinds: string[];
    kindsMore: string;
    facts: { title: string; body: string }[];
  };
  side: {
    title: string;
    sceneLabel: string;
    rows: { title: string; body: string }[];
    sidebar: { chats: string; projects: string; today: string; earlier: string; items: { label: string; when: string; mark: "dot" | "ring" | "none"; child?: boolean; on?: boolean }[] };
  };
  dl: { title: string; lead: string; get: string; guide: string; unsigned: string };
  footer: { docs: string; download: string; lang: string; copy: string };
}

const ko: HomeCopy = {
  meta: {
    title: "Ave — 안녕하세요, 에이전트를 위한 하네스",
    description:
      "Ave는 라틴어로 ‘안녕’이라는 인사입니다. 나와 에이전트, 내가 고른 모델, 내 컴퓨터가 만나는 macOS, Windows, Linux용 데스크톱 앱입니다.",
  },
  nav: { models: "모델", plugins: "플러그인", docs: "문서", download: "내려받기", lang: "English", langLabel: "영어 페이지로 이동", menu: "메뉴" },
  hero: {
    pill: "Ave · 라틴어로 ‘안녕’",
    title: "안녕하세요, Ave입니다",
    sub: "나와 에이전트, 내가 고른 모델, 내 컴퓨터가 한자리에서 만나는 데스크톱 하네스.",
    cta: "Ave 내려받기",
    ctaMac: "Mac용 내려받기",
    ctaWin: "Windows용 내려받기",
    ctaLinux: "Linux용 내려받기",
    docs: "문서 보기",
  },
  harness: {
    label: "나의 메시지가 Ave를 거쳐 모델에 닿고, 에이전트가 내 컴퓨터의 파일, 셸, 플러그인, MCP 서버로 일하는 그림",
    you: "나",
    youSays: "지난 분기 회의록을 모아서 보고서 초안을 써 줘",
    ave: "Ave",
    aveRole: "하네스",
    models: "모델",
    computer: "내 컴퓨터",
    computerItems: ["파일", "셸", "플러그인", "MCP 서버"],
    toolLine: "read_file  meetings/2026-07 … 09",
  },
  intro: {
    claim: "Ave는 라틴어로 ‘안녕’이라는 인사입니다.",
    rest: "macOS, Windows, Linux용 데스크톱 앱으로, 에이전트가 내가 고른 모델로 내 컴퓨터의 파일을 읽고 쓰고 명령을 실행합니다.",
    control: "쓰기와 명령, 네트워크 요청은 호스트의 권한 검사를 먼저 거치고, 얼마나 자주 물을지는 내가 정합니다.",
    controlLink: "권한이 동작하는 방식",
  },
  wb: {
    title: "대화 넷을 나란히",
    body: "작업 모드에서는 창을 최대 네 칸으로 나눕니다. 칸마다 자기 대화를 갖고 따로 답을 받습니다. 지금 입력이 들어갈 칸은 테두리로 보입니다.",
    windowTitle: "작업 모드",
    keys: [
      { key: "Enter", body: "답하는 중에 누르면 메시지가 대기열에 들어가고, 진행 중인 턴이 다음 쉼표에서 받아 갑니다." },
      { key: "⌘ / Ctrl + Enter", body: "진행 중인 턴을 멈추고 바로 보냅니다. 멈춘 답에는 ‘사용자가 중지함’ 표시가 남습니다." },
      { key: "여기로 돌아가기", body: "그 메시지 뒤를 모두 지우고 글을 입력창에 돌려놓습니다. 같은 대화에서 다시 씁니다." },
      { key: "포크", body: "그 지점에서 새 대화를 갈라냅니다. 원래 대화는 그대로 남습니다." },
      { key: "작업 패널", body: "파일, 미리보기, 브라우저, 터미널, 서브에이전트, 사이드 채팅이 칸 옆의 카드 하나에 모입니다." },
    ],
    quad: [
      { title: "3분기 보고서", state: "승인 대기", tone: "warn", line: "write_file  q3/report.md", excerpt: "초안을 프로젝트 폴더에 저장하려고 합니다. 허용하면 바로 씁니다." },
      { title: "결제 테스트", state: "응답 중", tone: "go", line: "shell  bun test payments", excerpt: "20번 중 3번 실패했습니다. 시간대 처리 쪽을 보고 있습니다" },
      { title: "주간 회의 요약", state: "완료", tone: "plain", line: "결정 4건, 할 일 7건", excerpt: "다음 회의 전까지 담당자별 할 일을 표로 정리했습니다." },
      { title: "API 문서 번역", state: "읽지 않음", tone: "plain", line: "18개 중 18개 끝", excerpt: "용어집을 따라 번역했고 바뀐 용어 5개를 따로 적었습니다." },
    ],
  },
  models: {
    title: "모델은 직접 고릅니다",
    body: "API 키, 직접 띄운 서버, 이미 쓰는 구독 가운데 고르세요. 설정의 모델 탭에서 제공자를 추가하고, 실패하면 다음 모델로 넘기는 대체 체인도 만들 수 있습니다.",
    subs: "ChatGPT 요금제는 내가 설치한 codex CLI를 격리해 실행하는 방식으로, Claude 구독은 내가 설치한 공식 claude CLI를 Ave가 찾아 연결합니다. 구독 자격 증명이 API 키로 바뀌는 일은 없습니다.",
    providers: ["OpenAI", "Claude", "Gemini", "OpenRouter", "OpenAI 호환 서버"],
    local: ["그 밖의 제공자는 마켓플레이스 패키지로"],
  },
  plugins: {
    title: "플러그인은 git에서",
    body: "마켓플레이스는 marketplace.json 이 든 git 저장소입니다. 설치는 동기화한 커밋에 고정되고, 받은 파일마다 SHA-256을 기록해 실행할 때 다시 확인합니다. 어긋나면 그 플러그인은 올라오지 않습니다.",
    codeNote: "링크는 확인 화면만 엽니다. 설치는 내가 확인한 뒤에 일어납니다.",
    codeComment1: "# 마켓플레이스 추가",
    codeComment2: "# 패키지 설치",
    sceneLabel: "git 저장소의 marketplace.json 에서 받은 패키지가 SHA-256 확인을 거쳐 Ave에 플러그인, MCP 서버, 스킬, 에이전트, 테마 외 5종으로 들어오는 그림",
    repo: "git 저장소",
    check: "SHA-256 확인",
    kinds: ["플러그인", "MCP 서버", "스킬", "에이전트", "테마"],
    kindsMore: "외 5종",
    facts: [
      { title: "따로 도는 프로세스", body: "플러그인은 앱과 다른 프로세스에서 돕니다. 하나가 시작에 실패해도 나머지는 그대로 일하고, 그 플러그인을 부르면 실제 이유를 알려 줍니다." },
      { title: "적용은 조용할 때", body: "새 버전은 부팅 때와 정해진 간격으로 확인하고, 적용은 대화가 쉬고 있을 때 하나씩 합니다. 권한, MCP 서버, 훅이 바뀌었거나 승인을 다시 확인해야 하면 자동으로 적용하지 않고 내 검토를 기다립니다." },
      { title: "기본으로 들어오는 둘", body: "회의 플러그인과 로컬 인덱서 플러그인은 처음 설치할 때 함께 들어옵니다." },
    ],
  },
  side: {
    title: "곁에서 도는 일",
    sceneLabel: "로컬 인덱스, 회의, 루틴, 서브에이전트가 각자 채팅 목록의 대화로 들어오는 그림",
    rows: [
      { title: "로컬 인덱스", body: "로컬 인덱서 플러그인이 내 문서를 색인합니다. 키워드(BM25)와 벡터 검색 결과를 순위 융합으로 합쳐 대화에 가져오고, 색인은 ~/.ave 아래에 둡니다." },
      { title: "회의", body: "마이크와 시스템 소리는 호스트가 받고, 회의 플러그인이 받아쓰기와 요약을 맡습니다. 요약 알림은 내가 켰을 때만 옵니다." },
      { title: "루틴", body: "매일, 매주, 매월, 일정 간격, cron 식으로, 또는 앱을 끌 때 실행합니다. 실행마다 따로 대화가 생겨 채팅 목록에 남고, 쓸 수 있는 플러그인과 폴더도 루틴마다 정합니다." },
      { title: "서브에이전트", body: "에이전트가 하위 에이전트를 한 단계까지 띄우고, agent_send 와 agent_guide 로 서로 메시지를 보냅니다. 우편함이 디스크에 남아 멈춘 하위 에이전트를 다시 이어 갈 수 있습니다." },
    ],
    sidebar: {
      chats: "채팅",
      projects: "프로젝트",
      today: "오늘",
      earlier: "이전",
      items: [
        { label: "3분기 회의록 정리", when: "응답 중", mark: "dot", on: true },
        { label: "보고서 표 검토", when: "사이드", mark: "none", child: true },
        { label: "아침 브리핑", when: "루틴 07:30", mark: "ring" },
        { label: "결제 테스트", when: "14:02", mark: "none" },
        { label: "로그 분석", when: "서브에이전트", mark: "none", child: true },
        { label: "주간 회의 요약", when: "어제", mark: "none" },
        { label: "API 문서 번역", when: "월", mark: "none" },
      ],
    },
  },
  dl: {
    title: "Ave 내려받기",
    lead: "Apple Silicon Mac, Windows 10 이상, x86_64 Linux에서 돌아갑니다. 지금 배포하는 빌드는 서명되지 않아 처음 실행할 때 한 단계가 더 필요합니다.",
    get: "내려받기",
    guide: "설치 안내 전체 보기",
    unsigned: "서명 없는 빌드라 macOS는 격리 표시를 지워야 하고, Windows는 SmartScreen 경고가 뜹니다.",
  },
  footer: { docs: "문서", download: "내려받기", lang: "English", copy: "© 2026 Ken Jo" },
};

const en: HomeCopy = {
  meta: {
    title: "Ave — hello, and a harness for your agents",
    description:
      "Ave is Latin for hello. It is a desktop app for macOS, Windows and Linux where you, your agents, the models you choose and your computer meet.",
  },
  nav: { models: "Models", plugins: "Plugins", docs: "Docs", download: "Download", lang: "한국어", langLabel: "Go to the Korean page", menu: "Menu" },
  hero: {
    pill: "Ave · Latin for hello",
    title: "Hello, I’m Ave",
    sub: "The desktop harness where you, your agents, the models you choose and your computer meet.",
    cta: "Download Ave",
    ctaMac: "Download for Mac",
    ctaWin: "Download for Windows",
    ctaLinux: "Download for Linux",
    docs: "Read the docs",
  },
  harness: {
    label: "Your message passes through Ave to a model, and the agent works on your computer through files, the shell, plugins and MCP servers",
    you: "You",
    youSays: "Collect last quarter’s meeting notes and draft a report",
    ave: "Ave",
    aveRole: "harness",
    models: "Models",
    computer: "Your computer",
    computerItems: ["Files", "Shell", "Plugins", "MCP servers"],
    toolLine: "read_file  meetings/2026-07 … 09",
  },
  intro: {
    claim: "Ave is Latin for hello.",
    rest: "It is a desktop app for macOS, Windows and Linux where agents read and write files and run commands on your computer, with the models you bring.",
    control: "Writes, commands and network requests pass the host’s permission check first, and you choose how often it asks.",
    controlLink: "How permissions work",
  },
  wb: {
    title: "Four chats side by side",
    body: "Work mode splits the window into up to four tiles. Each tile holds its own conversation and streams on its own. A frame shows which tile your next keystroke lands in.",
    windowTitle: "Work mode",
    keys: [
      { key: "Enter", body: "While a turn is running, the message joins the queue and the turn picks it up at its next brake point." },
      { key: "⌘ / Ctrl + Enter", body: "Stops the running turn and sends now. The stopped answer keeps a “stopped by user” badge." },
      { key: "Return here", body: "Clears everything after that message and puts its text back in the composer, in the same conversation." },
      { key: "Fork", body: "Starts a new conversation from that point. The original stays as it was." },
      { key: "Work panel", body: "Files, Preview, Browser, Terminal, Sub-agents and Side chat share one card beside the tile." },
    ],
    quad: [
      { title: "Q3 report", state: "Approval", tone: "warn", line: "write_file  q3/report.md", excerpt: "I’d like to save the draft in the project folder. Allow it and I’ll write it now." },
      { title: "Payments test", state: "Responding", tone: "go", line: "shell  bun test payments", excerpt: "3 of 20 runs failed. Looking at the time-zone handling" },
      { title: "Weekly sync summary", state: "Done", tone: "plain", line: "4 decisions, 7 to-dos", excerpt: "A table of to-dos by owner, ready before the next sync." },
      { title: "Translate API docs", state: "Unread", tone: "plain", line: "18 of 18 pages", excerpt: "Translated against the glossary; 5 changed terms are listed apart." },
    ],
  },
  models: {
    title: "Bring your own model",
    body: "Use an API key, a server you run yourself, or a subscription you already pay for. Add providers in the Model tab of Settings, and set a fallback chain that hands a failed turn to the next model.",
    subs: "A ChatGPT plan connects through the codex CLI you installed, run in isolation; a Claude subscription through the official claude CLI you installed, which Ave finds for you. Subscription credentials never turn into API keys.",
    providers: ["OpenAI", "Claude", "Gemini", "OpenRouter", "any OpenAI-compatible server"],
    local: ["more providers as marketplace packages"],
  },
  plugins: {
    title: "Plugins come from git",
    body: "A marketplace is a git repository with a marketplace.json. Installs pin the synced commit, every file is recorded by SHA-256, and the record is checked again at launch. A plugin that doesn’t match is not loaded.",
    codeNote: "A link only opens a confirmation screen. Nothing installs until you confirm.",
    codeComment1: "# add a marketplace",
    codeComment2: "# install a package",
    sceneLabel: "Packages from a git repository’s marketplace.json pass a SHA-256 check and arrive in Ave as plugins, MCP servers, skills, agents, themes and five more kinds",
    repo: "git repository",
    check: "SHA-256 check",
    kinds: ["Plugins", "MCP servers", "Skills", "Agents", "Themes"],
    kindsMore: "+5 more kinds",
    facts: [
      { title: "A process of its own", body: "Plugins run outside the app process. If one fails to start, the rest keep working, and calls to the failed one report the real reason." },
      { title: "Applied when idle", body: "New versions are checked at launch and on a schedule, and applied one at a time while the conversation is idle. If permissions, MCP servers or hooks changed, or an approval needs confirming again, the update waits for your review instead of applying itself." },
      { title: "Two come with Ave", body: "The meeting plugin and the local indexer are installed on first run." },
    ],
  },
  side: {
    title: "Work that runs alongside",
    sceneLabel: "The local index, meetings, routines and sub-agents each arrive as conversations in the chat list",
    rows: [
      { title: "Local index", body: "The local indexer plugin indexes your documents. Keyword (BM25) and vector results are merged by rank fusion and brought into the conversation; the index lives under ~/.ave." },
      { title: "Meetings", body: "The host captures microphone and system audio; the meeting plugin transcribes and summarises. Summary alerts arrive only if you turn them on." },
      { title: "Routines", body: "Run daily, weekly, monthly, on an interval, on a cron expression, or when the app shuts down. Each run is its own conversation in the chat list, with its own plugins and folders allowed." },
      { title: "Sub-agents", body: "An agent can start sub-agents one level deep and trade messages with agent_send and agent_guide. Mailboxes are kept on disk, so a paused sub-agent can be resumed." },
    ],
    sidebar: {
      chats: "Chats",
      projects: "Projects",
      today: "Today",
      earlier: "Earlier",
      items: [
        { label: "Q3 meeting notes", when: "responding", mark: "dot", on: true },
        { label: "Check the report tables", when: "side chat", mark: "none", child: true },
        { label: "Morning briefing", when: "routine 07:30", mark: "ring" },
        { label: "Payments test", when: "14:02", mark: "none" },
        { label: "Log analysis", when: "sub-agent", mark: "none", child: true },
        { label: "Weekly sync summary", when: "Yesterday", mark: "none" },
        { label: "Translate API docs", when: "Mon", mark: "none" },
      ],
    },
  },
  dl: {
    title: "Get Ave",
    lead: "Runs on Apple Silicon Macs, Windows 10 and later, and x86_64 Linux. Current builds are unsigned, so the first launch takes one extra step.",
    get: "Download",
    guide: "Full install guide",
    unsigned: "Unsigned builds: on macOS you clear the quarantine flag, on Windows SmartScreen shows a warning.",
  },
  footer: { docs: "Docs", download: "Download", lang: "한국어", copy: "© 2026 Ken Jo" },
};

export function homeCopy(locale: Locale): HomeCopy {
  return locale === "en" ? en : ko;
}
