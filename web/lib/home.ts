import type { Locale } from "./i18n";

/**
 * Home page copy. Every product claim here is taken from the app's own docs
 * and UI strings (permission mode labels, approval buttons, provider list,
 * marketplace source kinds), so the site names what a user will see.
 */

export type Verdict = "run" | "ask" | "review" | "block";
export type ModeId = "default" | "strict" | "auto" | "allow";

export interface HomeCopy {
  meta: { title: string; description: string };
  nav: { permissions: string; plugins: string; docs: string; download: string; lang: string; langLabel: string };
  hero: { line1: string; line2: string; lead: string; cta: string; ctaMac: string; ctaWin: string; ctaLinux: string; docs: string };
  frag: {
    windowTitle: string;
    tileA: { title: string; user: string; toolRead: string; toolReadResult: string; ai: string; dockTitle: string; dockPath: string; kind: string; risk: string; reject: string; once: string; always: string };
    tileB: { title: string; user: string; toolShell: string; running: string; queuedLabel: string; queued: string };
    composer: string;
    mode: string;
    pending: string;
    model: string;
  };
  perm: {
    title: string;
    statement: string;
    legend: string;
    modes: { id: ModeId; label: string; desc: string }[];
    tableCaption: string;
    colRequest: string;
    colKind: string;
    colResult: string;
    verdicts: Record<Verdict, string>;
    requests: { what: string; code?: string; kind: string; result: Record<ModeId, Verdict> }[];
    facts: { title: string; body: string }[];
  };
  wb: {
    title: string;
    body: string;
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
    sourcesCaption: string;
    colSource: string;
    colWhere: string;
    colTrust: string;
    sources: { name: string; where: string; trust: string }[];
    facts: { title: string; body: string }[];
  };
  side: {
    title: string;
    rows: { title: string; body: string }[];
    sidebar: { chats: string; projects: string; today: string; earlier: string; items: { label: string; when: string; mark: "dot" | "ring" | "none"; child?: boolean; on?: boolean }[] };
  };
  dl: { title: string; lead: string; get: string; guide: string; unsigned: string };
  footer: { docs: string; download: string; lang: string; copy: string };
}

const allowed = (r: Record<ModeId, Verdict>) => r;

