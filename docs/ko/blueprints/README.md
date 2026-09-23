# Blueprints (설계 제안·이행 기록)

이 디렉토리의 문서는 Ave 호스트 앱의 **설계 제안과 이행 기록** 입니다. 2026-04 Phase 계획·종결 보고서와 폐기된 기능(Agent Hub, 초기 인덱서, 초기 컴포저 목업)의 문서는 2026-09-23 정리에서 제거했으며 git 히스토리로만 남습니다. 남은 파일 중 process-derived 접두사가 있는 것은 의도된 *역사적 기록* 표기이며 새 식별자 네이밍 룰(`feedback_naming_process_metadata.md`) 의 sweep 대상에서 명시적으로 제외됩니다.

## 현재 아키텍처는 어디에 있나

- 라이브 아키텍처 SOT: [`../architecture/architecture.md`](../architecture/architecture.md) (v4 Final)
- 영역별 설계 문서: [`../architecture/`](../architecture/) (permission-policy-design, plugin-deployment-model, …)
- Reference: [`../references/`](../references/)

## 여기 파일들의 성격

| 패턴 | 의미 |
|------|------|
| `*-redesign-*.md` / `*-design.md` | 특정 시점의 design 제안 (P-state 명시) |
| `*-plan.md` | 이행된 리팩터의 결정 기록 (라이브 SOT 는 architecture.md) |

## 룰 / 가드

- `feedback_naming_process_metadata.md` 의 process-metadata 식별자 sweep 은 **이 디렉토리 제외**.
- `.github/workflows/naming-gate.yml` 의 grep 패턴에서 `docs/blueprints/` 가 명시적으로 skip 됩니다.
- 새 phase-derived 파일을 추가하면 *역사적 기록* 의도가 명확해야 합니다. 살아있는 설계는 `docs/architecture/` 로.

## 인덱스 (작성 시점 순)

기록 순서는 git log 가 SOT. 빠른 lookup 만 제공:

- `composer-redesign-message-queue.md` — 대체됨(Superseded); 결정 기록
- `openharness-selective-borrow-plan.md` — OpenHarness MIT 재사용·출처 근거 (LICENSE 가 인용)
- `host-structure-alignment.md` — #1409/#1411 호스트 구조 정렬, 이행 완료
- `agent-hub-implementation-plan.md`, Phase 1.5/2/3 보고서, `autopilot-phase1-indexer.md`, `composer-redesign-mockup.html` — 2026-09-23 제거 (git 히스토리 참조)
