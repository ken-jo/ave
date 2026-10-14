# Ave Project Documentation

**안녕하세요, Ave 입니다.** Ave 는 종합 에이전트 브라우저입니다. 목표와 현재 상태는 [비전](./vision/README.md) 한 곳에 정리되어 있습니다.

이 디렉터리는 영문 기본 문서([../README.md](../README.md))의 한국어 미러입니다. 둘이 다르면 영문 문서가 기준입니다.

---

## 📁 목차

| 문서 | 설명 |
|------|------|
| [한국어 앱 README](./app-readme.md) | ave 저장소 개요, 개발 명령, 플러그인/패키징 흐름 |
| [비전](./vision/README.md) | Ave 가 무엇이고 어디로 가는지 — 목표와 현재 상태의 정식 문서 |
| [철학](./vision/philosophy.md) | 목표를 추구할 때 따르는 원칙 |
| [아키텍처](./architecture/README.md) | 아키텍처 개요와 목차 |
| [아키텍처 본문](./architecture/architecture.md) | 전체 아키텍처 상세 |
| [도구 거버넌스 보충](./architecture/tool-governance.md) | Builtin / Plugin / MCP 통합 보안 모델 |
| [플러그인 배포 모델](./architecture/plugin-deployment-model.md) | managed vs user-installed 배포 정책 상세 |
| [시작 가이드](./guides/getting-started.md) | 설치·실행, 그리고 첫 실행에서 설정 → 모델 화면의 공급자 카드로 공급자를 연결하는 절차 |
| [타일로 나뉜 채팅 그룹](../design/tiled-chat-groups.md) | 메인 영역 워크벤치 모델의 기준 문서 — 타일 단위 대화, 그룹/창 범위 구분, `ave:chat:*` 채널 분리, 분할 트리 기하 |
| [플러그인 HostApi 프로토콜화 설계](../design/plugin-hostapi-protocol.md) | 설계 단계 문서(영문) — 인프로세스 `PluginHostApi` 객체를 공개 JSON-RPC 프로토콜(`ave/host/*` + MCP)로 바꾸고 모든 코드 플러그인을 격리 프로세스에서 실행하는 계획, 48개 멤버 변환표, 비밀 처리, 계약 공개, 이행 단계 |
| [디자인 문서 홈](../design/README.md) | 렌더러 UI 설계 문서 목록과 구현 앵커 |
| [플러그인 개발 가이드 (역사 보존)](./guides/plugin-development.md) | 과거 한국어 검토·논의 이력 — 새 작성·검증은 [현재 English guide](../guides/plugin-development.md) |
| [테마 및 UI primitive 기준](./development/theme-system.md) | semantic token theme system + shadcn registry primitive source of truth |
| [도구 로딩 정책](./development/tool-loading-policy.md) | plugin/MCP/builtin tool registry, catalog, full-schema exposure, TPM-safe loading policy |
| [레거시 sunset 정책](./development/legacy-sunset-policy.md) | migration/dormant experimental 코드 inventory, 유지 기준, 제거 PR 규칙 |
| [프로덕션 릴리스 체크리스트](./references/production-release-checklist.md) | 앱 installer 생성, signing/notarization, smoke test, publish 절차 |
| [청사진 & 이행 문서](./blueprints/) | 구현 계획, 연구 메모, 단계별 closure report |

---

## 🗂️ 저장소 구조

각 디렉터리의 주요 문서만 추립니다. 전체 목록은 해당 디렉터리를 직접 확인하세요.

```
docs/
├── README.md                              # 영문 문서 홈
├── vision/
│   ├── README.md                          # ★ 비전 — 목표와 현재 상태 (정식 문서)
│   └── philosophy.md                      # 원칙
├── architecture/
│   ├── README.md                          # 아키텍처 개요·요약·목차
│   ├── architecture.md                    # ★ 현재 아키텍처
│   ├── tool-governance.md                 # 통합 도구 거버넌스 보충
│   └── plugin-deployment-model.md         # managed/user 배포 모델 상세
├── design/
│   ├── README.md                          # 렌더러 UI 설계 문서 홈·구현 앵커
│   ├── tiled-chat-groups.md               # ★ 메인 영역 워크벤치 모델 기준 문서
│   └── *.html                             # 과거 리뷰 시점의 목업 (현재 UI 기준 아님)
├── development/
│   ├── theme-system.md                    # semantic token theme + shadcn primitive 기준
│   ├── tool-loading-policy.md             # tool registry·catalog·TPM-safe 로딩 정책
│   ├── legacy-sunset-policy.md            # legacy 코드 inventory·제거 규칙
│   └── release-process.md                 # 릴리스 절차
├── references/
│   ├── production-release-checklist.md    # installer·signing·smoke·publish 절차
│   ├── plugin-signing-operations.md       # 마켓플레이스 아티팩트 신뢰 운영
│   └── observability-guide.md             # 관측·로깅 가이드
├── guides/
│   ├── getting-started.md                 # 설치·실행·첫 실행 공급자 연결
│   ├── plugin-development.md              # 플러그인 개발 (현행 기준)
│   ├── mcp-app-authoring.md               # MCP 앱(`ui://` 카드) 작성
│   └── windows-setup.md                   # Windows 개발 환경
├── protocols/                             # 프로토콜 정의
├── research/                              # 조사 메모
├── blueprints/                            # 구현 계획·조사·단계별 closure report
└── ko/                                    # 한국어 미러 (현재 파일이 있는 곳)
```

---

## 문서 읽는 순서

1. **[비전](./vision/README.md)** — Ave 의 목표와 현재 상태
2. **[철학](./vision/philosophy.md)** — 목표를 추구할 때 따르는 원칙
3. **[아키텍처](./architecture/architecture.md)** — 전체 시스템 설계 (5-Layer, LLM 중심, Electron + Rust)
4. **[도구 거버넌스 보충](./architecture/tool-governance.md)** — ToolExecutor 단일 choke point와 Builtin / Plugin / MCP 정책
5. **[시작 가이드](./guides/getting-started.md)** — 설치·실행과 첫 실행 공급자 연결

---

## 🤝 기여 방법

문서를 추가하거나 수정하려면 PR(Pull Request)을 통해 기여해 주세요.
파일은 각 디렉터리의 역할에 맞게 배치해 주시기 바랍니다.
