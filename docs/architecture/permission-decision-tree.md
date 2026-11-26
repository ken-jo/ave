# Ave permission decision tree (v4)

Status: owner-approved 2026-10-29. Mode names were updated 2026-10-30. Session surfaces, remote-user parity and shell-sandbox defaults: owner decision 2026-11-02. Ave home sandbox read boundary: owner decision 2026-11-07. Workflow templates (template runs, stage sub-agents, remote work approvals, run-scoped grant, unattended start, model-judged pass conditions): owner decision 2026-11-16. Unattended lane, schedule attachment, envelope, requested outputs, stage workspaces and per-stage breaker: owner decision 2026-11-16. Boot home privacy floor (any boot privacy failure) and helper-unavailable deny: owner decision 2026-11-24. Windows absent protected names are watched, never materialised: owner decision 2026-11-24. Exact saved host rule on a no-backend host, Windows extension starts with no backend or past the readiness deadline, memory-map inference with no backend, analysis limits ask, Windows approved-host session waiver and the local-network gate after X2: owner decision 2026-11-25.
Source design and reference comparison: artifact "에이전트 권한 결정 트리 비교", section 4.
This file is the single source of truth for permission-decision work. Implementers and reviewers of any change
to permission classification, approval cards, the reviewer, hooks or headless behaviour must read it and
keep the code in this order. A change to this tree needs an owner decision.

Outcomes: allow, sandbox-auto, ask (normal card), ask-forced (질문†: this time only, no reviewer, no allow-mode pass,
no memory, deny when headless; the `sandbox-unavailable` floor (when it is the only 질문†) and the Windows approved-host ask also offer this session, see below; one exception to no memory: on a no-backend host, an exactly matching saved host rule passes the `sandbox-unavailable` ask, see Shell default), deny.

Modes: 기본 / Default (former 모두 확인 = strict; default for new installs) · 쓰기 허용 / Allow writes
(former 쓰기만 확인) · auto · 허용 / Allow.

```mermaid
flowchart TD
  S["로컬 또는 본인 계정·인증·세션 연결된 원격 사용자의 도구 호출"] --> T{"입력 출처·봉투 검증 (로컬·원격 동일)"}
  T -->|"위조 출처·봉투 불일치"| DENY
  T -->|통과| H{"입장 검사 · 본인 계정 일치·인증·세션 연결 · 훅 · deny 규칙"}
  H -->|차단| DENY["거부"]
  H -->|신뢰한 훅 입력 변경: 전체 결정 재시작, 최대 3회| T
  H -->|"통과 (무인 실행: 격리 증명·봉투 존재 포함)"| F{"질문† 대상? 보호 경로 · 위험 삭제 · 탈출 · 다른 주체 턴 · 셸 분석 한도 초과 · 샌드박스 없는 셸(경계 미확인 · 백엔드 없음)"}
  F -->|예| ASKF["질문† (이번 한 번; 예외: sandbox-unavailable가 유일한 질문†이면, 또는 Windows 승인 호스트 질문†이면 이 세션의 이후 셸·훅을 이 세션 동안도 허용 가능, 사람 없으면 거부; 백엔드 없음 sandbox-unavailable가 유일한 질문†이고 부팅 홈 보호 확인됨: 명령과 정확히 일치하는 저장된 호스트 규칙만 묻지 않고 통과)"]
  F -->|아니오| UN{"예약이 시작한 템플릿 실행의 단계 세션?"}
  UN -->|아니오| U{"사용자 소유 브라우저 · 호스트 터미널?"}
  U -->|아니오| R{"ask / allow 규칙 · 기억된 승인 (이번 실행 허용 포함)"}
  U -->|예| UH{"사람 있음?"}
  UH -->|아니오| DENY
  UH -->|예| UX{"명시 ask 규칙 · 유출 신호?"}
  UX -->|예| ASK
  UX -->|아니오| UC{"세션 공통 선택 1개 (owner decision 2026-11-02)"}
  UC -->|모두 허용| ALLOW
  UC -->|"모두 질문 (기본값)"| ASK
  UC -->|오토| UL{"논리적 일관성 검토"}
  UL -->|low| ALLOW
  UL -->|"불확실 · 오류 · 중단"| ASK
  R -->|allow| ALLOW["허용"]
  R -->|ask| Q
  R -->|없음| K{"도구 종류"}
  K -->|"읽기 · readOnly MCP (서버·플러그인)"| ALLOW
  K -->|"비밀 파일 읽기 · 그 외 MCP · 네트워크"| Q
  K -->|"파일 쓰기 (비밀 파일 포함)"| W{"프로젝트 안 + 되돌리기 가능?"}
  W -->|예| ALLOW
  W -->|"아니오 (밖이면 카드 1장)"| Q
  K -->|셸| SB{"활성 샌드박스 안 + 미검증·파괴 신호 없음? (3 OS 기본 켜짐)"}
  SB -->|예| AUTO["샌드박스 자동"]
  SB -->|"아니오 (호스트 셸 포함)"| Q
  Q{"모드 · 사람"}
  Q -->|허용 모드| ALLOW
  Q -->|"기본 · 쓰기 허용"| ASK["질문"]
  Q -->|auto| RV{"리뷰어"}
  Q -->|"사람 없음: 모델에 알림"| DENY
  RV -->|"low · medium"| ALLOW
  RV -->|"high"| MC{"모델 선택"}
  MC -->|"거절 수용"| DENY
  MC -->|"사용자 명시 허용 근거로 재요청 (1회)"| RR["근거 보강: 모델 사유 + 사용자 발언 + 호스트 사실"]
  RR -->|재심사| RV
  MC -->|"사용자에게 카드 요청"| ASK
  RV -->|"재요청 뒤 high · 오류 · 3연속 / 턴 20회 거부 뒤"| ASK
  ASK -->|"승인 (내부 스킬·훅 카드 포함)"| LIVE{"응답·실행 직전 본인 계정·세션·권한 유효?"}
  ASK -->|"사람: MEDIUM 재판정 · 동일 입력 기억"| EA{"정적 경로 미선언 HIGH · 호스트 근거 · EA 적격?"}
  EA -->|"예: 선택한 범위에 동일 입력 저장"| LIVE
  EA -->|"아니오: 실행·저장 거부"| DENY
  LIVE -->|예| ALLOW
  LIVE -->|아니오| DENY
  ASK -->|"거절 · 부재 중 자동 스킵(옵션)"| DENY
  ASKF -->|승인| LIVE
  ASKF -->|"거절 · 사람 없음"| DENY
  ALLOW -.->|"허용된 위임·루틴 생성 · 승인된 업무 계획 · 확정된 템플릿 버전(그래프 해시) + 생성 후 실행 · 버전·그래프 해시에 결속된 예약 연결: 그 실행의 단계 자식만"| CHILD["독립 세션: 부모 원격 권한 미상속"]
  CHILD --> H
  ALLOW -.->|"허용된 단계의 하위 에이전트 생성 (단계가 켠 경우, 깊이 1만)"| GC["단계 하위 에이전트: 단계의 승인 표면 상속 · 카드에 단계·하위 에이전트 표시 · 재생성 불가"]
  GC --> H
  H -->|"무인 실행인데 격리 미증명 · 봉투 없음"| DENY
  F -->|"예 · 예약이 시작한 실행의 단계 세션: 묻지 않고 거부"| DENY
  UN -->|예| EV{"봉투 안? (도구·경로·도메인·명령, 그래프 해시에 결속)"}
  EV -->|"밖 · ask 규칙 · 유출 신호 · 사용자 소유 표면 · 호스트 셸"| DENY
  EV -->|안| KU{"도구 종류 (무인)"}
  KU -->|"단계 작업공간·readRoots 읽기"| ALLOW
  KU -->|"단계 작업공간 쓰기 + 되돌리기 가능"| ALLOW
  KU -->|"샌드박스 셸, 미검증·파괴 신호 없음"| AUTO
  KU -->|"샌드박스 셸 미검증·파괴 신호 · 봉투에 선언된 도구"| RVU{"리뷰어 (좁히기만)"}
  KU -->|"봉투 도메인으로의 샌드박스 연결 (로컬·사설망 제외)"| ALLOW
  RVU -->|"low · medium"| ALLOW
  RVU -->|"high · 오류 · 차단기"| DENY
  classDef allow fill:#d4f7d4,stroke:#2a2,color:#123
  classDef sbx fill:#e3f4f4,stroke:#2a8a8a,color:#123
  classDef ask fill:#fff3c4,stroke:#c90,color:#321
  classDef rev fill:#dbe8ff,stroke:#36c,color:#123
  classDef deny fill:#ffd6d6,stroke:#c33,color:#311
  class ALLOW allow
  class AUTO sbx
  class ASK,ASKF ask
  class RV,RR,MC,UL rev
  class RVU rev
  class DENY deny
```

