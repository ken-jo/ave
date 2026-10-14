# 마켓플레이스를 로컬에서 테스트하기

> **상태**: 현행 (2026-09-25). [멀티 소스 git 마켓플레이스](../../blueprints/multi-source-git-marketplace.md)
> 전환 때 서버 스택과 함께 제거된 로컬 서버 마켓플레이스 루프를 대신합니다. 영어 원문
> [../../guides/local-marketplace-testing.md](../../guides/local-marketplace-testing.md)이
> 기준이고, 이 문서는 그 한국어 미러입니다. 내용이 다르면 영어 원문을 따릅니다.

마켓플레이스는 git 저장소이므로, 로컬 테스트는 저장소를 개발 빌드에 서비스하고 사용자가
하듯 추가하는 것입니다. 파일 형식은 [Git 마켓플레이스에 게시하기](./marketplace-publishing.md)를
보세요.

## 개발 빌드가 허용하는 것

앱은 git으로만 마켓플레이스에 닿습니다. https, ssh, 그리고 `AVE_DEV=1`로 띄운
패키징하지 않은 빌드에서는 루프백(`127.0.0.1`, `localhost`, `::1`)의 평문 HTTP입니다.
`bun run dev`가 `AVE_DEV=1`을 설정합니다. 패키징한 빌드는 루프백 평문 HTTP를 거부하고,
모든 빌드가 `file://` 프로토콜을 거부하므로 로컬 디렉터리는 경로로 추가하지 않고
루프백으로 서비스합니다.

앱이 실행하는 git은 2.45.1 이상이어야 합니다. 시스템 git이 오래됐거나 없으면 설정 →
마켓플레이스가 관리형 사본 설치를 제안합니다.

## 저장소 서비스하기

`git http-backend`(스마트 HTTP 프로토콜)로 저장소를 서비스합니다. 앱은 부분 클론 필터와
객체 id로 가져오므로, 서비스하는 저장소에서 둘 다 켭니다.

```bash
git clone --bare ./my-marketplace /tmp/served/my-marketplace
git -C /tmp/served/my-marketplace config uploadpack.allowFilter true
git -C /tmp/served/my-marketplace config uploadpack.allowAnySHA1InWant true
```

CGI를 실행할 수 있는 서버라면 `GIT_PROJECT_ROOT=/tmp/served`,
`GIT_HTTP_EXPORT_ALL=1`로 `git http-backend`를 돌릴 수 있습니다. E2E 테스트의 픽스처
`src/marketplace/__tests__/fixtures/git-http-server.ts`가 바로 이 일을 하는 작은 Node
서버이니 복사해 써도 됩니다. 새 버전을 게시하려면 bare 저장소로 push합니다(또는 그
저장소를 원격으로 둔 클론에서 커밋 후 push).

## 추가하고 설치하기

1. `bun run dev`로 앱을 띄웁니다. 테스트 설치가 `~/.ave`를 건드리지 않도록 격리된
   `AVE_HOME`을 쓰는 편이 좋습니다.
2. 설정 → 마켓플레이스 → 추가 → 마켓플레이스 추가에서
   `http://127.0.0.1:<port>/my-marketplace`를 입력합니다. 미리보기는 종류별 패키지 수와
   앱이 건너뛴 패키지를 이유와 함께 보여 줍니다.
3. 카탈로그에서 설치합니다. 플러그인은 바이트를 가져온 단계를 보여 주고, MCP 서버는
   저장됐지만 연결되지 않았으면 연결 경고를 알립니다.
4. 새 버전을 게시하고 소스 화면에서 새로 고침을 누른 뒤, 카탈로그에서 업데이트해
   업데이트 검토 화면을 확인합니다.

인덱스 없이 패키지 하나만 해 보려면 추가 → Git 주소로 설치에 그 패키지를 담은 저장소나
저장소 안의 폴더를 넣습니다. 앱은 그곳에서 `ave-package.json`, 이어서 `plugin.json`, `SKILL.md`, `AGENTS.md`,
`server.json`을 찾습니다.

## MCP 서버

마켓플레이스 설치에도 MCP 거버넌스가 적용됩니다. 거버넌스 정책
(`$AVE_HOME/governance/mcp-policy.json`)이 승인하지 않은 서버는
`PACKAGE_POLICY_BLOCKED`로 거부합니다. 설치 전에 테스트 홈의 정책에 서버 id, 전송
방식, 정확한 명령을 승인하는 항목을 넣습니다.

## E2E 테스트

`test/e2e/ui/git-marketplace-lifecycle.spec.ts`가 기준 예시입니다. 모든 종류의 패키지를
하나씩 담은 픽스처 마켓플레이스를 서비스하고, 마켓플레이스 탭으로 추가하고, 설치하고,
1.1.0을 게시해 각 패키지를 업데이트하고, 소스를 제거한 뒤 남은 패키지를 제거합니다.
먼저 `bun run build`가 필요합니다.

```bash
bun run build
bun run test:ui-e2e test/e2e/ui/git-marketplace-lifecycle.spec.ts
```

## 구현 위치

- `src/marketplace/net/network-gate.ts` — 빌드가 닿을 수 있는 원격
- `src/ipc/domains/git-marketplace.ts` — 탭이 호출하는 서비스
- `src/marketplace/__tests__/fixtures/git-http-server.ts` — 루프백 git 서버
- `test/e2e/ui/git-marketplace-lifecycle.spec.ts` — E2E 실행