const ko: HomeCopy = {
  meta: {
    title: "Ave — 먼저 묻는 AI 에이전트",
    description:
      "Ave는 macOS, Windows, Linux용 데스크톱 AI 에이전트 앱입니다. 파일을 읽고 쓰고 명령을 실행하되, 쓰기와 명령과 네트워크 요청은 호스트의 권한 검사를 먼저 거칩니다.",
  },
  nav: { permissions: "권한", plugins: "플러그인", docs: "문서", download: "내려받기", lang: "English", langLabel: "영어 페이지로 이동" },
  hero: {
    line1: "먼저 묻는",
    line2: "AI 에이전트",
    lead: "Ave는 macOS, Windows, Linux용 데스크톱 앱입니다. 에이전트가 내 컴퓨터에서 파일을 읽고 쓰고 명령을 실행하지만, 쓰기와 명령과 네트워크 요청은 모두 호스트의 권한 검사를 먼저 거칩니다.",
    cta: "Ave 내려받기",
    ctaMac: "Mac용 내려받기",
    ctaWin: "Windows용 내려받기",
    ctaLinux: "Linux용 내려받기",
    docs: "문서 보기",
  },
  frag: {
    windowTitle: "작업 모드",
    tileA: {
      title: "3분기 회의록 정리",
      user: "지난 분기 회의록을 모아서 보고서 초안을 써 줘",
      toolRead: "read_file  meetings/2026-07 … 09",
      toolReadResult: "14개 파일",
      ai: "회의록 14개를 읽었습니다. 결정 9건, 미결 3건으로 정리했어요. 초안을 프로젝트 폴더에 저장하려고 합니다.",
      dockTitle: "write_file 이(가) 파일을 쓰려고 합니다",
      dockPath: "q3/report.md",
      kind: "쓰기",
      risk: "위험도 중간",
      reject: "거절",
      once: "한 번만 허용",
      always: "항상 허용",
    },
    tileB: {
      title: "결제 테스트",
      user: "결제 테스트가 가끔 실패해. 원인을 찾아 줘",
      toolShell: "shell  bun test payments --repeat 20",
      running: "실행 중",
      queuedLabel: "대기 중",
      queued: "고친 다음 커밋은 하지 마",
    },
    composer: "메시지 입력…",
    mode: "쓰기만 확인",
    pending: "승인 1",
    model: "모델: 직접 선택",
  },
  perm: {
    title: "규칙 하나, 모드 넷",
    statement:
      "무엇을 해도 되는지는 모델이 아니라 호스트가 정합니다. 민감한 경로는 어느 모드에서도 막히고, 리뷰어는 위험도를 올릴 수만 있을 뿐 낮추지 못합니다.",
    legend: "권한 모드를 골라 보세요",
    modes: [
      { id: "default", label: "쓰기만 확인", desc: "기본값입니다. 읽기는 바로 하고, 바꾸는 작업은 승인을 받습니다." },
      { id: "strict", label: "모두 확인", desc: "읽기까지 모든 도구 호출에 승인을 받습니다." },
      { id: "auto", label: "자동 검증", desc: "저위험 작업은 바로 하고, 나머지는 권한 리뷰어가 검증합니다." },
      { id: "allow", label: "모두 허용", desc: "하드 차단 밖은 자동으로 허용하되, 허용 디렉터리 밖 접근은 따로 승인을 받습니다." },
    ],
    tableCaption: "같은 여섯 요청이 모드에 따라 이렇게 처리됩니다.",
    colRequest: "요청",
    colKind: "종류",
    colResult: "결과",
    verdicts: { run: "바로 실행", ask: "승인 요청", review: "리뷰어 검증", block: "차단" },
    requests: [
      { what: "프로젝트의 plan.md 읽기", kind: "읽기", result: allowed({ default: "run", strict: "ask", auto: "run", allow: "run" }) },
      { what: "plan.md 고치기", kind: "쓰기", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "테스트 실행", code: "bun test", kind: "셸", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "웹 페이지 가져오기", kind: "네트워크", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "허용 디렉터리 밖에 저장", code: "~/Desktop/report.md", kind: "쓰기", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "ask" }) },
      { what: "SSH 키 읽기", code: "~/.ssh/id_ed25519", kind: "읽기", result: allowed({ default: "block", strict: "block", auto: "block", allow: "block" }) },
    ],
    facts: [
      { title: "항상 허용은 좁게", body: "항상 허용은 그 도구, 그 입력, 그 작업 폴더에만 묶입니다. 비슷한 다른 호출까지 열리지 않습니다." },
      { title: "승인은 화면 아래에서", body: "승인 요청은 화면 아래 독에 쌓입니다. 대화를 가리지 않으니 앞뒤를 읽고 결정할 수 있습니다." },
      { title: "리뷰어가 멈추면 보류", body: "리뷰어가 답하지 못하면 통과가 아니라 보류입니다. 헤드리스 실행의 위험한 단계는 대기열에서 나를 기다립니다." },
      { title: "고칠 수 없는 감사 로그", body: "~/.ave/audit.log 는 HMAC 체인으로 이어져 중간을 고치면 드러납니다. 비밀 값은 기록하지 않습니다." },
      { title: "보내기 전에 가림", body: "비밀 값과 개인정보는 모델로 보내기 전에 가려지고, 가린 사실은 감사 로그에 남습니다." },
      { title: "OS 샌드박스는 선택", body: "켜면 macOS는 Seatbelt, Linux는 bwrap, Windows는 srt-win으로 도구 실행을 가두고 네트워크를 기본 차단합니다. 기본값은 꺼짐입니다." },
    ],
  },
  wb: {
    title: "대화 넷을 나란히",
    body: "작업 모드에서는 창을 최대 네 칸으로 나눕니다. 칸마다 자기 대화를 갖고 따로 답을 받습니다. 지금 입력이 들어갈 칸은 테두리로 보입니다.",
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
    subs: "ChatGPT 요금제는 격리된 로컬 Codex 런타임으로, Claude 구독은 내가 고른 공식 claude CLI로 연결합니다. 구독 자격 증명이 API 키로 바뀌는 일은 없습니다.",
    providers: ["OpenAI", "Anthropic", "Gemini", "Vertex AI", "Azure AI Foundry", "OpenRouter", "DeepSeek", "Mistral", "Groq", "xAI"],
    local: ["Ollama", "LM Studio", "LiteLLM", "OpenAI 호환 서버"],
  },
  plugins: {
    title: "플러그인은 git에서",
    body: "마켓플레이스는 marketplace.json 이 든 git 저장소입니다. 설치는 동기화한 커밋에 고정되고, 받은 파일마다 SHA-256을 기록해 실행할 때 다시 확인합니다. 어긋나면 그 플러그인은 올라오지 않습니다.",
    codeNote: "링크는 확인 화면만 엽니다. 설치는 내가 확인한 뒤에 일어납니다.",
    codeComment1: "# 마켓플레이스 추가",
    codeComment2: "# 패키지 설치",
    sourcesCaption: "어디서 받는지",
    colSource: "소스",
    colWhere: "추가하는 곳",
    colTrust: "다른 점",
    sources: [
      { name: "공식", where: "Ave에 들어 있습니다.", trust: "호스트 비밀 값 권한을 받을 수 있는 유일한 소스입니다." },
      { name: "관리", where: "기기 정책 파일의 marketplaces.additional", trust: "조직이 허용·차단 목록과 필수 설치를 정합니다." },
      { name: "사용자 지정", where: "설정 → 마켓플레이스 → 추가", trust: "내가 고른 git 저장소입니다." },
      { name: "직접", where: "git 폴더 하나", trust: "저장소 전체가 아니라 패키지 하나만 받습니다." },
    ],
    facts: [
      { title: "따로 도는 프로세스", body: "플러그인은 앱과 다른 프로세스에서 돕니다. 하나가 시작에 실패해도 나머지는 그대로 일하고, 그 플러그인을 부르면 실제 이유를 알려 줍니다." },
      { title: "네트워크는 호스트를 거쳐", body: "플러그인은 선언한 도메인 최대 16개에만 나갈 수 있고, 요청은 호스트가 한 번에 한 홉씩 보냅니다. 리디렉션도 매번 다시 검사합니다." },
      { title: "업데이트는 조용할 때", body: "부팅 때와 하루 한 번, 쉬고 있을 때만 확인합니다. 권한, MCP 서버, 훅이 그대로면 자동으로 적용하고, 달라졌으면 내 검토를 기다립니다." },
      { title: "회수할 수 있는 버전", body: "소스는 revocations.json 으로 특정 버전을 끄거나 지울 수 있고, 그 소스에서 설치한 것에만 적용됩니다." },
      { title: "담을 수 있는 것", body: "플러그인, MCP 서버, 스킬, 에이전트, 테마, 글꼴, 언어, 모델 제공자, 메시징 연결을 같은 방식으로 배포합니다." },
      { title: "기본으로 들어오는 둘", body: "회의 플러그인과 로컬 인덱서 플러그인은 처음 설치할 때 함께 들어옵니다." },
    ],
  },
  side: {
    title: "곁에서 도는 일",
    rows: [
      { title: "로컬 인덱스", body: "로컬 인덱서 플러그인이 내 문서를 색인합니다. 키워드(BM25)와 벡터 검색 결과를 순위 융합으로 합쳐 대화에 가져오고, 색인은 ~/.ave 아래에 둡니다." },
      { title: "회의", body: "마이크와 시스템 소리는 호스트가 받고, 회의 플러그인이 받아쓰기와 요약을 맡습니다. 요약 알림은 내가 켰을 때만 옵니다." },
      { title: "루틴", body: "매일, 매주, 매월, 일정 간격, cron 식으로, 또는 앱을 끌 때 실행합니다. 실행마다 따로 대화가 생겨 채팅 목록에 남고, 쓸 수 있는 플러그인과 폴더도 루틴마다 정합니다." },
      { title: "서브에이전트", body: "에이전트가 하위 에이전트를 한 단계까지 띄우고, agent_send 와 agent_guide 로 서로 메시지를 보냅니다. 우편함이 디스크에 남아 멈춘 하위 에이전트를 다시 이어 갈 수 있습니다." },
      { title: "스킬, MCP, 훅", body: "스킬은 이름과 설명만 프롬프트에 두고 본문은 필요할 때 불러오며, 첫 로드는 승인을 받습니다. MCP 서버와 플러그인 도구는 같은 권한 경로를 지나고, PreToolUse 같은 훅으로 내 스크립트를 끼울 수 있습니다." },
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
    title: "Ave — the AI agent that asks first",
    description:
      "Ave is a desktop AI agent app for macOS, Windows and Linux. It reads and writes files and runs commands, and every write, command and network request passes the host's permission check first.",
  },
  nav: { permissions: "Permissions", plugins: "Plugins", docs: "Docs", download: "Download", lang: "한국어", langLabel: "Go to the Korean page" },
  hero: {
    line1: "The agent",
    line2: "that asks first",
    lead: "Ave is a desktop app for macOS, Windows and Linux. Its agents read and write files and run commands on your computer, and every write, command and network request passes the host’s permission check first.",
    cta: "Download Ave",
    ctaMac: "Download for Mac",
    ctaWin: "Download for Windows",
    ctaLinux: "Download for Linux",
    docs: "Read the docs",
  },
  frag: {
    windowTitle: "Work mode",
    tileA: {
      title: "Q3 meeting notes",
      user: "Collect last quarter’s meeting notes and draft a report",
      toolRead: "read_file  meetings/2026-07 … 09",
      toolReadResult: "14 files",
      ai: "I read 14 sets of notes: 9 decisions, 3 open items. I’d like to save the draft in the project folder.",
      dockTitle: "write_file wants to write a file",
      dockPath: "q3/report.md",
      kind: "write",
      risk: "risk: medium",
      reject: "Reject",
      once: "Allow once",
      always: "Always allow",
    },
    tileB: {
      title: "Payments test",
      user: "The payments test fails now and then. Find out why",
      toolShell: "shell  bun test payments --repeat 20",
      running: "running",
      queuedLabel: "Queued",
      queued: "Don’t commit after the fix",
    },
    composer: "Message…",
    mode: "Confirm writes",
    pending: "Approval 1",
    model: "Model: your choice",
  },
  perm: {
    title: "One rule, four modes",
    statement:
      "The host, not the model, decides what an agent may do. Sensitive paths are blocked in every mode, and the reviewer can raise a risk rating but never lower it.",
    legend: "Pick a permission mode",
    modes: [
      { id: "default", label: "Confirm writes", desc: "The default. Reads run; anything that changes something asks first." },
      { id: "strict", label: "Confirm all", desc: "Every tool call asks for approval, reads included." },
      { id: "auto", label: "Auto-verify", desc: "Low-risk work runs; the rest is checked by the permission reviewer." },
      { id: "allow", label: "Allow all", desc: "Everything outside the hard blocks runs, but access outside the allowed folders still asks." },
    ],
    tableCaption: "The same six requests, handled by the mode you picked.",
    colRequest: "Request",
    colKind: "Kind",
    colResult: "Result",
    verdicts: { run: "Runs", ask: "Asks you", review: "Reviewer checks", block: "Blocked" },
    requests: [
      { what: "Read plan.md in the project", kind: "read", result: allowed({ default: "run", strict: "ask", auto: "run", allow: "run" }) },
      { what: "Edit plan.md", kind: "write", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "Run the tests", code: "bun test", kind: "shell", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "Fetch a web page", kind: "network", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "run" }) },
      { what: "Save outside the allowed folders", code: "~/Desktop/report.md", kind: "write", result: allowed({ default: "ask", strict: "ask", auto: "review", allow: "ask" }) },
      { what: "Read an SSH key", code: "~/.ssh/id_ed25519", kind: "read", result: allowed({ default: "block", strict: "block", auto: "block", allow: "block" }) },
    ],
    facts: [
      { title: "Always allow, narrowly", body: "Always allow is bound to that tool, that input and that working folder. It never opens similar calls." },
      { title: "Approvals sit below", body: "Requests stack in a dock at the bottom of the window. Nothing covers the conversation, so you can read before you decide." },
      { title: "A silent reviewer holds", body: "If the reviewer cannot answer, the request is held, not passed. Risky steps in headless runs wait in a queue for you." },
      { title: "An audit log you can’t edit", body: "~/.ave/audit.log is HMAC-chained, so a change in the middle shows. Secret values are never written to it." },
      { title: "Masked before sending", body: "Secrets and personal data are masked before anything goes to the model, and each mask is recorded in the audit log." },
      { title: "OS sandbox, opt-in", body: "Turn it on and tools run inside Seatbelt on macOS, bwrap on Linux and srt-win on Windows, with network denied by default. It ships off." },
    ],
  },
  wb: {
    title: "Four chats side by side",
    body: "Work mode splits the window into up to four tiles. Each tile holds its own conversation and streams on its own. A frame shows which tile your next keystroke lands in.",
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
    subs: "A ChatGPT plan connects through an isolated local Codex runtime; a Claude subscription through the official claude CLI you choose. Subscription credentials never turn into API keys.",
    providers: ["OpenAI", "Anthropic", "Gemini", "Vertex AI", "Azure AI Foundry", "OpenRouter", "DeepSeek", "Mistral", "Groq", "xAI"],
    local: ["Ollama", "LM Studio", "LiteLLM", "any OpenAI-compatible server"],
  },
  plugins: {
    title: "Plugins come from git",
    body: "A marketplace is a git repository with a marketplace.json. Installs pin the synced commit, every file is recorded by SHA-256, and the record is checked again at launch. A plugin that doesn’t match is not loaded.",
    codeNote: "A link only opens a confirmation screen. Nothing installs until you confirm.",
    codeComment1: "# add a marketplace",
    codeComment2: "# install a package",
    sourcesCaption: "Where packages come from",
    colSource: "Source",
    colWhere: "Added from",
    colTrust: "What differs",
    sources: [
      { name: "Official", where: "Built into Ave.", trust: "The only source whose plugins can be granted host secrets." },
      { name: "Managed", where: "marketplaces.additional in the machine policy file", trust: "An organisation sets allow and block lists and required installs." },
      { name: "Custom", where: "Settings → Marketplace → Add", trust: "A git repository you chose." },
      { name: "Direct", where: "One git folder", trust: "A single package, not a whole repository." },
    ],
    facts: [
      { title: "A process of its own", body: "Plugins run outside the app process. If one fails to start, the rest keep working, and calls to the failed one report the real reason." },
      { title: "Network through the host", body: "A plugin reaches only the domains it declares, sixteen at most, and the host sends each request one hop at a time, checking every redirect again." },
      { title: "Updates when idle", body: "Checked at launch and once a day, only while you’re idle. If permissions, MCP servers and hooks are unchanged it applies; if not, it waits for your review." },
      { title: "Versions can be recalled", body: "A source can disable or remove a version through revocations.json, and it applies only to installs from that source." },
      { title: "What it carries", body: "Plugins, MCP servers, skills, agents, themes, fonts, languages, model providers and messaging connections all ship the same way." },
      { title: "Two come with Ave", body: "The meeting plugin and the local indexer are installed on first run." },
    ],
  },
  side: {
    title: "Work that runs alongside",
    rows: [
      { title: "Local index", body: "The local indexer plugin indexes your documents. Keyword (BM25) and vector results are merged by rank fusion and brought into the conversation; the index lives under ~/.ave." },
      { title: "Meetings", body: "The host captures microphone and system audio; the meeting plugin transcribes and summarises. Summary alerts arrive only if you turn them on." },
      { title: "Routines", body: "Run daily, weekly, monthly, on an interval, on a cron expression, or when the app shuts down. Each run is its own conversation in the chat list, with its own plugins and folders allowed." },
      { title: "Sub-agents", body: "An agent can start sub-agents one level deep and trade messages with agent_send and agent_guide. Mailboxes are kept on disk, so a paused sub-agent can be resumed." },
      { title: "Skills, MCP, hooks", body: "Skills keep only a name and description in the prompt and load the body when needed, asking the first time. MCP servers and plugin tools share one permission path, and hooks such as PreToolUse run your own scripts." },
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