Notes that are part of the contract:
- **Human evidence re-adjudication (owner decision 2026-11-13, EA only):** an ordinary card may offer a separate, unselected human action to re-adjudicate the sole host-proven static `write path not declared` HIGH as MEDIUM and remember the exact input in the user's chosen scope. Missing host evidence, concrete danger, other HIGH reasons, forced floors, reviewer failures and plugin self-report cannot use EA. The raw classifier verdict remains unchanged. Evidence records use a dedicated exact-input matcher and never fall through to ordinary allow matching. Reuse enters the existing R remembered-allow edge without revalidating evidence; the attended `R` path has no evidence-revalidation step. (The `EV` node belongs to the unattended lane and checks the stage envelope, not EA evidence.) Admission, deny/ask rules, live authority and effect permissions retain their existing checks and order. The [EA design](../design/evidence-readjudication-333.md) owns the evidence and card contract.
- **Agent browser sites (owner decision 2026-11-08):** builtin tool use in agent-opened tabs is allowed. Opening a new HTTP(S) origin asks the human to allow that exact scheme, host and port for this session, allow any HTTP(S) site for this session, or deny. Dismissal denies. Grants are memory-only, never inherited by children, and end with the session. Top-level requests, including click/submit navigation, redirects and new windows, must pass site consent before loading. Non-web schemes and embedded credentials stay denied. Admission, deny rules, explicit asks, human-only exfiltration checks, sensitive input and irreversible-submit guards remain authoritative. User-owned tabs retain the shared surface choice; headless actions deny.
- **Plugin read declarations (owner decision 2026-11-06, 읽기 선언만 허용):** the existing `K → readOnly MCP → allow` edge also covers plugin tools declaring `annotations.readOnlyHint: true`. This is the only authorable annotation. Missing/false hints or an operation policy with a write kind or a higher minimum risk retain ordinary approval. Admission, forced floors, rules and remembered decisions keep their existing order. Command/network evidence, path checks, active filesystem-containment requirements for command reads, egress/hostFetch, secret leases and actual host effects retain their own gates; the declaration grants no effect capability. App-written text and app-initiated write/shell/network actions retain their confirmation requirements.
- Standalone reverse HostApi effects: writes to the plugin's own storage need no approval and are denied outside it; every other effect is allowed only within the plugin's [declared background effects](architecture.md#extension-runtime) approved at enable, bound to its install source and declared-scope hash and re-asked when either changes. Within that scope a deny or forced floor still denies and the card answers only ordinary asks; any other ask, and any effect outside the scope, is denied.
- **App approval delivery (bug correction, no tree change):** sidebar and floating-dock app calls use the focused main window’s unattributed approval lane, with plugin attribution. Each card stays with its recipient across focus changes; if that window leaves, the host re-sends it to the next main window and retires its old copy. No registered main-window surface means an action requiring a card is denied under Q. An iframe click supplies no user-gesture authority.
- **Shared surfaces (owner decision 2026-11-02):** one conversation-local choice covers both logged-in browser tabs and host terminal tabs. One shared card selects Allow all, Auto or Ask (default); there is no separate choice per surface, persistence across sessions or child inheritance. Explicit ask rules and the human-only exfiltration guardrail precede this choice; generic allows and remembered grants do not replace it.
- **Remote user (owner decision 2026-11-02):** an authenticated controller whose account matches the host-owned owner-identity anchor and is bound to the current session enters the same tree as the local user, including rules, remembered grants, mode, reviewer and 질문†. Missing/mismatched owner identity, authentication, session binding or live transport authority is admission-denied, including after asynchronous approval. Remote provenance alone never creates an other-principal floor; genuine external-content guidance still does.
- **Remote intake and paste parity (owner decision 2026-11-02):** remote input cannot turn a staged, app-message or plugin envelope into raw user intent. The same origin/envelope mismatch is rejected before a turn, request anchor, native quote or terminal eligibility is created. Explicit attachments and recognized pasted-text wrappers retain file-content taint. The paired browser transport supplies image attachments; the provider bridge accepts text only. Neither carries a distinct pasted-text flag, so unmarked remote text is treated like typed text, without a size-based paste heuristic.
- **Delegated work (owner decision 2026-11-02):** admitted children, resumed children and routine executions use the same independent sessions and provenance as local delegation. They do not inherit the originating controller's session-bound authority. After the parent creation/scheduling action passes its permission checks, the child spawn/resume execution or routine fire enters an independent scope. Revocation denies subsequent controller-bound admissions, pending card answers and pre-effect rechecks; it does not itself revoke the delegated session or promise interruption of an already running effect. Ordinary parent/child cancellation, routine signals, unattended/headless policy and genuine other-principal floors remain effective; a child's own tool calls still pass its own permission tree. A shared browser/terminal choice is never inherited. Browser input authority belongs only to the tab's owning session; parent and sibling sessions gain no input authority from ancestry. The parent may view children's tabs and labelled activity without acquiring their leases (owner decision 2026-11-08). The unattended lane consults no mode, allow rule, remembered grant, run-scoped grant or persistent egress grant (owner decision 2026-11-16).
- **Work approvals (owner decision 2026-11-04; workflow templates 2026-11-16):** a work approval is the user's decision on a host work object: a plan approval, a human stage gate, a join-conflict gate, a template confirmation, `Create and run`, a schedule attachment or a requested-output approval. A local plan approval keeps its desktop keyboard-gesture requirement. A local stage gate, template confirmation or `Create and run` needs an explicit desktop user gesture. A local schedule attachment needs a keyboard gesture in the desktop window. A local requested-output approval needs an explicit desktop user gesture, the same as a stage gate. Remote work approvals use only the Tailnet path below. A plan approval is bound to the exact stored plan hash, a stage gate to run + stage + attempt + `resultHash` (the stage output; a requested output binds to its own `outputHash`), and a template confirmation to the graph hash. `Create and run` authorizes only the exact confirmed `(templateId, version, graphHash)` chosen by that decision. The host validates it and pins the run to the same tuple before creating any child. Local and Tailnet start decisions validate the same binding. A mismatch refuses to start. A schedule attachment (bound to template id, version and graph hash) and a requested output (bound to `outputHash`) are work objects too, and deciding them is a work approval. A work approval is a user action outside this tree, like user-typed terminal commands. A plan approval only authorizes creating the execute child. A confirmed template version plus `Create and run` only authorizes creating that run's stage children. A stage gate only lets the scheduler start the next stages. Each child enters `CHILD → H` and every tool call it makes passes this tree. Remote controllers can decide work approvals only through the Tailnet surface; every other remote path is refused.
- **Template runs (owner decision 2026-11-16):** a confirmed template version plus the user's `Create and run` gesture is a third source on the `ALLOW -.-> CHILD` edge. It authorizes creating that run's stage children, including all-tools stages, with no per-run plan approval. A plan stage is optional. Confirmation binds to the graph hash. `Create and run` starts the template's current confirmed version only. A mismatch, or an archived version, refuses to start. A run pinned to `(templateId, version, graphHash)` may only create the stage children of that version. This source grants no tool permission: every tool call of every stage child still enters `CHILD → H` in tree order.
- **Stage sub-agents (owner decision 2026-11-16):** a stage may opt in to sub-agents, at depth 1 only. A grandchild inherits the stage's approval surface. Its cards name the stage and the grandchild, and its asks go to the user directly. The reviewer breaker counts it as its own session. It may not spawn further. When a stage ends, its live grandchildren are interrupted. The stage's spawn call passes this tree like any other tool call, and the grandchild's tool calls enter `H` and pass this tree like any child's. The approval surface is card delivery only: the shared browser/terminal choice, agent-browser site grants and the `sandbox-unavailable` session grant are still not inherited.
- **Remote work approvals (owner decision 2026-11-16):** every work approval can be decided remotely: plan approvals, stage gates, join-conflict gates, template confirmation, `Create and run`, schedule attachment and requested-output approval. Remote decisions are accepted only through the existing [Tailnet surface](multisurface-conversation-runtime.md#tailnet-only-remote-sharing-model-and-controller-follow-up). That means Tailscale Serve ingress to the loopback-only `TailnetSurfaceServer`, a current owner-identity match from the Serve identity headers, a paired, bound session, and the controller role. LAN, Funnel, public links and any other ingress are refused, fail-closed. A remote decision binds to exactly the same object hash as a local one and is audited with origin `tailnet-surface`. The identity shown is the Serve login; Serve supplies no device name. Without the Tailnet configured, work approvals stay local-desktop only. The controller capability for remote work decisions is added to the Tailnet contract by PR-C. Until then there is no remote path for any work approval: fail-closed, local only.
- **Run-scoped grant (owner decision 2026-11-16):** node `R` has one more remembered scope, "Allow for this run". It is shared by the stage sessions of one run and their grandchildren. It matches with the tool's existing remember key, scoped to the run. Cards that are already open when the grant is made are not auto-answered. It ends when the run ends. It is never saved as a rule and never crosses runs or items. Floors that this tree marks as non-rememberable stay non-rememberable. It is read at `R` only, so admission, deny rules and 질문† keep their order before it.
- **Unattended template runs (owner decision 2026-11-16):** a schedule may start a template run, only through its schedule attachment. The routine-creation source does not cover template runs. Human gates park in the board's Needs review, with no timeout, and can be decided locally or over the Tailnet. A parked gate is a work approval, not a tool ask, so the headless rule below is unchanged: a tool ask with nobody present is still denied. Authority and tool calls of a schedule-started run follow the schedule attachment and unattended lane notes below.
- **Model-judged pass conditions (owner decision 2026-11-16):** a stage's pass condition may be model-judged, for example "the reviewer stage says OK". It is labelled as a model judgement, and the verdict is the stage's own structured ending. It is still a scheduler predicate, not a node of this tree. It never answers, skips or pre-fills a permission card.
- **Schedule attachment (owner decision 2026-11-16):** a schedule runs a template only through a new work approval that attaches it to an exact `(templateId, version, graphHash)`, decided locally or over the Tailnet. It is the fourth source on the `ALLOW -.-> CHILD` edge, and it is the source for schedule-started runs. The `routine_schedule` tool cannot create it. The existing routine-creation source keeps its meaning and does not cover template runs. A scheduled fire is not a `Create and run` gesture. It may create only the stage children of the pinned version, and a hash mismatch refuses to start. Confirming v2 does not move a schedule.
- **Unattended lane (owner decision 2026-11-16):** stage sessions of a schedule-started run never ask. After `F` they take `UN → EV → KU` instead of `U`, so admission, deny rules, hooks and every 질문† floor still come first. A 질문† target in a schedule-started stage session is denied and never asked: the `F → DENY` edge, not `ASKF`. `H` denies an unattended call when isolation is not proven or the stage has no envelope. A call is allowed only inside the stage's capability envelope (confirmed with the version, inside the graph hash), inside the isolation profile of the unattended review (§5.3) and inside the stage workspace. Anything else is denied with "do not retry". It is never asked and never queued. The lane ignores ambient mode, allow rules, remembered grants and run-scoped grants. Deny rules and ask rules still apply; an ask rule that matches means deny. An exfil signal, a user-owned surface and a host shell deny. The lane is keyed on how the run started, not on whether someone is reachable. Grandchildren inherit the stage's envelope and budget and cannot widen them. Interim rule: until WT-15 and WT-16 land, a schedule may start only templates whose stages are all read-only.
- **Envelope contents (owner decision and lead ruling 2026-11-16):** the envelope only narrows. An envelope may declare, per stage, network domains, and MCP or plugin tools without `readOnlyHint`, provided their effect is local generation or fetching. These are confirmed explicitly. Each declared tool carries a data-sent flag, inside the graph hash, that says whether its prompts and inputs leave the machine. The confirm screen shows the flag for each tool, and names the service for a tool flagged as sending. The flag is disclosure only: it grants no permission and no exception to the publishing ban or to the deny, exfil and effect checks. Network domains and declared tools are empty unless the owner fills them in at confirmation. A tool whose effect is outward publishing can never be declared in an envelope. An envelope cannot list a host shell, a 질문† target, a secret file or a user-owned surface. Local and private-network destinations are refused even when an envelope lists them. The Windows limitation in the unattended review (§5.3) stands and is not solved here: Windows qualifies only through MXC shells, which today need the local-network access this lane refuses. The local-network gate for Windows MXC shells (attended and unattended) is removed once X2 (PR #666) merges: the Ave relay then holds both loopback ports, 127.0.0.1:P and [::1]:P, and refuses a foreign process holding either (owner decision 2026-11-25). Until the owner decides whether the unattended lane then qualifies on Windows, the §5.3 limitation stands. Everything else that the unattended review (§5.7) forbids stays forbidden, whatever the envelope says. That includes unattended changes to settings, rules, permissions, plugins, MCP servers, templates, schedules or routines, device or OAuth sign-in, a new origin in the agent browser, keychain and host credential stores, escalation and the unsandboxed retry. Neither confirmation nor a reviewer result can override these.
- **Unattended reviewer (owner decision 2026-11-16):** inside the envelope, the reviewer checks unproven or destructive sandboxed shell commands and declared tool calls, and can only deny. Low or medium continues. High, an error or an open breaker denies. There is no model choice, no resubmission and no card. The reviewer can never allow something outside the envelope.
- **Requested outputs (owner decision 2026-11-16):** nothing leaves an unattended run. Outward effects (publish, upload, post, send, push, merge, purchase) are requested outputs: data bound to `outputHash` that the host executes only after a human gate approves them, locally or over the Tailnet. The host executes them with the approver present, through the ordinary tree. This is not a deferred queue: no tool call is parked and nothing is replayed.
- **Stage workspaces (owner decision 2026-11-16):** every stage of a template run runs in its own workspace under `~/.ave/worktrees/<project>/<run>/<stage>/`. In a git project the workspace is a git worktree. Otherwise it is a plain folder seeded with the stage's declared inputs. Seeding never copies gitignored files or secret files such as `.env`, in git and plain-folder workspaces alike. Creating a workspace authorizes nothing: a template's setup commands are ordinary tool calls that pass this tree, and in the unattended lane they also need the stage envelope. The Ave-home boundary re-allows a stage session only its own workspace, for reads and writes, in addition to what the boundary note below lists. The stage's own workspace is also carved out of the protected-path 질문† floor, for reads and writes, for that stage session and its grandchildren. The carve-out is a host-minted binding from the stage session id to the workspace realpath, not a path-prefix match. Symlinks and `..` cannot widen it. Other stages' workspaces, the run folder outside the stage and the rest of `~/.ave` stay protected. The stage workspace is the stage's project root for write policy. Grandchildren inherit the stage's workspace. A conflict at a join becomes a human gate that shows it. Workflows are general-purpose: nothing here may assume a git repository, source code or a build.
- **Internal approval lifetime (owner decision 2026-11-02):** skill-load and hook-command cards bind the originating controller authority to the same session as ordinary tool cards. Revocation while waiting denies the answer and subsequent skill registration or hook spawn; internal cards cannot outlive authenticated authority. Skill-grant persistence also rechecks authority after queued/asynchronous preparation and immediately before its atomic commit; revocation during that wait records no grant.
- **Owner identity (owner decision 2026-11-02, 본인 계정만 연결 허용):** only the owner's own account may pair, activate a share or enter a bound turn. For the tailnet transport, the canonical owner is the local node's untagged authenticated user: status `Self.UserID` selects `User[id].LoginName`. The peer's authenticated WhoIs-derived login must match it; peer input cannot supply the owner anchor. Missing local identity, tagged nodes, lookup failure and mismatches deny with named visible errors. Each HTTP admission and owner activation/refresh takes one fresh asynchronous local-status observation, after the applicable request rate limit. Request evidence passes through the HTTP identity gate and authorization without duplicate probes. How LIVE and the admission check H are realized for a bound controller: before each controller-bound tool effect and approval response, including internal skill and hook cards, await a fresh asynchronous local-status probe and compare the owner with the binding. A check is satisfied only by a probe that started at or after the check asked: a check arriving while a probe is already running waits for, and shares, the next probe, and a completed result is never reused for a later check. No TTL owner cache grants admission or effects. A transition to unavailable advances the revocation generation, so recovery never rehabilitates old evidence. At each asynchronous pre-effect boundary, await the fresh probe after permission and preparation waits. Check the current binding, session and revocation state before the handler, nested host effect, process spawn or atomic grant commit; any later asynchronous wait must be followed by another revocation-state check before use. Pending card persistence uses the same check as the answer itself; it cannot record a remembered allow before detecting an invalid owner. These live checks apply equally to mode, rule and remembered allows and do not depend on an open event stream. Lookup failure refuses the current action. Compare canonical logins exactly, without aliases or peer-supplied normalization. A confirmed changed local login invalidates and persistently revokes old non-matching bindings. An unavailable observation only suspends access in memory and surfaces an unavailable snapshot; it never persists an identity revocation. A requesting peer mismatch cannot revoke the owner's pairings.
- **Streaming identity checks:** assistant text deltas and replay events do not probe identity. Each event checks the active share’s expiresAt with a clock comparison. Store-change subscriptions invalidate affected streams synchronously; the existing 15-second scope-check interval performs asynchronous identity refresh and rechecks revocation before retaining the stream. A native account change without a store notification may therefore be detected on the next interval plus probe completion, rather than on the next delta; this is periodic detection, not a real-time guarantee. This keeps native process startup and waits off the main thread and per-delta path.
- **Command acceptance:** validate owner and share authority before submitting a command. Once accepted, the HTTP response remains an accepted result. If the authority is already lost when that response is built, its `turn` carries `denied: true` with `remote-controller-authority-suspended` (identity unavailable, or recovered to the same owner) or `remote-controller-authority-revoked` (a confirmed different owner, or a share or pairing that is no longer current). There is no separate turn-denial event. A denial before the turn starts records `{ok:false}` only in the host-side command completion, which settles the idempotency receipt; the bound UI receives no shared event for it. A denial at a later effect boundary of a running turn ends that tool call as an error result, which the shared projection carries only as `tool.state: failed`, without a reason or code. When the host observes the revocation or suspension, the bound event stream ends with `reauthorize-required`, so a client may miss events after that. Revocation prevents subsequent effects and cannot retroactively make an accepted command appear unsubmitted.
- **Identity residual risk:** identical `LoginName` strings can exist across distinct tailnets, while forwarded Serve identity headers carry no `UserID`. Login equality therefore does not prove a globally unique cross-tailnet account identity; this remains a limit of the current matching evidence.
- **Explicit account registration (owner decision 2026-11-02):** the messaging connection's Settings page requires the desktop owner's own numeric user ID before pairing. Registration/change uses the sender-validated desktop IPC and a verified local keyboard gesture; remote messages cannot set this anchor. Verified private-message `sender.id` must match that registered ID to complete pairing and send. This explicit desktop registration is the owner assertion; the provider cannot prove that a remote human is the desktop owner. Missing registration denies. Changing the anchor revokes prior codes, pairings and conversation approvals; a code alone grants nothing.
- **Existing bindings (owner decision 2026-11-02):** revalidate saved tailnet pairings/shares against the current host owner identity, and saved messaging bindings against the registered owner ID. For tailnet bindings, unverifiable local identity means nonpersisted suspension; a confirmed different local owner means persistent revocation. Recovery with the same owner permits a new freshly observed request to use the preserved pairing, while old request evidence stays invalid. Only a revoked/unrecognized binding needs pairing and conversation approval again. Messaging bindings still require explicit registered-owner revalidation. Show suspension in Settings, and do not count retained terminal/revoked rows as a current mismatch. The same owner match remains part of live guards after an asynchronous approval.
- **Shell default (owner decision 2026-11-02):** shell sandboxing defaults on for all supported desktop platforms, including win32. A missing stored setting uses this default; an explicit stored false remains false. For shell tool calls outside the user-owned surface lane, only active isolation supplies sandbox evidence: proven read-only commands inside it auto-allow in Default, while host and escalated commands ask. Agent typing into the user's terminal instead follows the shared surface choice above. Settings activation without an available backend visibly warns and degrades without claiming confinement. On win32, MXC confines shells; the existing srt-win-only plan requires explicit host approval for shells and confines extensions. Missing both backends retains the visible unavailable path. On a host where the sandbox is on but no backend is usable (`requested-sandbox-unavailable`), every shell and hook command takes the `sandbox-unavailable` forced ask (S1, #664): approve once or waive it for this conversation, nothing saved, deny when headless. One case passes without asking (owner decision 2026-11-25): a saved host rule that exactly matches the command. Saved prefix rules, the allow mode and auto review still get the forced ask. This pass applies only when the no-backend `sandbox-unavailable` ask is the only 질문†. When Ave home privacy is also unverified at boot, the boot home privacy floor below governs and no saved rule passes it. On Windows, the approved-host ask (a capability that does not contain shells) is 질문†: it can be waived once per session, the waiver is never saved, and no saved rule passes it (owner decision 2026-11-25). A Windows extension start with no confinement backend is 질문† (owner decision 2026-11-25): when an attended session exists it asks once per start; headless denies, so the start is left unstarted with one notice. Consent is spent at spawn and never reused. Several pending starts may share one card, but each start gets its own yes or no. When a backend's readiness deadline expires, each start gets this 질문† ask, not a refusal (owner decision 2026-11-25). This applies to a start with no backend selected; a start beneath a holder or ancestor already admitted under MXC is still refused when its own deadline expires, so nothing drops below its ancestor's confinement (owner decision 2026-11-25). The helper-unavailable deny below still wins: no such start is offered while the privacy helper is unavailable.
- 질문† triggers only: protected paths (files the host runs later outside confinement: .git .vscode .idea .husky .cargo .devcontainer .yarn
  .mvn .config/git .bashrc .zshrc .zprofile .profile .envrc .gitconfig .npmrc .mcp.json; of agent folders only .agents
  and Ave's own config/home dirs, not other agents' folders such as .claude or .codex — owner decision 2026-11-25), critical delete, project escape, other-principal turn.
  A template stage's own workspace is not a protected path for that stage session and its grandchildren. The host
  binds the stage session id to the workspace realpath; see Stage workspaces.
- Native copy-class operand grammar (destination slot, protected-write floor) is matched by the executable spelling as typed,
  extension included (`copy.exe`), before the extension-stripped verb. Bare `copy` stays the cmd builtin / copy-item alias.
- Exfil (owner decision 2026-10-30, aligned with Codex, Claude Code and Hermes): an upload/exfil signal found in
  command text is a guardrail, not 질문†. It makes the call an ordinary ask: a card in 기본 and 쓰기 허용, the
  reviewer in auto, allowed in 허용, denied headless. The security boundary for network egress is the sandbox egress
  proxy (default-deny host allow-list). Command-text screening is not extended to an ever-growing list of wrappers.
  A non-sandboxed host shell in 허용 runs opaque or wrapped uploads, as the other hosts do in full-access modes.
  This limit is disclosed.
  Headless denies an exfil signal before the reviewer, superseding resolved conflict 6 for this signal. An applicable
  explicit allow rule or remembered grant precedes the exfil guardrail, by tree order. A surface session choice is
  not such a grant. An exfil signal on a user-owned surface always asks the human (owner 2026-10-31), regardless
  of its session choice; it uses a normal card, skips the logical reviewer, and denies headless.
  In the unattended lane an exfil signal denies before the envelope. This differs from `R`, where an allow rule
  precedes the guardrail.
- 기본 mode: writes and shell that would be allowed also go to the card. Reads stay allowed.
- Sandbox-auto blocked by the sandbox (escalation) goes to 모드 · 사람.
- The reviewer breaker is 3 consecutive or 20 per turn. The rest of the turn goes to a human. For template runs, each stage session and each grandchild gets its own breaker; the shipped single-run flow is unchanged (owner decision 2026-11-16, corrected).
- Reviewer denial → model choice (owner decision 2026-10-30). When the reviewer returns high, the model receives
  the denial with three choices and picks one:
  1. **Accept the denial**: the call is denied, and the model continues without it.
  2. **Resubmit with strengthened grounds (once per request)**: allowed only when the user explicitly permitted this
     action in this session. The model's rationale must cite that user message. The host verifies that the cited
     text exists in a user-role turn (never model text or tool output) and attaches it with host-verified safety
     facts (target path, sandbox state, reversibility/checkpoint, change scope). The reviewer re-judges once. A
     second high, or a missing or unverifiable citation, goes to the normal card (headless: deny).
  3. **Ask the user with a permission card**: a normal card (headless: deny + do not retry).
  - Model choice is offered only to requests with a sealed resumable anchor. An already-running nested effect or
    egress request without that anchor uses a normal permission card instead; headless fallback denies with
    "Nobody can approve this request; do not retry." No continuation or replay of prior effects is introduced.
  - The model rationale is an untrusted claim. Only the verified user quote and host facts count as evidence.
  - A reviewer error or a tripped breaker goes straight to the card. 질문† and deny outcomes never reach this choice.
  - The choice grants no execution authority by itself. The breaker counts one denial per request, after the
    choice resolves.
  - Basis: Codex's escalation request, where the model sends a `justification` with `require_escalated`, the
    reviewer re-judges with it, and otherwise the request goes to the user (owner reference 2026-10-30). Ave adds a
    verified user quote and host facts as the only trusted evidence.
- Headless means deny, and the model is told not to retry. There is no deferred queue; a "recently denied" list
  lets the user re-run a call.
  A stage session of a schedule-started template run does not reach `Q`; it uses the unattended lane, where a call
  is allowed inside its confirmed envelope and proven isolation and is otherwise denied. Nothing asks.
- An owner-away turn means the card waits. The default is unlimited; an optional auto-skip after N minutes denies.
- Reviewed or managed PreToolUse and PermissionRequest hooks may replace input. A changed input restarts the entire invocation at envelope validation and admission, preserving every existing node's order. Three actual replacements are allowed; a further replacement denies. An identical replacement is a no-op. Sealed resumptions and host authentication lifecycles deny a replacement rather than reuse previous authority. A hook allow never grants permission. Hook-provided context is capped and attributed to its exact hook identity.
- Credential stores owned by the host (encryption keys, credential DBs, cookie/token stores) stay admission-denied.
- **Ave home sandbox read boundary (owner decision 2026-11-07):** the sandbox read deny covers the Ave home as one directory, not as
  a list of file rows. Every child is denied by default, including children added later. A confined process is re-opened only the
  children `src/permissions/ave-home-read-boundary.ts` lists (workspace, its own sandbox HOME and temp, its own plugin, agent plugin
  or MCP server directories and a marketplace server's own data directory, the host runtime layout, Windows container staging), and
  only where its own wrap grants them. A grant elsewhere in the Ave home is withheld, and a plugin-chosen directory there is refused.
  `certs` and `sessions` stay on the protected floor and still need their own pierce. Windows stamps an inheritable deny on the root,
  and the explicit allow on a granted child ranks above it. Linux masks the root with tmpfs and binds the granted children back.
  macOS denies the subpath and allows the granted children inside it. Host features (preview, document observation) and the write
  floor keep the per-file rows.
- Limit of the Ave home boundary on Windows: an Ave home directly under the OS profile (the default `%USERPROFILE%\.ave`) gets no
  root deny, because a stamp also denies `FILE_DELETE_CHILD` inheritably on the target's parent, and on the profile root that
  propagates through the whole profile and exceeds the init timeout. Instead each existing top-level child directory that is not
  wholly re-allowed is denied as its own directory row, so the parent stamp lands on the Ave home. File rows inside those children are
  dropped; `sessions` and `certs` keep their floor rows; granted grandchildren (a plugin or MCP server directory) are re-opened by
  their explicit allow exactly as under the relocated root. Each composition (one shell command, one extension or worker child
  spawn) takes one boundary snapshot: it reads the home's top-level entries once (one readdir, no recursion) and pins the home and
  each entry that is not wholly re-allowed through the shared non-following path facts, and the floor, session policy, masks,
  evidence, read/write projections and deny targets of that composition all use it. Nothing is cached across commands or spawns;
  the next invocation takes a fresh snapshot, and a refusal holds for the rest of its composition. Only a home the native walk
  reports absent projects no child: a home that is, or lies beneath, a link or any other reparse point (dangling or not), a home
  that cannot be listed or pinned, and an entry that is a link or any other reparse point or vanishes between listing and pinning
  all refuse confinement instead of launching with fewer denies. The readdir may list a linked home's target before the refusal,
  but no linked projection is ever accepted or stamped. Residual set: top-level files of the Ave home stay file rows (see the file-row limit below),
  and a top-level child created after enumeration is not covered by that projection; the next projection denies it. Entry names
  are case-folded, so case-distinct siblings in a case-sensitive directory are not supported and no coverage is claimed for them.
  A relocated Ave home gets the root deny.
- The Windows shell working-directory pin binds its launcher through the private channel. The plain route has a pins-only
  residual. A same-user command can duplicate the launcher event or verdict handle. Container payloads are denied access to
  the launcher process. See [Permission Policy Design](permission-policy-design.md#route-neutral-execution-foundation).
- Local memory inference uses the Windows system directory for its working directory. The sandbox account already has read access there,
  so inference needs no ACL grant for its fresh process HOME. The active model is under the denied Ave home models directory and the host streams its verified bytes. With no confinement backend, memory-map inference runs unconfined through its switch, which is on by default; with the switch off, inference is disabled (OQ-14 confirmed; owner decision 2026-11-25). Not yet implemented: until the Windows container backend flip (R-win) ships the switch, inference is refused (`local-runtime-unavailable`) when the OS sandbox is not active (owner decision 2026-11-25).
- Unverified Ave home privacy at boot (any boot privacy failure: boundary-link, boundary-unlisted, the Windows ACL, ownership,
  icacls and read-back categories, and POSIX posix-root-unsafe; owner decision 2026-11-24, matching VS Code and Cursor, which never
  run a command silently without the sandbox): the OS sandbox cannot be relied on to keep the
  Ave home private, so host shells (bash, PowerShell) run unconfined: on the unavailable-sandbox route, on the sandbox-off route when only
  worker confinement was requested (shell scope off), and as an explicit host request. Each one runs only after a human approves it
  on its card (the shell card for that route, or the out-of-directory card when the command leaves the allowed folders). The
  `sandbox-unavailable` floor makes it ask-forced (질문†): allow once, allow for this session, or deny once; no saved-rule,
  remembered, allow-mode, auto-review or sandbox auto-allow pass, no durable approval, deny when headless (owner decision
  2026-11-08). The session choice records a grant of this floor for the requesting session only (children do not inherit command choices), kept in
  memory only, never as a rule, and dropped when the conversation ends or Ave restarts. While home privacy stays unverified,
  later shell commands and host hooks of that same session pass this floor, whatever the command, dialect, default or
  explicit-host plan, or background run (owner decision 2026-11-08: session-wide). The ordinary stages then decide without a
  reviewer: an allow rule or the allow mode runs it without a card, under its own one-shot execution permit per run; anything
  else (an ordinary ask in the default or auto mode) keeps the floor's card. Another conversation asks again. It does not need the rule grammar, so compound and interpreter
  commands get it too. It answers only this floor: it never satisfies an ordinary ask, and an ordinary session allow never passes it.
  When another 질문† floor also applies (protected path, project escape, critical delete, other principal), the card stays
  once-only. Other 질문† floors remain once-only. Host command hooks use the same plan and ask the same way; a headless blocking hook (prompt submit, pre-tool) is
  denied and can refuse its turn, which is the intended fail-closed result. The Permissions banner says shell commands will ask
  for approval once or for the session, for every boot privacy-failure category.
- Privacy helper unavailable (boot category helper-unavailable: the Windows path-kind or ACL helper did not answer; owner decision
  2026-11-24): Ave cannot judge the home's protection, so host shells and host hooks are denied, and so is a confined shell whose home
  denies were skipped or could not be applied without that helper; no extension is offered a start without isolation. The notice tells the user to restart Ave. No approval, session grant or rule passes this denial.
- Limit of file rows (home dotfiles such as `.gitconfig` and `.npmrc`, and the top-level files of a Windows profile-child Ave home):
  Linux bind masks and Windows ACL stamps are bound to the file object present at spawn, so a long-lived confined child can read a
  file the host replaces by rename-over. A file absent at spawn has no object to bind; it is held only by that backend's absent-path
  handling, which this boundary does not change. macOS seatbelt rules are path-based, so neither case reopens a denied path there.
  Per-exec shells re-apply masks and stamps on every spawn.
- Absent protected names on Windows (owner decision 2026-11-24): an ACL can only deny an existing object, and Ave never creates a
  placeholder in the user's workspace or home to carry a deny. A protected name (for example `.vscode`, `.idea`, `.git/hooks`) that is
  absent at launch is watched instead: when a sandboxed command ends, a worker is released, or a host-side consumer (host git, host hooks)
  is about to act on that workspace while a sandboxed process is still live, a watched name that now exists is moved to quarantine under
  the Ave home, the command result carries a named violation, and the user is told and may restore it. A failed move refuses host-side
  consumers of that workspace. macOS seatbelt rules are patterns and cover absent names without this.
- User-typed terminal-tab commands are user actions and stay outside this tree. A command the agent sends into a bound host terminal
  (`terminal_run`) runs on the host, so the unverified-privacy `sandbox-unavailable` ask floor (the "Unverified Ave home privacy at boot" note) applies to it before the user-surface session choice.

## Mode behaviour matrix (owner clarification 2026-10-30)

Modes are behaviour, not labels. Each column matches the reference hosts' equivalent mode.

| Action | 기본 (Claude default / Codex untrusted) | 쓰기 허용 (Codex Auto = workspace-write+on-request / Claude acceptEdits / OpenCode build) | auto (쓰기 허용 + Codex auto_review / Claude auto classifier) | 허용 (Codex Full Access / Claude bypass, but deny rules and 질문† still apply) | basis |
|---|---|---|---|---|---|
| file read (non-secret) | allow | allow | allow | allow | all four hosts |
| secret-file read | ask | ask | reviewer | allow | OpenCode *.env ask; owner comment |
| in-project write/edit/delete (checkpoint available) | ask | allow | allow | allow | Codex workspace-write, Claude acceptEdits, OpenCode build |
| outside-project write | ask (one card with folder grant) | ask (one card) | reviewer | allow | Claude add-dir card, OpenCode external_directory; owner "질문 1회" |
| known-safe read-only shell (ls, cat, git status/diff/log, rg…, as the existing literal-proof/read-only classifier defines it) | allow | allow | allow | allow | Claude default read-only bash, Codex untrusted safe commands |
| other sandboxed shell, incl. file-changing commands inside the project (mkdir/mv/cp/rm/build/test) | ask | sandbox-auto | sandbox-auto | sandbox-auto | Codex workspace-write sandbox, Claude sandboxed bash |
| sandboxed shell with an unproven/destructive signal | ask | ask | reviewer | allow (unless 질문†) | Ordinary mode policy |
| shell command past a parser or analysis limit other than the directory-change budget | ask-forced | ask-forced | ask-forced | ask-forced | Contained asks in every mode, offers one-time approval with no session grant, and denies headless. No rule, mode or grant passes the ask. Host route = ask-human (forced floor `shell-analysis-limit`: allow once, no session grant, denied headless; the card states that the rest of the command past the limit was not checked). Both cards give that notice and show the full command, including when another floor supplies the reason for asking. |
| sandbox escalation / host shell (sandbox off) | ask (prefix rule savable, except the Windows approved-host 질문†) | ask (prefix rule savable, except the Windows approved-host 질문†) | reviewer (except the Windows approved-host 질문†) | allow (unless 질문†) | Codex escalation + prefix rules; owner "코덱스와 맞춰"; Windows approved-host ask is 질문†, waived once per session, never saved: owner decision 2026-11-25 |
| builtin browser in agent-opened tab | tool use allow; new origin ask (this-site / any-site) | same | same | same | owner decision 2026-11-08; session only, no child inheritance; headless deny |
| network / web fetch | ask | ask | reviewer | allow | Codex sandbox network off, Claude WebFetch rules |
| MCP readOnlyHint (server or plugin) | allow | allow | allow | allow | Codex MCP read-only; owner "우리도 맞춰"; plugin read declaration: owner decision 2026-11-06 |
| MCP other | ask (remember per tool) | ask (remember per tool) | reviewer | allow | Claude per-tool rules; owner "클로드에 맞춰" |
| 질문† targets (incl. host shells while Ave home privacy is unverified at boot, and shells on a sandbox-on host with no usable backend) | ask-forced | ask-forced | ask-forced (no reviewer) | ask-forced | protected paths and instruction files need fresh human consent each time; boundary shells: lead decision 2026-11-08, with later shells and hooks of this session when sandbox-unavailable is the only 질문† (owner decision 2026-11-08); every boot privacy failure: owner decision 2026-11-24; no-backend shells: S1 (#664), where, when the no-backend `sandbox-unavailable` ask is the only 질문† and boot home privacy is verified, a saved host rule that exactly matches the command passes without asking and saved prefix rules, allow mode and auto review do not; with boot home privacy also unverified, the boot floor governs and no saved rule passes (owner decision 2026-11-25) |
| Windows extension start with no confinement backend, incl. a start whose backend readiness deadline expired | ask-forced once per start when an attended session exists; several pending starts may share one card, each start with its own yes or no | same | same (no reviewer) | same | owner decision 2026-11-25; consent is spent at spawn and never reused; headless denies, so the start is left unstarted with one notice; an expired readiness deadline asks, it does not refuse; the helper-unavailable deny still wins |
| headless (no human), anything that would ask | deny + "do not retry" | same | same (the reviewer still decides first; a fallback to ask → deny) | n/a | Claude -p --permission-prompts none, Codex exec never, OpenCode run, Hermes cron |
| unattended template stage (schedule-started run) | inside the envelope, a proven sandbox and the stage workspace: allow, sandbox-auto or reviewer (deny only); anything else: deny + "do not retry" | same | same | same | owner decision 2026-11-16; mode, rules and grants are ignored; nothing asks |

auto = 쓰기 허용 + automatic review: every non-† ask goes to the reviewer first. The reviewer never sees 질문†.

## Resolved conflicts with existing invariants (lead decision 2026-10-30, from INVENTORY review)
1. A corrupt or unreadable policy store means the stage-1 deny. It fails closed, because unread deny rules must not be bypassed by the reviewer or the allow mode.
2. Actions in a user-owned (logged-in) browser tab are their own surface. They are NOT 질문† and not an ordinary read or network. (Owner decision 2026-10-30.) On the first agent action in a user-owned tab in a session, a card offers three choices, which last for that session:
   - **이 세션 모두 허용 / Allow all this session**: later actions in user-owned tabs run without asking.
   - **오토 / Auto**: each action goes to the reviewer, which performs only a LOGICAL check. Does this action follow from the user's request and the current task step? Is the target the tab and page the task is about? Is it free of steps the user did not ask for? The reviewer does not judge general risk. Fail or uncertain means a normal card.
   - **모두 질문 / Ask every time**: every action asks. This is the default, and it is the behaviour when the card is dismissed.
   An exfil signal on a user-owned surface always asks the human (owner 2026-10-31), including Allow all and Auto; it uses a normal card, skips logical review, and denies headless.
   deny rules, admission, credential entry and payment/irreversible-submit protections still apply in every choice. Headless means deny. The shared choice covers browser and host terminal actions in this session and is never remembered across sessions (owner decision 2026-11-02).
3. Plugin effects are evaluated per actual effect through this same pipeline. An approval binds to that exact effect; a tool-level reviewer allow never opens every effect. Headless effects follow the headless rule.
4. A user-configured read boundary (an outside-path read restriction) is an explicit rule. It is evaluated in stage 1/3 before modes, and it is preserved.
5. When a command is both "known-safe read-only" and "host/escalation" (e.g. `git status` with the sandbox off), the host/escalation row wins.
6. Headless in auto mode: the reviewer decides first. Only a fallback to ask becomes a deny with "do not retry". This supersedes INVENTORY's "immediate deny" reading.
7. The host terminal tab (the user's own shell, which the agent may drive per #308) uses the SAME three-way per-session choice as user-owned browser tabs. (Owner decision 2026-10-30.)
   - 이 세션 모두 허용: agent commands run in that tab without asking.
   - 오토: the reviewer does a logical consistency check only. Does the command follow from the user's request and task step, in the tab the task is about?
   - 모두 질문: every command asks. This is the default, and it is the behaviour when the card is dismissed.
   Together, the browser tab and the host terminal tab are the "user-owned surfaces". One shared choice covers both surfaces per session, is never persisted and has no child inheritance (owner decision 2026-11-02). An exfil signal on a user-owned surface always asks the human (owner 2026-10-31), in every session choice, using a normal card and skipping logical review. These surfaces have no sandbox egress boundary. Deny rules and credential protections still apply. Headless means deny. Commands the user types in the tab are user actions and are never gated.
8. "Checkpoint available" (the row-114 gate) is decided on each write target's realpath-native filesystem identity — `canonicalPath(resolve(path))`, the spelling the checkpoint recorder keys a mutation on — not the permission matching form, which lowercases the win32 drive letter and so made the pre-check disagree with the recorder on every Windows write. Win32 now matches POSIX: a leaf symlink or a dangling link cannot be snapshotted, so it asks; a write through an in-project directory junction/symlink is followed and auto-allows because the real target stays undoable; a junction/symlink that escapes the project roots is denied by the project-membership test (which uses the realpath'd form), not by the checkpoint gate. (win32 native-path parity, 2026-10-31.)
