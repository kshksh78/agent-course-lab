// [6단계] Agent SDK 첫 호출: Part 1에서 134줄로 만든 것을 다시 만든다
// 관찰 포인트 1: 루프, 도구 실행, 왕복 규칙, truncation, 안전장치를 전부 SDK가 대신한다.
//   우리가 쓴 것은 질문과 옵션뿐이다. 34줄.
// 관찰 포인트 2: allowedTools에 Read, Glob만 적었는데 실측에서 Bash도 실행됐다(2026-08-17).
//   이 옵션은 도구를 "제한"하는 게 아니라 자동 승인 목록이다. 제한과 권한 제어는 7단계에서.
// 관찰 포인트 3: 마지막 result 메시지에 비용(USD)이 집계되어 온다. 턴 수는 주의: result의 num_turns는
//   API 왕복 수가 아니다(실측: 정상 종료 시 "프롬프트 1 + 도구 결과 수", maxTurns 초과 시 "API 왕복 + 1").
//   Part 1의 "턴"(API 왕복)과 같은 단위로 비교하려고 assistant 메시지의 message.id 고유 개수를 직접 센다. 실측(격리 모드): API 왕복 6~7회, $0.07 안팎(실행마다 다름).
//   같은 과제의 Part 1 루프는 4회, $0.0212. 비싼 이유는 둘: ① 하네스(시스템 프롬프트 + 내장 도구 정의,
//   약 25k 토큰)가 매 왕복 실린다 ② 탐색도 조금 더 깊다.
// 관찰 포인트 4: maxTurns는 API 왕복(요청 1 + 응답 1 = 1턴) 상한이고 정확히 걸린다. 응답 하나에 도구
//   호출이 여럿이어도 1턴이다(실측: maxTurns 3 → 응답 3개, 도구 호출 9건에서 error_max_turns).
//   걸리면 result 뒤에 for await가 예외를 던지므로 try/catch로 받는다.
// 관찰 포인트 5: 로컬 PC의 Claude Code 하네스(CLAUDE.md, rules, 권한·훅, 스킬, 에이전트, MCP, 플러그인)가
//   SDK 세션에도 그대로 실린다. 같은 코드가 PC마다 다르게 동작하고 로컬 설정만큼 프리픽스가 커진다.
//   서버에서는 격리가 기본값: settingSources: [] + strictMcpConfig: true. 이후 실습은 전부 격리 모드.

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";

const result = query({
  prompt: "이 프로젝트에 어떤 파일이 있는지 파악하고, 핵심 소스 파일을 찾아 무슨 코드인지 요약해줘.",
  options: {
    model: MODEL,
    allowedTools: ["Read", "Glob"], // 자동 승인 목록. 도구 제한이 아니다 (관찰 포인트 2)
    // maxTurns: API 왕복 수의 상한. 요청 한 번 보내고 응답 한 번 받으면 1턴이다.
    // 응답 하나에 도구 호출이 여러 개 들어 있어도(병렬 호출) 도구 실행은 한 턴 안에서 끝나고,
    // 결과를 모아 다시 보내는 다음 요청이 2턴째다. 상한을 넘으면 result가 error_max_turns로
    // 오고 for await가 예외를 던진다 (관찰 포인트 4).
    maxTurns: 10,
    settingSources: [], // 로컬 PC의 설정 파일(CLAUDE.md, rules, 훅 등)을 싣지 않는다
    strictMcpConfig: true, // 옵션으로 넘긴 MCP 서버만 쓴다. 둘이 합쳐 격리 모드
  },
});

const apiIds = new Set<string>(); // API 왕복 수. Part 1의 "턴"과 같은 단위 (관찰 포인트 3)
let last: SDKResultMessage | undefined; // result는 드물게 두 번 온다(아래 주석). 마지막 것이 누적 합계다

try {
  for await (const message of result) {
    if (message.type === "assistant") {
      apiIds.add(message.message.id);
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          console.log(`  실행: ${block.name}(${JSON.stringify(block.input)})`);
        }
      }
    }
    if (message.type === "result") last = message;
  }
} catch (error) {
  console.log(`\n예외로 종료: ${error}`); // maxTurns 초과 등 error 계열 result는 예외로 끝난다
}

// 느린 명령(find 등)은 SDK가 백그라운드로 넘기고, 끝나면 알림으로 새 턴을 시작한다.
// 그때 result가 한 번 더 오고 비용은 누적된다. 그래서 마지막 result를 읽는다.
if (last) {
  console.log(`\nAPI 왕복 ${apiIds.size}회 (SDK num_turns ${last.num_turns}), 비용: $${last.total_cost_usd.toFixed(4)}`);
  if (last.subtype === "success") console.log("\n── 모델의 최종 답변 ──\n" + last.result);
}
