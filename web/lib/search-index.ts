import { searchEntriesEn } from "./search-index.en";

export interface SearchEntry {
  href: string;
  title: string;
  group: string;
  snippet: string;
  keywords?: string[];
}

export const searchIndex: SearchEntry[] = [
  // Getting Started
  { group: "시작하기", href: "/docs/", title: "Ave AI 개요", snippet: "데스크톱 호스트 · 익스텐션 런타임 · 스토리지 · 서버 4 레이어", keywords: ["overview", "intro"] },
  { group: "시작하기", href: "/docs/getting-started/install", title: "설치 & 첫 실행", snippet: "macOS arm64 / Windows / Linux AppImage · electron-updater · ave:// 등록" },
  { group: "시작하기", href: "/docs/getting-started/login", title: "로그인 & 첫 화면", snippet: "Ave 계정 없음 · 익스텐션별 OAuth · 비공개 마켓플레이스 토큰", keywords: ["sso", "auth", "oauth", "token"] },
  { group: "시작하기", href: "/docs/getting-started/updates", title: "앱 업데이트", snippet: "electron-updater · autoDownload=false · 4h interval · channel=latest" },

  // Host · Chat
  { group: "채팅", href: "/docs/chat/layout", title: "채팅 화면 구성", snippet: "App · Sidebar · MainToolbar · PaneFrame 타일 · ChatGroupSession · ChatView" },
  { group: "채팅", href: "/docs/chat/message-queue", title: "메시지 큐 & Tasks", snippet: "MessageQueuePanel + SessionTasksPanel · 컴포저 위 · 비어 있으면 표시 안 함" },
  { group: "채팅", href: "/docs/chat/tool-thinking", title: "Tool & Thinking 표시", snippet: "Tool Registry · 출처 3종 · 백그라운드 셸 · 이미지 보기 · 도구 검색" },
  { group: "채팅", href: "/docs/chat/question-cards", title: "질문 카드", snippet: "AskUserQuestionItem · choice-only · choice/choices · recommendedIndex · altIndices" },
  { group: "채팅", href: "/docs/chat/plugin-panel", title: "익스텐션 패널", snippet: "manifest ui[] 슬롯 · 번들 Skill · 순수 Tool · 정규식 ^[a-zA-Z_][a-zA-Z0-9_]*$" },
  { group: "채팅", href: "/docs/chat/permissions/directory", title: "권한 — 디렉토리", snippet: "storage sandbox + 호스트 grant · ~/.ave/permissions.json (0o600)" },
  { group: "채팅", href: "/docs/chat/permissions/llm-review", title: "권한 — LLM 자율검토", snippet: "Reviewer 4모드 disabled/rule/llm/strict" },
  { group: "채팅", href: "/docs/chat/permissions/risk", title: "권한 — 위험 관리", snippet: "RiskLevel low/medium/high × Category 5종 격자 · agentApproval" },

  // Host Features
  { group: "호스트 기능", href: "/docs/host/skills", title: "Skills — 능력 꾸러미", snippet: "자주 쓰는 작업을 한 줄로 부르기. 트리거 키워드 + 도구 매핑 + 위험도", keywords: ["skill", "skills", "키워드"] },
  { group: "호스트 기능", href: "/docs/host/agents", title: "Agents — 작은 작업 단위", snippet: "하나의 작업을 잘 해내는 자율 단위. 에이전트가 하위 에이전트를 띄우고 이어받기", keywords: ["agent", "agents", "에이전트", "하위 에이전트", "subagent"] },
  { group: "호스트 기능", href: "/docs/host/memory", title: "MEMORY — 알려준 사실 기억", snippet: "역할 · 선호 · 제한 사항. 자동 추출은 기본 꺼짐 · 프로젝트 AGENTS.md 도 참고", keywords: ["memory", "메모리", "기억", "AGENTS.md"] },
  { group: "호스트 기능", href: "/docs/host/mcp", title: "MCP — 외부 도구 가져오기", snippet: "외부 서버의 도구 · 리소스 · 프롬프트 · 안내문. 외부 도구는 위험도 자동 허용에서 걸러져 확인 카드로", keywords: ["mcp", "외부 도구", "리소스", "프롬프트", "resource", "prompt"] },
  { group: "호스트 기능", href: "/docs/host/onboarding", title: "온보딩 — 처음 시작 안내", snippet: "첫 실행 시 여섯 단계 안내 + 화면을 어둡게 하고 대상만 강조 + 건너뛰기 가능", keywords: ["onboarding", "투어", "시작"] },
  { group: "호스트 기능", href: "/docs/host/trust-security", title: "Trust & Security", snippet: "출처 검증 · 버전 회수 · 로드 실패 카드 · 비밀값 보호 · 감사 기록 · No-fallback · 앱이 여는 외부 연결", keywords: ["trust", "security", "보안", "신뢰", "감사", "네트워크", "개인정보", "models.dev", "모델 카탈로그"] },
  { group: "호스트 기능", href: "/docs/host/integration-recipes", title: "Integration Recipes — 결합 시나리오", snippet: "회의→액션→일정→답장 · 자료검색→발표용 · 화상회의→회의록→팀보드", keywords: ["recipe", "integration", "결합", "시나리오"] },

  // Routines
  { group: "루틴", href: "/docs/routines/overview", title: "루틴 등록과 트리거 흐름", snippet: "RoutineEngine · 트리거 shutdown | schedule · per-fire fresh loop" },
  { group: "루틴", href: "/docs/routines/meeting-end", title: "미팅 종료 → 자동 작업", snippet: "meeting.summary.created → subscribed extension card" },

  // Plugins
  { group: "익스텐션", href: "/docs/plugins", title: "익스텐션 — 개요", snippet: "정적 manifest · 호스트가 매니페스트만 읽음 · 도구 목록은 서버 세대 단위 고정" },
  { group: "익스텐션", href: "/docs/plugins/permission-grant", title: "권한 허용 흐름", snippet: "capabilities · tools[] · pluginAccess · agentApprovalScopes" },
  { group: "익스텐션", href: "/docs/plugins/local-indexer", title: "Local Indexer", snippet: "kiwipiepy Pattern B · pymupdf4llm · FTS5 + LanceDB · chokidar · RRF (K=60)", keywords: ["RAG", "rrf", "fts5", "kiwi"] },
  { group: "익스텐션", href: "/docs/plugins/meeting", title: "Meeting (회의 녹음)", snippet: "OpenAI Whisper · PCM16LE 16kHz/3sec · 18개 도구 · meeting.ended", keywords: ["stt", "whisper", "audio"] },

  // Marketplace
  { group: "마켓플레이스", href: "/docs/marketplace", title: "마켓플레이스", snippet: "git 저장소 마켓플레이스 · 공식/관리형/사용자 지정/직접 소스 · 커밋에 고정된 설치 · ave://install", keywords: ["marketplace", "git", "install", "설치"] },
  { group: "마켓플레이스", href: "/docs/marketplace/folders", title: "폴더 소스", snippet: "폴더 선택… · 로컬/이동식/클라우드 동기화/네트워크 폴더 · 로컬 폴더 배지 · 검토한 내용 그대로 설치", keywords: ["folder", "폴더", "share", "공유", "usb", "onedrive"] },
  { group: "마켓플레이스", href: "/docs/marketplace/warnings", title: "경고와 정책", snippet: "Ave가 연결하기 전에 · http · 사내망 · 이 컴퓨터 · 사내 다운로드 · requireHttps · blockPrivateNetworks · allowLocalSources", keywords: ["http", "warning", "경고", "policy", "정책", "사내망"] },
  { group: "마켓플레이스", href: "/docs/marketplace/updates", title: "자동 업데이트", snippet: "시작할 때와 하루에 한 번 확인 · 대화가 멈추면 적용 · 검토가 필요한 이유 · 소스별/패키지별 스위치 · 필수 패키지", keywords: ["update", "업데이트", "auto", "자동", "required", "필수"] },
  { group: "마켓플레이스", href: "/docs/marketplace/troubleshooting", title: "마켓플레이스 문제 해결", snippet: "주소 · 폴더 · 조직 정책 · 업데이트 메시지와 할 일 · 세부 정보 복사", keywords: ["error", "오류", "troubleshooting", "문제", "refused", "거부"] },
  { group: "마켓플레이스", href: "/docs/marketplace/authors", title: "패키지 작성자 가이드", snippet: "marketplace.json · ave-package.json · release/archive/tree · yanked · revocations.json", keywords: ["publish", "게시", "package"] },

  // Architecture
  { group: "아키텍처", href: "/docs/architecture/overview", title: "시스템 한 눈에 보기", snippet: "4 layers · 익스텐션 · ~/.ave · servers" },
  { group: "아키텍처", href: "/docs/architecture/diagrams", title: "다이어그램 (스택 · 흐름 · 의사결정)", snippet: "Stack · data flow · permission decision tree · extension lifecycle SVG", keywords: ["diagram", "visual", "topology"] },
  { group: "아키텍처", href: "/docs/architecture/host-api", title: "HostApi 컨트랙트", snippet: "PluginHostApi 표면 · 자식 프로세스 경계 · 비동기 비밀값 조회", keywords: ["hostapi", "격리", "프로세스", "isolation"] },
  { group: "아키텍처", href: "/docs/architecture/storage", title: "스토리지 — ~/.ave", snippet: "도메인 namespace · 0o700 dir · 0o600 file · audit/<YYYY-MM-DD>.jsonl" },
  { group: "아키텍처", href: "/docs/architecture/permissions", title: "권한 모델", snippet: "위험도 × 카테고리 × 검토 4모드 · 하위 에이전트는 부모가 먼저 판단", keywords: ["권한", "하위 에이전트", "adjudication"] },

  // Roadmap
  { group: "로드맵", href: "/docs/roadmap", title: "비전과 진화 흐름 (v1~v4)", snippet: "Connector · Sub-agent · Idle 활용 · Capability Pack · 자동화 트리거 · Hooks", keywords: ["roadmap", "future", "vision", "hook", "sub-agent"] },
];

export function searchEntries(query: string): SearchEntry[] {
  if (!query.trim()) return searchIndex;
  const q = query.toLowerCase();
  return searchIndex.filter((e) =>
    e.title.toLowerCase().includes(q) ||
    e.snippet.toLowerCase().includes(q) ||
    e.group.toLowerCase().includes(q) ||
    (e.keywords ?? []).some((k) => k.toLowerCase().includes(q))
  );
}

export function getSearchEntries(locale: "ko" | "en") {
  return locale === "en" ? searchEntriesEn : searchIndex;
}
