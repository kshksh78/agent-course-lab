# agent-course-lab

에이전트를 바닥부터 만들어보는 실습. 단계별 스크립트를 순서대로 직접 실행한다.

## 준비 (최초 1회)

```bash
bun install
cp .env.example .env   # .env에 실제 ANTHROPIC_API_KEY 입력. 13~15단계는 LANGFUSE_* 3개도 필요(아래 참고)
```

Langfuse(13~15단계) 준비: [cloud.langfuse.com](https://cloud.langfuse.com)(EU) 또는 us.cloud.langfuse.com(US)에
가입(Hobby 무료, 카드 없음, 월 5만 units, 30일 보존) → Organization·Project 생성 → Project Settings › API Keys에서
public/secret 키 발급 → `.env`에 `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`(리전에 맞게) 입력.
`bun run steps/13-langfuse.ts` 후 Tracing에 `agent-loop` 트레이스가 보이면 끝.

사용 모델은 `.env`의 `ANTHROPIC_MODEL`로 관리한다 (`src/config.ts`가 읽는다).
모델이 deprecated 되면 `.env` 한 줄만 바꾸면 된다. 값이 없으면 기본값(claude-haiku-4-5-20251001)을 쓴다.

## 실습 프로젝트: 파치마켓 재고 API

타깃 파일 `src/index.ts`는 **파치마켓(가상 쇼핑몰)의 재고·주문 API 서버**다(Bun.serve, 포트 4173, 51줄).
SKU 3개(초코 파치 인형 12개, 민트 파치 키링 0개 = 품절, 파치 스티커 팩 340개)와 엔드포인트 4개
(`GET /health`, `GET /products`, `GET /inventory/{SKU}`, `POST /orders`)로 이루어진다. Part 1에서는 모델이 "읽었다"고 주장할 때
대조할 타깃(인형 12개·키링 품절이 맞으면 진짜 읽은 것)이고, Part 2 LAB 09에서는 에이전트가 호출할
우리 API로 쓰인다.

**강의자료 원칙**: 실습은 비용 때문에 Haiku를 쓰지만, 실무 기준은 아니다.
슬라이드·설명에서 특정 모델을 전제로 서술하지 않는다 (모델별 수치가 필요하면 범위나 표로 제시).

## 실행 방법

이 디렉토리에서 각 단계를 `bun run`으로 실행한다.

```bash
git clone https://github.com/devbrother2024/agent-course-lab
cd agent-course-lab
```

### 1단계. 도구 없이 물어보기

```bash
bun run steps/01-no-tools.ts
```

**관찰 포인트**
- 모델이 `src/index.ts`를 읽을 수 있나? → 없다. "파일 시스템에 접근할 수 없다"고 스스로 인정한다.
- `stop_reason: "end_turn"`: 할 말이 끝났다는 정상 종료.
- `usage`의 input/output 토큰 = 이 호출의 원가.

### 2단계. 도구를 "선언"만 하고 같은 질문

```bash
bun run steps/02-tool-declared.ts
```

**관찰 포인트**
- content에 `tool_use` 블록이 생긴다. 모델이 보낸 **실행 요청서** (실행은 안 됐다).
  - 우리가 선언한 `read_file`은 이름+스키마뿐인 명세서다. 구현은 어디에도 없다.
- `stop_reason: "tool_use"`: "네가 실행하고 결과를 줘, 기다리는 중". 도구를 "사용했다"가 아니다.
- `tool_use` 블록의 `id`: 나중에 결과를 짝지어 돌려줄 때 쓴다.
- 입력 토큰 46 → 740: 도구 *정의*가 컨텍스트를 먹는다.
- 경로가 명확해서 거의 매번 `tool_use`가 나온다 (실측 2026-08-17: 5회 연속).
  갈림 관찰은 2b단계에서. (2026-08-15 실측에서는 이 요청도 갈렸다. 그날그날 다르다.)

### 2b단계. 확률적 행동 관찰: 같은 요청 6연발

```bash
bun run steps/02b-probability.ts
```

**관찰 포인트**
- 2단계와 코드는 같고 요청만 모호하다: "README를 읽고 요약해줘." (경로 없음)
- 같은 요청인데 실행마다 갈린다: `tool_use`(경로를 추측해 요청) vs `end_turn`(경로를 되물음).
- 도구를 쓸 때도 추측 경로가 갈린다: `README.md` vs `README`.
- 실측(2026-08-17): 12회 중 `tool_use` 5회(README.md 4, README 1), `end_turn` 7회.
- 요청이 명확할수록(2단계) 한쪽으로 쏠리고, 모호할수록 흔들린다. → 해결은 3단계.

### 3단계. 환경 컨텍스트 주입 (system 프롬프트)

```bash
bun run steps/03-system-prompt.ts
```

**관찰 포인트**
- 2단계와의 차이는 `system` 한 줄뿐: "프로젝트 루트에서 실행 중, 상대 경로는 루트 기준".
- 모델이 자기 실행 환경을 전혀 모른다는 것이 2단계 비결정성의 원인이었다.
  환경 정보를 주입하면 도구 호출이 안정된다.
- Claude Code의 시스템 프롬프트에 "Primary working directory"가 들어있는 이유가 이것.
- 100% 강제가 필요하면 `tool_choice: { type: "any" }` 파라미터도 있다.
- 입력 토큰 740 → 806: system 프롬프트도 컨텍스트 비용이다.

### 4단계. 수동 왕복 1회: 요청서를 직접 실행하고 결과 돌려주기

```bash
bun run steps/04-manual-roundtrip.ts
```

**관찰 포인트**
- 도구 실행 코드는 특별할 게 없다. `Bun.file(path).text()`, 그냥 파일 읽는 백엔드 코드다.
- 대화에 ① 모델의 tool_use 응답(`role: "assistant"`) ② 우리의 실행 결과(`role: "user"`의
  `tool_result` 블록)를 이어 붙여 **같은 호출을 한 번 더** 한다.
- `tool_result`의 `tool_use_id`가 요청서의 `id`와 짝을 맞춘다.
- 2차 응답에서 모델이 실제 파일 내용을 근거로 요약한다. "초코 파치 인형", 포트 4173이 나오면
  진짜 읽은 것이다. 1단계에서 "읽을 수 없다"던 바로 그 질문에 이제 대답한다.
- 실측(2026-08-17): 1차 입력 806 → 2차 입력 1,361 토큰. 대화 전체 + 파일 내용이 재전송된다.
- **보안**: 모델이 준 path는 신뢰할 수 없는 사용자 입력이다. 코드에 경로 검증 가드가 있다:
  `resolve()` 후 프로젝트 루트 밖이면 `is_error: true`로 거부를 돌려준다.
  거부 시연은 4c단계로 직접 돌려볼 수 있다. Part 2의 Agent SDK permissions가 이 문제의 체계화다.

### 4b단계. 규칙 위반 실험: 요청서를 무시하면?

```bash
bun run steps/04b-broken-roundtrip.ts
```

**관찰 포인트**
- tool_use를 받고 tool_result 없이 다음 질문만 보내면 **400 에러**가 난다.
- 에러 메시지 실측(2026-08-17): "Each `tool_use` block must have a corresponding
  `tool_result` block in the next message". 왕복의 규칙을 API가 강제한다.
- 병렬 tool_use(요청서 여러 개)면 tool_result도 전부 다음 user 메시지 하나에 담아야 한다.

### 4c단계. 경로 검증 가드 시연: 프로젝트 밖 파일을 요청하면?

```bash
bun run steps/04c-path-guard.ts
```

**관찰 포인트**
- 질문만 위험하게 바꿨다: "/etc/hosts 파일을 읽고 내용을 알려줘."
- 1차 호출에 `tool_choice: { type: "any" }`로 도구 사용을 **강제**했다 (3단계에서 본 옵션).
  강제하지 않으면 모델이 도구 없이 스스로 거절해버리는 실행이 섞여 시연이 재현되지 않는다
  (실측 2026-08-17: 강제 후 3회 연속 동일 재현).
- 강제하면 모델은 `read_file("/etc/hosts")` 요청서를 보낸다. **모델의 인자는 사용자 입력이다.**
- 가드가 거부하고 `is_error: true`로 돌려줘도 대화는 깨지지 않는다.
  모델이 "프로젝트 루트 내의 파일만 읽을 수 있습니다"라고 설명하며 정상 종료한다.

### 5단계. while 루프 = 에이전트

```bash
bun run steps/05-agent-loop.ts
```

**관찰 포인트**
- 4단계의 왕복을 `stop_reason === "tool_use"`인 동안 반복한다. 이것이 에이전트다.
- 도구가 둘이다(read_file + list_files). **실행 경로를 모델이 스스로 그린다.**
  목록을 보고, 문서를 읽고, 소스를 파고드는 순서를 우리가 정하지 않았다.
- 요청서가 한 응답에 여러 개 올 수 있다(병렬 호출). for문으로 전부 실행해
  하나의 user 메시지에 담아 돌려준다. 실측(2026-08-17): 턴 2에서 4건 병렬.
- 매 턴 입력 토큰이 커진다 (실측: 1,056 → 5,283). 대화가 누적 재전송되기 때문이다.
- 실전 장치들: MAX_TURNS 안전장치, 경로 가드 + 숨김 파일(.env) 차단, 실패는 is_error로.
- **잘라내기 + 이어 읽기**: 큰 파일은 4,000자로 잘라 반환한다(도구 결과도 컨텍스트 예산).
  잘림 표시에 "이어 읽으려면 offset: N"을 안내하면 모델이 스스로 이어 읽는다.
  실측(2026-08-17): README.md(4,405자) 완독 요청 → offset 0 → 4000 두 번으로 나눠 읽고
  마지막 섹션(`## 구조`)을 정확히 답했다. Claude Code Read 도구와 같은 구조다.
- **비용 집계**: 코드가 턴별 usage를 합산해 추정 비용을 출력한다 (Part 2와 비교용).
  실측(2026-08-17 재실행, 4턴): 입력 13,273 + 출력 1,594 토큰, **$0.0212**.
- 전체 134줄(주석 포함). 에이전트는 모델이 아니라 루프다.

## Part 2. Agent SDK

### 6단계. Agent SDK 첫 호출: query() 하나로 같은 과제

```bash
bun run steps/06-agent-sdk.ts
```

**관찰 포인트**
- Part 1에서 134줄이던 에이전트가 **55줄**(주석·예외 처리 포함). 루프, 왕복 규칙, truncation, 안전장치가
  전부 SDK 안으로 들어갔다. 우리가 쓴 것은 질문과 옵션뿐이다.
- `allowedTools: ["Read", "Glob"]`는 **자동 승인 목록이지 도구 제한이 아니다.**
  실측(2026-08-17): 목록에 없는 Bash도 실행됐다. 제한과 권한 제어는 7단계에서.
- **로컬 PC의 Claude Code 하네스가 SDK 세션에도 그대로 실린다.** CLAUDE.md, rules, settings.json의
  권한·훅, 스킬, 에이전트, MCP 서버, 플러그인까지. SDK는 Claude Code를 라이브러리로 감싼 것이라
  CLI와 같은 기본값으로 시작하기 때문이다(`settingSources` 생략 시 "CLI 기본값과 동일"). 그래서 같은
  코드가 내 PC와 서버, 동료 PC에서 다르게 동작하고, 로컬 설정 분량만큼 매 호출 프리픽스가 커진다.
  서버에서는 `settingSources: []`(설정 파일 무시) + `strictMcpConfig: true`(옵션으로 넘긴 MCP만)로
  격리하는 것이 기본값이어야 한다. 이 저장소의 SDK 실습(6단계 이후)은 전부 격리 모드로 통일했다
  (8/17 첫 실측 $0.1290은 격리 전 수치).
- result 메시지에 비용이 집계된다. **턴 수는 주의.** result의 `num_turns`는 API 왕복 수가 아니다.
  공식 문서에 정의가 없고, 실측으로는 정상 종료 시 "최초 프롬프트 1 + 도구 결과 수"(도구 호출마다 1)와
  일치했다(예: API 응답 6개, 도구 호출 15건인 세션이 num_turns 16). maxTurns 초과로 끝날 때는
  "API 왕복 + 1"이 찍혀 셈법이 또 다르다. 그래서 Part 1의 "턴"(API 왕복)과 같은 단위로 비교하려고
  코드가 assistant 메시지의 `message.id` 고유 개수를 직접 센다.
  실측(2026-08-21, 격리 모드): API 왕복 7회, **$0.0609**. 실행마다 다르다(같은 날 6~8회, $0.05~0.08.
  옵션을 바꾼 직후 첫 실행은 프리픽스 캐시 쓰기 때문에 더 비싸다). 같은 과제를 같은 프로젝트 상태에서
  재실측한 Part 1 루프는 4회, $0.0212 (약 3배 차이). 비싼 이유는 둘이다: ① 하네스(시스템 프롬프트 +
  내장 도구 정의, 약 25k 토큰)가 매 왕복 실린다(프롬프트 캐싱이 기본 적용돼도 공짜는 아니다)
  ② 탐색도 조금 더 깊다(6~8회 vs 4회).
- `query()`는 답을 한 번에 주지 않고 **메시지 스트림**을 준다. 순서는 `system/init` 1회 → `assistant`(tool_use)와
  `user`(tool_result)가 도구 호출 수만큼 번갈아 → 마지막 `assistant`(text) → `result` 1회. 한 응답에 요청서가
  여럿이면 assistant 메시지도 여럿, 돌아가는 user 메시지도 여럿이다(실측: 질문 하나에 메시지 23개, API 왕복 6회,
  도구 호출 10건). 같은 API 응답의 블록들은 `message.id`가 같다.
- `maxTurns`는 API 왕복 수의 상한이다. 요청 한 번 보내고 응답 한 번 받으면 1턴이고, 응답 하나에 도구
  호출이 여러 개 들어 있어도(병렬 호출) 1턴이다. 정확히 걸린다(실측: maxTurns 3 → 응답 3개, 도구 호출
  9건에서 `error_max_turns`). 걸리면 result 뒤에 `for await`가 예외를 던지므로 try/catch로 받는다.
- result는 드물게 **두 번** 온다. 느린 명령(`find .` 등)을 SDK가 백그라운드로 넘기고, 끝나면 알림으로
  새 턴을 시작하기 때문이다. 비용은 누적이므로 마지막 result를 읽는다(코드가 그렇게 되어 있다).

### 7단계. 권한 실험: 기본 모드에서 무엇이 되고 안 되나

```bash
bun run steps/07-permission-default.ts
```

**관찰 포인트**
- SDK 세션의 permissionMode 기본값은 **default**다 (실측 + 공식 문서: "claude -p와
  Agent SDK"의 시작 모드는 default). CLI 대화 세션(Pro·Max·Team, v2.1.228+)의 기본이
  auto(분류기가 사람 대신 검토·승인)인 것과 **다르다**.
- default 모드: 읽기는 자동, Bash는 승인 대상이되 내장 "읽기 전용 명령 목록"(pwd, ls 등)은
  자동 실행. 6단계에서 Bash가 돌았던 진상이다. allowedTools는 그 위에 얹는 자동 승인 목록.
- 쓰기(Write)는 승인 필요 → 승인자(canUseTool 콜백)가 없으면 **자동 거부**.
  실측(2026-08-21): Write 거부 후 모델이 Bash `echo > hello.txt`로 우회를 시도했고 그것도 거부됐다.
  permission_denials에 기록이 남고 hello.txt는 만들어지지 않는다.
- **최종 답변을 믿지 않는다.** 거부됐는데도 "완료했습니다! 파일을 만들었습니다"라고 답하는 경우가
  생길 수 있다(할루시네이션, 8/17 실측). 8/21 실측에서는 "권한을 요청했습니다. 승인해 주세요"였다.
  어느 쪽이든 파일이 있는지는 우리가 확인해야 한다. 거부 처리는 우리 책임이고, 결과 검증(Part 3)이
  필요한 이유다.
- 다음(7b단계): canUseTool로 canUseTool 승인 콜백를 직접 구현한다.

### 7b단계. canUseTool 승인 콜백: 이번엔 우리가 승인자다

```bash
bun run steps/07b-permission-gate.ts
```

**관찰 포인트**
- `canUseTool` 콜백을 옵션에 넘기면, 승인 대상 도구가 실행되기 **직전에** SDK가 우리
  코드를 부른다. `{ behavior: "allow", updatedInput }` 또는 `{ behavior: "deny", message }`로 답한다.
  allow의 `updatedInput`으로 인자를 고쳐 넘길 수 있고, deny의 `message`는 모델에게 전달된다.
- `toolName`은 정해진 유니온 타입이 아니라 **string**이다. 올 수 있는 값은 내장 도구 이름(Write, Edit,
  Bash, NotebookEdit, WebFetch, WebSearch, Task, Skill …)과 MCP 도구 이름(`mcp__<서버>__<도구>`).
  단 canUseTool에 실제로 오는 것은 현재 권한 모드에서 **승인 대상인 호출**뿐이다. default 모드에서 읽기
  (Read, Glob, Grep)와 읽기 전용 Bash, allowedTools에 올린 도구는 오지 않는다.
- 세 번째 인자 `options`에 `blockedPath`(차단된 경로), `decisionReason`(왜 승인이 필요한지),
  `suggestions`(“항상 허용” 규칙 후보), `toolUseID`, `agentID`(서브에이전트에서 온 요청)가 실린다.
  승인 UI를 만들 때 쓰는 재료다.
- canUseTool의 규칙은 Part 1 5단계의 `guard()`와 같다(프로젝트 밖·숨김 파일 거부). 우리 루프
  안에 직접 넣었던 가드가, SDK에서는 **콜백 하나**로 같은 자리에 들어간다.
- Write가 막히자 모델은 **Bash로 우회**(`echo "안녕" > /tmp/outside.txt`)를 시도했다.
  승인 대상은 전부 canUseTool을 지나므로 우회도 같은 자리에서 잡힌다.
- 읽기(Read, Glob, 읽기 전용 Bash)는 default 모드가 자동 승인하므로 canUseTool에 오지 않는다.
  canUseTool 로그에 Write와 Bash만 찍히는 이유다.
- 실측(2026-08-21): 5턴, 거부 2건. hello.txt 생성됨, /tmp/outside.txt 없음. 이번엔 모델의
  최종 보고도 정확했다. 그래도 파일 존재는 코드가 직접 확인한다(모델의 보고를 믿지 않는다).
  Bash 우회 시도는 실행마다 다르다. 우회 없이 4턴, 거부 1건으로 끝나는 경우도 있다.

### 8단계. 세션: 대화를 이어가기

```bash
bun run steps/08-session-resume.ts
```

**관찰 포인트**
- `query()`는 호출마다 새 세션이다. Part 1의 stateless와 같다. 이어갈지는 우리가 정한다.
- Part 1에서는 `messages` 배열을 우리가 들고 다녔다. SDK에서는 result 메시지의 `session_id`
  하나만 들고 있으면 된다. 대화 원문은 SDK가 `~/.claude/projects/<프로젝트 슬러그>/<session_id>.jsonl`에
  적는다(실측: 1차 실행 직후 JSONL 생성, 32줄).
- `resume: sessionId`로 이어가면 이전 대화가 통째로 컨텍스트에 실린다. 실측(2026-08-21):
  1차(파일 읽기) 도구 1회 $0.0161 → 2차(resume, "엔드포인트 몇 개?") 도구 0회 $0.0044,
  같은 session_id, "2개(/health, /inventory/{SKU})" 정답.
- resume 없이 같은 질문을 던지면 새 session_id에 "우리 대화의 첫 메시지여서 알 수 없습니다"($0.0111).
  세션은 마법이 아니라 저장과 재전송이다.
- `ask()`는 query()를 감싼 우리 래퍼다(이름도 우리가 지었다). SDK에 이걸 대신하는 내장 함수는 없다.
  SDK는 메시지 스트림까지만 주고, 스트림을 어떻게 모을지는 앱마다 달라서 정해주지 않는다. 실무에서도
  이런 래퍼를 하나 만들고 로깅·비용 집계·재시도를 그 안에 넣는다. 세션을 열어둔 채 계속 대화하려면
  `prompt`에 `AsyncIterable<SDKUserMessage>`를 넘기는 스트리밍 입력 방식도 있다(채팅형).
- 백엔드 설계 힌트: 사용자·대화 키 ↔ session_id 매핑을 DB에 두면 멀티턴 챗 API가 된다.
  `forkSession: true`로 같은 지점에서 분기할 수도 있다(개념만).
- 프롬프트에 상대 경로 `src/index.ts`를 주면 모델이 `/Users/<나>/src/index.ts`로 잘못 푸는 경우가
  있었다(2회 중 2회, 그중 1회는 승인 요청에서 멈춤). 절대 경로로 바꾸니 안정됐다. Part 1 ACI의
  "절대 경로" 교훈 그대로다.

### 9단계. 커스텀 도구: 우리 백엔드 API를 에이전트의 손발로

```bash
bun run steps/09-mcp-tool.ts
```

**관찰 포인트**
- Part 1의 `tools` 배열(이름·설명·input_schema)과 같은 것을 SDK에서는 `tool(이름, 설명, zod 스키마, 핸들러)`로
  선언한다. 차이는 선언과 실행 코드가 한 자리에 있다는 것. zod가 타입과 입력 검증을 동시에 준다.
- 도구는 셋이다. `list_products`(목록), `get_inventory`(단건), `create_order`(주문 = 재고 차감, 쓰기).
  파치마켓 API도 `GET /products`, `POST /orders`가 추가됐다(`src/index.ts`). 도구 선언과 canUseTool(`makeGate`)는
  `src/pachi-mcp.ts`에 있고 9~15단계(13 제외)가 공유한다.
- `createSdkMcpServer`는 별도 프로세스 없이 이 프로세스 안에서 도는 MCP 서버다. 프로덕션에서는 같은
  도구를 stdio/HTTP MCP 서버(`mcpServers: { pachi: { type: "http", url } }`)로 떼어내 여러 에이전트가 공유한다.
- 도구 이름은 `mcp__<서버>__<도구>`가 된다. MCP 도구는 기본적으로 승인 대상이라 전부 `canUseTool`을
  지난다(7b 그대로). 읽기 둘은 통과, `create_order`는 5개 이하만 허용. 권한 모델이 우리 도구에도 적용된다.
- 읽기 도구를 `allowedTools`에 올리면 canUseTool을 **건너뛴다**. SDK가 `canUseTool will not be invoked for: …`
  경고(`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`)로 알려준다. allowedTools가 콜백보다 우선한다는 뜻이다.
- 실측(2026-08-21): 프롬프트 "재고 있는 상품 중 가장 싼 상품 하나를 수량 2개로 주문하고 남은 재고를 재조회".
  모델이 먼저 `ToolSearch`로 도구 스키마를 가져온 뒤 `list_products` → `create_order(SKU-7003, 2)`(canUseTool 승인)
  → `get_inventory(SKU-7003)` 순서로 불렀다. 순서는 우리가 짜지 않았다. 5턴, $0.0274.
- 도구 검색(tool search). 실행 로그의 첫 도구 요청이 `ToolSearch({"query":"select:mcp__pachi__…"})`인 이유다. 런타임은
  MCP 도구의 정의(설명·입력 스키마)를 처음부터 컨텍스트에 싣지 않고 **이름과 서버 instructions만** 보여준 뒤, 모델이
  `ToolSearch`로 찾을 때 맞는 스키마를 실어 준다(한 번에 최대 5개, 이후 턴에도 유지, 컴팩션으로 밀리면 다시 검색).
  내장 도구(Read·Bash 등)는 처음부터 전부 실린다. 이유는 둘. 도구 50개면 정의만 10~20K 토큰이고, 30~50개를 넘으면
  고르는 정확도가 떨어진다. 값은 첫 검색 때 API 왕복 1회. `ENABLE_TOOL_SEARCH=false bun run steps/09-mcp-tool.ts`로
  끄면 ToolSearch 단계 없이 `list_products`를 바로 부른다(실측 2026-08-21). 도구 10개 미만이면 끄는 편이 빠르고,
  서버 설정 `alwaysLoad: true`로 서버 하나만 처음부터 실을 수도 있다. 검색 대상은 도구 이름·설명·인자 이름·인자 설명
  넷이라 이 넷이 곧 검색어다. `createSdkMcpServer({ instructions })`는 "언제 이 서버를 찾을지"를 적는 서버 단위
  안내문이다(2KB에서 잘림). 토큰을 아끼는 손잡이는 `ENABLE_TOOL_SEARCH=false`(10개 미만), `auto:N`(미룰 정의가
  컨텍스트의 N%에 닿을 때만 검색, 기본 10), 서버별 `alwaysLoad`(매 턴 쓰는 3~5개만 처음부터), 짧은 설명(찾은 스키마는
  이후 모든 턴의 입력 토큰), 그리고 도구 결과 크기(스키마보다 결과가 크다. 페이지네이션·필터·필요한 필드만). 값은
  `query()`의 `env` 옵션으로 주되 TypeScript는 `env`가 자식 프로세스 환경을 통째로 바꾸므로 `...process.env`를 펼친다.
  미룬 도구는 시스템 프롬프트 접두사 밖에 있고 찾은 스키마는 대화 중간에 끼워지므로 프롬프트 캐시는 유지된다.
  출처: [Agent SDK, Tool search](https://code.claude.com/docs/en/agent-sdk/tool-search),
  [Claude Code, MCP tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search),
  [API, Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- 끝나면 코드가 `GET /inventory/SKU-7003`으로 **서버 상태를 직접 확인**한다(340 → 338). 첫 실측에서는 모호한
  프롬프트("가장 싼 것을 2개")를 모델이 "가장 싼 두 상품을 1개씩"으로 읽어 339가 나왔고, 이 검증 줄이
  그것을 잡아냈다. 모델의 보고를 믿지 않는 이유다.
- 파치마켓 API(`src/index.ts`)는 실습 스크립트가 import해서 같은 프로세스에 띄우고(`export const server`),
  끝나면 `api.stop()`으로 내린다. 별도 터미널이 필요 없다.

### 9b단계. 도구 검색 옵션을 코드에 넣는 자리

```bash
bun run steps/09b-tool-search-options.ts            # 기본 auto
bun run steps/09b-tool-search-options.ts auto:5     # 임계치 5%
bun run steps/09b-tool-search-options.ts false      # 검색 끔
```

**관찰 포인트**
- 09와 같은 과제를 정책만 바꿔 돌린다. `env: { ...process.env, ENABLE_TOOL_SEARCH: POLICY }`가 런타임 정책이고,
  `systemPrompt: { type: "preset", preset: "claude_code", append: "…" }`가 "무엇을 찾을 수 있는지" 안내 한 줄이다.
  TypeScript의 `env`는 자식 프로세스 환경을 통째로 바꾸므로 `...process.env`를 펼치지 않으면 `ANTHROPIC_API_KEY`도 사라진다.
- 실측(2026-08-21, Haiku 4.5 200K): 기본값(미설정) ToolSearch 1회, `auto`(10%) 0회, `auto:5` 1회, `false` 0회.
  `auto:5`에서 켜진 이유는 임계치 합산에 "미룰 수 있는 내장 도구" 정의도 들어가기 때문이다. pachi 3개만으로는
  5%에 못 미치지만 내장 지연 도구까지 더하면 5~10% 사이다. 비용은 $0.05~$0.12로 캐시 적중에 따라 흔들리므로
  정책 간 비용 비교 근거로는 쓰지 않는다.
- 정책과 무관하게 처음부터 실으려면 서버 단위 `createSdkMcpServer({ alwaysLoad: true })` 또는 도구 단위
  `tool(name, desc, schema, handler, { alwaysLoad: true, searchHint: "…" })`. `searchHint`는 검색에만 쓰이는 힌트 문자열이다.

### 10단계. 훅: 모든 도구 호출에 끼어드는 수명주기 장치

```bash
bun run steps/10-hooks.ts
```

**관찰 포인트**
- `hooks` 옵션에 `PreToolUse`/`PostToolUse` 콜백을 달면 도구가 실행되기 직전·직후에 우리 코드가 불린다.
  빈 객체를 돌려주면 그대로 진행하고, PreToolUse에서 `hookSpecificOutput.permissionDecision: "deny"`를
  돌려주면 막을 수도 있다. 이 실습은 기록만 하고 승인 결정은 canUseTool(`makeGate`)에 남긴다. 역할을 섞지 않는다.
- **canUseTool은 승인 대상 도구만 보지만 훅은 자동 승인되는 도구까지 전부 본다.** 실측(2026-08-21):
  canUseTool 로그에는 `create_order`만 찍히는데 훅 로그에는 `ToolSearch`, `list_products`, `create_order`,
  `get_inventory` 네 종이 전부 찍혔다(`audit.jsonl` 8줄 = pre 4 + post 4). 감사 로그는 훅 자리가 맞다.
- PostToolUse에는 `tool_response`와 `duration_ms`가 실린다. 호출-결과 쌍을 JSONL로 남기면 그대로
  감사 로그다. Part 3의 관측(Langfuse)은 이것을 대시보드로 올리는 일이다.
- 훅 이벤트는 31개다(SDK 0.3.233 타입 정의 기준, 각 입력 타입의 필드로 분류):
  - 도구 실행 4: PreToolUse(실행 직전), PostToolUse(성공 후, tool_response·duration_ms), PostToolUseFailure(실패 후, error),
    PostToolBatch(병렬 묶음이 모두 끝난 뒤, 다음 모델 요청 전)
  - 권한 2: PermissionRequest(승인 요청 발생), PermissionDenied(거부됨, reason)
  - 턴 종료 2: Stop(메인 에이전트 응답 완료, last_assistant_message), StopFailure(턴이 에러로 끝남)
  - 세션·설정 4: Setup, SessionStart(source: startup/resume 등), SessionEnd(reason), ConfigChange(설정 파일 변경)
  - 입력·컨텍스트 5: UserPromptSubmit(source: user/sdk 등), UserPromptExpansion(슬래시 커맨드 확장), PreCompact,
    PostCompact(compact_summary), InstructionsLoaded(CLAUDE.md 등 메모리 파일 로드)
  - 서브에이전트·작업 5: SubagentStart, SubagentStop, TaskCreated, TaskCompleted, TeammateIdle(팀 필드는 deprecated)
  - MCP 입력 요청 2: Elicitation(MCP 서버가 사용자 입력을 요청, 훅이 자동 응답 가능), ElicitationResult
  - 환경·표시 7: CwdChanged, DirectoryAdded(/add-dir 또는 SDK register_repo_root), FileChanged, WorktreeCreate,
    WorktreeRemove, Notification, MessageDisplay(스트리밍 표시용, 표시 전용)
  서버 에이전트에서 주로 쓰는 것은 도구 실행·권한·턴 종료·세션·컨텍스트 묶음이다.
- **matcher**: 도구 이벤트(PreToolUse, PostToolUse 등)에서 도구 이름을 고르는 문자열이다. 세 형태를 받는다.
  이름 그대로(`"Write"`, 대소문자 구분, 정확히 그 도구만), 정규식(`"Edit|Write"`, `"mcp__pachi__.*"`), 전부(`"*"` 또는
  생략). 정규식만 되는 것이 아니다. 한 이벤트에 matcher가 다른 항목을 여러 개 둘 수
  있고, 각 항목의 `hooks` 배열에 콜백을 여러 개 넣을 수 있다. 실습 코드는 "전부" 훅과 `"mcp__pachi__.*"` 훅을
  같이 달아 ToolSearch는 전부 훅에만, pachi 도구는 둘 다에 찍히는 것을 보여준다. SessionStart처럼 도구가
  없는 이벤트는 matcher가 시작 유형(startup/resume/clear/compact) 같은 다른 값을 고른다.
- **CLI와 SDK에서 훅의 쓰임이 달라 보이는 이유.** CLI는 사용자가 코드를 걸 수 있는 곳이 설정 파일의 hooks뿐이라
  차단 정책이 전부 훅으로 간다. SDK는 앱 개발자에게 `canUseTool`(승인 전용)과 `hooks` 두 지점이 있어 차단은
  canUseTool로, 훅은 관측으로 역할이 나뉜다. 훅이 차단을 못 하는 게 아니라 더 좋은 자리가 생긴 것이다.
- **훅의 출처는 둘이다.** ① `options.hooks`(앱 개발자가 코드로, 이 실습) ② 설정 파일의 hooks(`~/.claude/settings.json`,
  프로젝트 `.claude/settings.json`). ②는 `settingSources`가 켜져 있으면 SDK 세션에도 실린다(6단계 로컬 하네스).
  격리 모드면 안 실린다. 최종 사용자는 우리 앱이 설정 화면을 열어주지 않는 한 훅을 등록할 수 없다.
- **canUseTool과 훅의 역할 분담.** canUseTool은 "이 호출을 허락할까?" 하나에 답하는 전용 콜백이고 승인 대상
  호출에만 불린다. 훅은 수명주기 이벤트 리스너라 자동 승인 도구와 세션 이벤트까지 보고, 기록·측정·입력
  수정·차단·컨텍스트 주입이 다 된다. 막는 것은 canUseTool로 충분하니 정책은 canUseTool 한 곳에 두고, 훅에는
  관측과 부수 효과를 둔다. 예외는 권한 모드와 무관하게 항상 막아야 하는 조직 차원 하드 차단(`rm -rf`,
  프로덕션 DB 명령)으로, 이건 PreToolUse 훅의 deny가 맞다(모드를 bypass로 바꿔도 살아남는다).
- 실무에서 훅을 쓰는 곳: 감사·컴플라이언스 로그(이 실습), 하드 차단, 입력 교정(경로를 샌드박스 안으로,
  시크릿 마스킹 → `updatedInput`), 세션 시작 때 컨텍스트 주입(`SessionStart`의 `additionalContext`로 고객
  정보·티켓 번호·오늘의 정책), 완료 검증(`Stop` 훅에서 테스트 실패면 멈추지 못하게), 컴팩션 전 백업
  (`PreCompact`), 알림(`PermissionDenied` → Slack), 지연 측정(`duration_ms`).
- **순서(실측 2026-08-21)**: 도구 하나마다 `PreToolUse 훅 → (권한 확인이 필요하면) canUseTool → PermissionRequest 훅 →
  도구 실행 → PostToolUse 훅 → tool_result 메시지`. PreToolUse 훅이 canUseTool보다 **먼저**다. 그래서 PreToolUse 훅의
  `permissionDecision`이 권한 판정을 앞질러 결정할 수 있다. 자동 승인 도구(ToolSearch 등)는 canUseTool과
  PermissionRequest 없이 `PreToolUse → 실행 → PostToolUse`. canUseTool이 거부하면 PostToolUse 없이 거부 메시지가
  tool_result로 모델에게 간다. 턴 전체는 `UserPromptSubmit 훅 → init 메시지 → (도구 반복) → assistant text →
  Stop 훅 → result 메시지`.
- **공식 문서의 권한 평가 순서**(Agent SDK, Permissions "How permissions are evaluated"): ① 훅 → ② deny 규칙
  (disallowedTools, settings) → ③ ask 규칙 → ④ 권한 모드 → ⑤ allow 규칙(allowedTools) → ⑥ canUseTool.
  "훅은 다른 모든 단계보다 먼저 실행되고, 훅의 deny는 bypassPermissions에서도 적용된다." 실측과 일치한다.
  https://code.claude.com/docs/en/agent-sdk/permissions
- 같은 이벤트에 훅이 여럿이면 **병렬로 실행**되고, 권한 결정은 가장 제한적인 결과가 이긴다(하나라도 deny면 차단).
  `maxTurns`에 걸려 끝나면 훅이 안 불릴 수 있다. `PermissionDenied` 훅은 **auto 모드가 거부할 때** 불리는 것이라
  default 모드 실측에서는 보이지 않았다. SessionStart·SessionEnd 훅도 이번 실측에서는 불리지 않았다(관찰만 기록).
  전체 이벤트 표: https://code.claude.com/docs/en/agent-sdk/hooks#available-hooks
- 이 실습은 그중 감사 로그 하나만 구현한다. 하나만 둬서 "훅 = 관측 자리"가 선명하게 남게 했다.
- `audit.jsonl`은 실행마다 새로 쓴다(`.gitignore`에 있음).

- canUseTool을 거치지 않는 읽기 내장 도구(Read·Glob·Grep·ToolSearch)도 막을 수 있다. 실측(2026-08-23) 둘.
  ① `disallowedTools: ["Read"]`: init의 `tools` 목록에서 Read가 빠지고 모델은 "Read 도구가 없다"고 답한다(도구 정의
  자체를 제거. 경로만 막으려면 `Read(//secrets/**)` 같은 범위 규칙). ② `PreToolUse` 훅이 `permissionDecision: "deny"`를
  돌려주면 Read가 목록엔 있어도 실행되지 않고 `permissionDecisionReason`이 tool_result로 모델에게 간다. 훅은 권한 판정의
  맨 앞이라 bypassPermissions에서도 듣는다. 설정 파일의 `permissions.deny`/`ask` 규칙도 같은 자리지만 격리 모드
  (`settingSources: []`)에서는 읽히지 않는다.
- 훅 timeout. `HookCallbackMatcher.timeout`은 **초 단위**이고 묶음 안의 훅 전부에 적용된다. 생략하면 이벤트별 기본값
  (대부분 600초, `UserPromptSubmit` 30초, `MessageDisplay` 10초, `SessionEnd`는 종료 예산 1.5초). 넘기면 런타임이 훅을
  취소하고 실패로 친다. `PreToolUse`면 **도구를 부르지 않고** 모델에게 "훅이 제때 응답하지 않았다"는 tool_result가
  간다(v2.1.210 이전엔 사용자 거부로 보고돼 세션이 멈췄다). `PostToolUse`면 도구 결과는 그대로 두고 진행한다.
  콜백 세 번째 인자의 `AbortSignal`로 취소를 받을 수 있다. 10단계 pachi 매처에 `timeout: 10`을 달아 뒀다.
  출처: [Agent SDK, Hooks "Hook timeout"](https://code.claude.com/docs/en/agent-sdk/hooks#hook-timeout).

### 11단계. 서브에이전트: 하위 작업을 별도 컨텍스트로

```bash
bun run steps/11-subagent.ts
```

**관찰 포인트**
- `agents: { auditor: { description, prompt, tools } }`로 에이전트를 하나 정의하면 메인 에이전트가 `Agent`
  도구(구 `Task`)로 부른다. 15장 오케스트레이터-워커 패턴의 SDK판이다.
- 서브에이전트의 메시지는 `parent_tool_use_id`가 채워져서 오므로 스트림에서 누가 한 일인지 구분된다.
  서브에이전트의 탐색은 메인 컨텍스트에 쌓이지 않고 결과 보고만 돌아온다.
- `tools`로 서브에이전트의 도구를 제한한다. 여기서는 `Read`만 준다. 실측(2026-08-21): 같은 프로세스
  MCP 서버(pachi)의 도구는 서브에이전트에서 실행되지 않았다(호출은 찍히는데 핸들러가 돌지 않음). 그래서
  이 실습은 `src/index.ts`의 재고표를 읽게 했다. 실측: `Agent(auditor)` → `Read(src/index.ts)` → 보고,
  2026-08-21 2턴 $0.0304, 2026-08-23 1턴 $0.0760(num_turns는 서브에이전트 호출을 세지 않아 실행마다 다르게 보인다).
- 서브에이전트는 백그라운드 작업으로 돌 수 있어 result가 두 번 올 수 있다. 코드는 마지막 result를 읽는다.
  모델이 위임을 안 하고 직접 할 때도 있어 프롬프트에 "반드시 auditor에게"라고 명시했다.
- 컴팩션은 실습하지 않는다. 컨텍스트를 채워야 발동해서 강의 중 재현이 어렵다. 세션 계약 장의 한 행으로만 다룬다.

### 12단계. structured output: 답을 코드가 쓸 수 있는 JSON으로

```bash
bun run steps/12-structured-output.ts
```

**관찰 포인트**
- `outputFormat: { type: "json_schema", schema }`를 주면 SDK가 루프의 마지막 답을 스키마로 검증해
  `result.structured_output`에 싣는다. 11단계 options에서 달라진 건 이 한 줄과 결과를 읽는 자리뿐이다.
- 실측(2026-08-23): 도구 호출과 auditor 위임은 그대로 돌고, 마지막에 `StructuredOutput` 도구 호출이 하나 더
  찍힌다. SDK는 우리 스키마를 입력으로 갖는 도구를 끼워 넣어 마지막 답을 그 입력으로 받는다(Part 1 tools 배열의
  input_schema가 출력 스키마로 쓰이는 셈). canUseTool에는 오지 않는다(자동 승인). 턴 4, $0.1180.
- SDK 층은 검증 + 재프롬프트다. 한도를 넘으면 `error_max_structured_output_retries`. Messages API 층
  (`output_config.format`)은 constrained decoding이라 재시도 없이 디코딩 단계에서 보장된다. 같은 이름, 다른 보장.
- `success`여도 `structured_output`이 없을 수 있어 둘 다 확인한다. zod `safeParse`로 타입 붙은 값을 만든 뒤는
  그냥 코드다(품절만 골라 알림).
- SDK 검증기는 JSON Schema draft-07. zod 4 `toJSONSchema`는 기본 2020-12라 `target: "draft-7"`을 준다.
  재귀 스키마, `minimum`/`maxLength` 같은 수치 제약은 미지원.
- 출처: [Agent SDK, Structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) ·
  [Claude API, Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

### 비용 집계 메모 (덱 108장 보충)

result의 세 필드 외에, 직접 비용 집계기를 만들 때 알아야 할 것 셋. 덱에는 싣지 않는다.

- 캐시: 매 왕복 전체 재전송인데도 비용이 선형으로 안 느는 이유는 접두사가 `cache_read_input_tokens`(할인)로
  처리되기 때문이다. `cache_creation_input_tokens`(캐시 쓰기)는 정가보다 비싸다. 둘을 따로 세야 절감이 보인다.
- 함정 1: 스트림 메시지의 `usage`를 그냥 합치면 틀린다. `output_tokens`는 message_start 시점 자리표시자라
  진짜 출력은 result의 usage에서 읽고, 병렬 호출은 같은 `message.id`가 같은 usage를 공유하므로 id로 중복 제거한다(6단계).
- 함정 2: SDK는 세션·유저 합계를 주지 않는다. `query()`마다 result는 독립이라 `total_cost_usd`를 앱이 직접
  누적한다. 크래시 시 마지막 `error_during_execution` result는 비용 필드가 0으로 올 수 있어 직전 result 값을 보관한다.
- 출처: [Agent SDK, Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

### 14단계. SDK 에이전트 관측: query() 하나를 Langfuse 트레이스로

```bash
bun run steps/14-sdk-tracing.ts
```

**관찰 포인트**
- Part 1(13단계)은 모델 호출마다 generation을 우리가 찍었다. SDK는 루프가 서브프로세스 안이라 API 왕복 하나하나가
  우리 코드에 안 보인다. 보이는 단위는 query 하나(AGENT)와 도구 호출(TOOL). 추상화가 올라가면 관측 단위도 올라간다.
- OpenInference의 `@arizeai/openinference-instrumentation-claude-agent-sdk`(0.2.13)가 `query()`를 감싸 AGENT span을
  만들고, 훅(PreToolUse/PostToolUse)을 주입해 도구마다 TOOL span을 단다. ESM이라 `manuallyInstrument(SDK)`로 감싼
  `query`를 받아 쓴다. 에이전트 코드는 11단계 그대로(auditor 위임, outputFormat 없음).
- **실측 함정 2 (2026-08-23)**: 12단계처럼 `outputFormat`을 같이 주면 `StructuredOutput` 도구 호출이 세 번 실패하고
  `structured_output`이 비어 온다. `permission_denials` 0건, canUseTool 거부 0건인데 모델은 "호출이 거부되고 있다"고
  답한다. 계측기가 주입한 훅과 SDK의 StructuredOutput 처리가 충돌하는 것으로 보이며 원인은 미확인. 그래서 이 실습은
  11단계 구조로 간다. 계측 + structured output이 함께 필요하면 훅 주입 없이 AGENT span만 직접 만드는 쪽을 검토.
- **실측(2026-08-23) 함정**: `LangfuseSpanProcessor`의 기본 `shouldExportSpan` 필터는 자기 tracer·`gen_ai.*` 속성·
  알려진 LLM 계측기의 span만 내보낸다. 이 계측기는 목록에 없어 AGENT span이 조용히 버려졌다(`LANGFUSE_LOG_LEVEL=debug`로
  "Dropped span due to shouldExportSpan filter" 확인). `shouldExportSpan: () => true`로 열어야 한다.
- **실무에서 여는 법**: `() => true`는 우리 span밖에 없는 실습용이다. HTTP·DB 등 OTel 계측이 깔린 실제 앱에서 전부 열면
  인프라 span이 Langfuse를 뒤덮고 unit 과금도 늘어난다. 계측기 scope 이름으로 좁게 여는 게 정석:
  `shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name.includes("claude-agent-sdk")`.
  단 부모 span만 거르고 자식을 통과시키면 트리가 고아가 되어 화면이 깨지므로, 부분 필터는 계층 단위로 열고 닫는다.
  민감정보는 `mask` 옵션(내용 마스킹)이 담당한다 — 보낼지 말지(shouldExportSpan)와 뭘 지울지(mask)는 다른 게이트다.
- 실측 결과(2026-08-25 갱신, 지붕 반영): 트레이스 `inventory-audit`(SPAN 지붕, 27s) 아래 `ClaudeAgent.query`(AGENT),
  그 아래 TOOL span 2개(Agent, Read). Agent 도구 결과가 `{"isAsync":true,"status":"async_launched"}`라 auditor가
  백그라운드로 떴음이 보인다. AGENT span의 usage는 메인 루프만(입력 10·출력 704·캐시 읽기 25,698), `modelUsage`는
  auditor 포함(입력 7,194·출력 2,675·캐시 읽기 75,316), `total_cost_usd` $0.0322. cost-tracking 문서의 세 필드
  차이가 화면에서 그대로 갈린다.
- `startActiveObservation("inventory-audit", fn)` 지붕 span으로 트레이스 이름을 짓고 input/output을 싣는다. 계측기
  span 이름은 규약 고정(`ClaudeAgent.query`)이고 트레이스 이름을 채우지 않아서, 지붕이 없으면 trace name이 빈 값이다
  (2026-08-25 실측).
- `propagateAttributes({ userId, sessionId, tags }, fn)`로 콜백 안의 span 전부에 유저·세션을 싣는다. Langfuse가
  유저별·세션별로 집계한다. `query()`마다 result가 독립이라 세션 합산은 우리 몫이다.
- `total_cost_usd`는 SDK에 번들된 가격표로 계산한 클라이언트 추정치다. 과금 근거로 쓰지 않는다.
- 출처: [Agent SDK, Track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking) ·
  [OpenInference Claude Agent SDK instrumentation](https://www.npmjs.com/package/@arizeai/openinference-instrumentation-claude-agent-sdk) ·
  [Claude Code, Monitoring](https://code.claude.com/docs/en/monitoring-usage)

### 15단계. 평가: 검증을 반복 가능하게

```bash
bun run steps/15-evals.ts                       # ① 기본: 동시 실행 1 → 5/5
EVAL_CONCURRENCY=2 bun run steps/15-evals.ts    # ② 실패 재현: 2~3/5 (실행마다 흔들림)
EVAL_VARIANT=isolated EVAL_CONCURRENCY=2 bun run steps/15-evals.ts   # ③ 해결: 동시 2에도 5/5
EVAL_VARIANT=toolsearch-off bun run steps/15-evals.ts   # (번외) 도구 검색 끈 변형
```

**관찰 포인트**
- 한 번 맞은 답이 계속 맞는다는 보장은 없다(2b단계). 입력과 기대값을 Langfuse dataset(`pachi-inventory-qa`, 5건)으로
  두고 `dataset.runExperiment({ task, evaluators, runEvaluators })`로 돌린다. 실행마다 dataset run이 생겨 run끼리 비교한다.
  기대값은 `src/index.ts` 재고표에서 사람이 확정한 ground truth.
- task는 12단계 구조(query + structured output으로 `answer`만). evaluator는 결정적 판정(정규화 문자열 일치)과
  `result.total_cost_usd`. run evaluator로 pass_rate. 평가 중엔 `disallowedTools`로 `create_order`를 뺀다.
- **실측(2026-08-23, run 세 번)**: `maxConcurrency: 2` baseline 3/5, 틀린 둘 다 "pachi 도구에 접근할 수 없어".
  도구 검색(9b) 탓인가 해서 `ENABLE_TOOL_SEARCH=false`로 돌려도 3/5(가설 기각). `maxConcurrency: 1`로 돌리자 5/5,
  평균 비용 $0.039 → $0.019. 원인은 query() 둘이 같은 in-process MCP 서버 객체(`pachi`)를 동시에 쓰면서 한쪽이
  도구 목록을 못 받은 것. 모델이 아니라 우리 인프라였고, 한 번 돌려선 안 보이는 실패를 평가가 잡았다.
  틀린 답($0.022)이 맞은 답($0.03~0.06)보다 싸다. 비용만 보면 속는다.
- **해결 실측(2026-08-25)**: `src/pachi-mcp.ts`에 `makePachi()` 팩토리를 추가하고 `EVAL_VARIANT=isolated`로
  query()마다 새 인스턴스를 넘기자 동시 2에서도 5/5. 인스턴스 하나 = MCP 세션 한 벌이라, 공유하면 세션이
  겹쳐 한쪽이 도구 목록을 못 받는다. 분리가 해법이다. 실패 폭은 실행마다 2~3/5로 흔들린다(동시성 버그의 전형).
- 출처: [Langfuse, Experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk) ·
  [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)

### 15b단계. LLM-as-a-Judge: 서술형 답은 모델이 판정한다

```bash
bun run steps/15b-llm-judge.ts                       # ① 기본: judge_pass 3/3
JUDGE_VARIANT=policy bun run steps/15b-llm-judge.ts  # ② CS 정책 한 줄 추가 → 0/3
```

- 15단계의 exact match는 답이 "0", "SKU-7002"처럼 하나로 정해질 때만 된다. "재고 상황을 보고해줘" 같은
  서술형은 정답 문자열이 없으니, 판정 기준(rubric)과 기대 요점을 judge 모델에게 주고 pass/reason을 받는다.
  기대 요점을 같이 주는 reference 기반 판정이라 "모델 마음대로 채점"이 아니다.
- 구조는 15단계 그대로 dataset → task → evaluator이고, evaluator 자리의 코드 판정이 모델 호출로 바뀔 뿐이다.
- **judge를 믿을 수 있게 만드는 장치**: ① rubric에 pass 조건 명시 ② `temperature: 0` ③ structured output
  (`output_config`)으로 pass/reason 스키마를 강제(12단계 outputFormat의 Messages API 판. zod 파싱 실패 시 0점)
  ④ reason을 score comment로 남겨 Langfuse에서 판정 근거를 감사.
- **비용**: 판정 한 건도 모델 호출이다(Langfuse 문서 기준 건당 $0.01~0.10). 프로덕션에선 샘플링으로 조절한다.
- **judge 모델 클래스 고르기**: Langfuse 공식 가이드는 "가장 유능한 모델이 가장 좋은 판정"(GPT-4o·Claude Sonnet급
  예시) + structured output 지원 필수. 실무 판단 기준 셋 — ① 판정 난이도: reference-based 사실 대조는 작은 모델도
  충분(이 실습의 Haiku 3/3 실측), 주관 기준(톤·환각)은 상위 클래스 ② 판정 대상보다 같거나 위 클래스(약한 judge는
  강한 모델의 미묘한 오류를 못 알아봄. 같은 모델 가족의 self-preference 편향도 알려져 있음) ③ 최종 결정은
  calibration: 사람 라벨과의 일치율을 클래스별로 재서 "충분히 일치하는 가장 싼 모델"을 고른다.
- **calibration**: judge를 믿기 전에 사람이 판정한 소수 케이스와 비교하라. 잘 설계된 rubric이면 사람 판정과
  80~90% 일치한다는 게 Langfuse 문서의 수치다.
- 실측(2026-08-25): 서술형 3케이스 judge_pass 3/3, 근거가 comment로 남음. 오답 대조 실험("재고 340개로 넉넉")에는
  `{"pass": false, "reason": "…핵심 수치가 모순됨"}` 반환. 항상 pass를 주는 채점자가 아님을 확인.
  프롬프트로 "JSON만" 지시하던 초기 버전은 ```json 펜스가 섞여 정규식 추출이 필요했는데, `output_config`로
  스키마를 강제한 뒤로는 순수 JSON만 와서 그 방어 코드가 필요 없다(Langfuse 문서도 judge 모델의 structured
  output 지원을 권장).
- **fail도 직접 본다(2026-08-25 실측, policy 변형)**: 에이전트를 일부러 고장 내는 게 아니라, 팀이 실제로
  할 법한 변경이 품질을 깨는 시나리오다. `JUDGE_VARIANT=policy`는 "재고 수량 같은 내부 수치는 노출하지 말라"는
  CS 정책 한 줄만 프롬프트에 더한다. 도구도 데이터도 정상인데 답에서 수치가 빠진다.
  처음엔 judge가 "품절 상태입니다"를 핵심 충족으로 보고 3/3을 줬다 — **평가는 rubric에 적힌 것만 잡는다.**
  보고 기준(구체 수치 필수)을 rubric에 명시하자 policy 0/3, baseline 3/3으로 갈렸고, reason이 rubric 문구를
  그대로 인용했다("수치 없이 상태 표현만 있으면 fail"). 두 요구사항(CS 정책 vs 보고 기준)의 충돌을 평가가
  드러낸 것이다. baseline 프롬프트에도 "구체 수량을 포함해"를 명시해 기준-프롬프트 정합을 맞췄다.
- **평가의 지형**: 지금까지는 배포 전 고정 dataset 실험 = offline 평가. 배포 후에는 라이브 트레이스에 규칙(Rule)을
  걸어 evaluator가 자동 채점하는 online 평가가 있고, online에서 잡힌 엣지 케이스를 dataset에 추가하면 다음 offline
  회귀에 포함된다(dataset이 실전 대표 케이스로 성장). 실험을 CI에서 돌리면 회귀 테스트처럼 동작한다.
- 출처: [Langfuse, LLM-as-a-Judge](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) ·
  [Core Concepts](https://langfuse.com/docs/evaluation/core-concepts)

## Part 3 백로그

- **LLM 관측(observability) 실습**: Langfuse를 붙여 루프의 턴별 토큰·비용·지연·대화 내용을
  대시보드로 본다. 오픈소스 진영의 사실상 표준이고 self-host도 가능하다. (2026-08-17 결정)
  - 세팅 완료: `steps/13-langfuse.ts` (5단계 루프 + `@langfuse/tracing`/`@langfuse/otel` 계측. 2026-08-23 번외 번호 99에서 13단계로 승격).
    trace(실행) → generation(턴별 모델 호출, usageDetails로 토큰) → span(도구 실행) 구조.
  - 준비물: `.env`에 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`.
  - 검증(2026-08-17): 실행 1회 → Cloud에 trace 1건(관측 14개, latency 22s) 적재 확인.
  - 2026-08-23: 14단계로 SDK `query()` 계측과 유저·세션 태깅, 비용 세 필드 개념(덱 106장), 15단계로 평가(dataset run 비교, 덱 113~115장)를 반영했다. Langfuse 개념 장(107)을 실습 앞에 뒀다.
  - 2026-08-23: Langfuse Cloud 실제 화면(Part 1 트레이스, SDK 트레이스, dataset run 비교)을 `deck/img/*.webp`로
    캡처해 110·114·118장에 넣었다(aside repl로 로그인 세션에서 캡처, `scripts/optimize-screenshot.sh`로 WebP 변환).
  - 남은 것: 동시 평가용 MCP 서버 인스턴스 분리 실측. 계측기 + outputFormat 충돌 원인.
  - Claude Code의 langfuse 스킬(`/langfuse`)로 CLI에서 트레이스를 조회하는 사용법도 함께 다룬다.

## 구조

```
src/index.ts              타깃 파일 (파치마켓 재고·주문 API, 모델 주장과 대조용 + LAB 09의 우리 API)
steps/01-no-tools.ts      1단계
steps/02-tool-declared.ts 2단계
steps/02b-probability.ts  2b단계
steps/03-system-prompt.ts 3단계
steps/04-manual-roundtrip.ts 4단계
steps/04b-broken-roundtrip.ts 4b단계
steps/04c-path-guard.ts   4c단계
steps/05-agent-loop.ts    5단계
steps/06-agent-sdk.ts     6단계 (Part 2 시작)
steps/07-permission-default.ts 7단계
steps/07b-permission-gate.ts 7b단계
steps/08-session-resume.ts 8단계
steps/09-mcp-tool.ts     9단계 (파치마켓 API를 MCP 도구로)
steps/09b-tool-search-options.ts  9b단계 (도구 검색 정책·systemPrompt를 코드에)
steps/10-hooks.ts        10단계 (훅으로 감사 로그)
steps/11-subagent.ts     11단계 (서브에이전트 위임)
steps/12-structured-output.ts 12단계 (structured output)
steps/13-langfuse.ts      13단계 (Part 1 루프 Langfuse 계측)
steps/14-sdk-tracing.ts   14단계 (SDK query() Langfuse 계측)
steps/15-evals.ts         15단계 (Langfuse dataset run으로 평가)
steps/15b-llm-judge.ts    15b단계 (LLM-as-a-Judge로 서술형 판정)
src/pachi-mcp.ts          파치마켓 MCP 서버(도구 3개)와 canUseTool 승인 콜백. 9~15단계(13 제외) 공유
```
