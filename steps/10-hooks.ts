// [10단계] 훅: 모든 도구 호출에 끼어드는 수명주기 장치
// 관찰 포인트 1: canUseTool은 "승인 대상" 도구만 본다. 훅(PreToolUse/PostToolUse)은 자동 승인되는 도구
//   (ToolSearch, 읽기 도구)까지 전부 본다. 감사 로그는 훅 자리가 맞다. 실행 결과에서 canUseTool 로그에는
//   없고 훅 로그에는 있는 도구를 찾아보라.
// 관찰 포인트 2: PreToolUse 훅은 막을 수도 있다(hookSpecificOutput.permissionDecision: "deny"). 승인 정책을
//   canUseTool 대신 훅에 둘 수도 있지만, 이 실습은 기록만 하고 결정은 canUseTool에 남긴다. 역할을 섞지 않는다.
// 관찰 포인트 3: PostToolUse에는 결과(tool_response)와 소요 시간(duration_ms)이 실린다. 호출-결과 쌍을
//   JSONL 한 줄씩 남기면 그대로 감사 로그다. Part 3의 관측(Langfuse)은 이것을 대시보드로 올리는 일이다.
// 관찰 포인트 4: 훅 이벤트는 31개(도구 4, 권한 2, 세션 5, 입력·컨텍스트 6, 나머지는 CLI 색이 짙다).
//   도구 전후는 그중 둘일 뿐이다. matcher(도구 이름 정규식)로 특정 도구만 고를 수 있다. 생략하면 전부.
// 실무에서 훅을 쓰는 곳: 감사·컴플라이언스 로그(이 실습), 권한 모드와 무관한 하드 차단(rm -rf, 프로덕션 DB),
//   입력 교정(경로를 샌드박스로, 시크릿 마스킹), 세션 시작 때 컨텍스트 주입(SessionStart additionalContext),
//   완료 검증(Stop 훅), 컴팩션 전 백업(PreCompact), 알림(PermissionDenied → Slack), 지연 측정(duration_ms).
// 차단 예시 (이 실습에선 쓰지 않는다):
//   return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
//            permissionDecisionReason: "프로덕션 DB 명령은 금지" } };

import { appendFile, readFile, rm } from "node:fs/promises";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";
import { api, makeGate, pachi } from "../src/pachi-mcp";

const AUDIT = "audit.jsonl"; // 감사 로그. 한 줄 = 이벤트 하나
await rm(AUDIT, { force: true });
const audit = (entry: Record<string, unknown>) =>
  appendFile(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

// 도구가 실행되기 직전. 빈 객체를 돌려주면 그대로 진행한다.
const onPreToolUse: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  console.log(`  [훅 pre ] ${input.tool_name}`);
  await audit({ event: "pre", tool: input.tool_name, input: input.tool_input, session: input.session_id });
  return {};
};

// 도구가 실행된 직후. 결과와 소요 시간이 같이 온다.
const onPostToolUse: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  console.log(`  [훅 post] ${input.tool_name} (${input.duration_ms ?? "?"}ms)`);
  await audit({
    event: "post",
    tool: input.tool_name,
    ms: input.duration_ms,
    response: JSON.stringify(input.tool_response).slice(0, 160),
  });
  return {};
};

// matcher: 도구 이름 정규식. 이 훅은 pachi 도구에만 불린다. ToolSearch는 위의 "전부" 훅에만 찍힌다.
const onPachiOnly: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  console.log(`  [훅 pachi] ${input.tool_name} ← matcher "mcp__pachi__.*"`);
  return {};
};

const result = query({
  prompt: "재고가 있는 상품 중 가장 싼 상품 하나를 골라 수량 1개로 주문하고, 주문 뒤 남은 재고를 다시 조회해서 알려줘.",
  options: {
    model: MODEL,
    mcpServers: { pachi },
    canUseTool: makeGate(), // 승인 결정은 canUseTool이 (9단계 그대로)
    hooks: {
      PreToolUse: [
        { hooks: [onPreToolUse] }, // matcher 생략 = 모든 도구
        // 정규식에 맞는 도구만. timeout은 초 단위(기본 600). 넘기면 훅 실패로 치고 PreToolUse면 도구를 부르지 않는다.
        { matcher: "mcp__pachi__.*", hooks: [onPachiOnly], timeout: 10 },
      ],
      PostToolUse: [{ hooks: [onPostToolUse] }],
    },
    maxTurns: 8,
    settingSources: [],
    strictMcpConfig: true,
  },
});

for await (const message of result) {
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}, $${message.total_cost_usd.toFixed(4)}`);
  }
}

// 감사 로그 요약: 어떤 도구가 몇 번 불렸나
const lines = (await readFile(AUDIT, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event: string; tool: string });
const counts = new Map<string, number>();
for (const l of lines) if (l.event === "pre") counts.set(l.tool, (counts.get(l.tool) ?? 0) + 1);
console.log(`\n${AUDIT}: ${lines.length}줄. 도구별 호출 수:`, Object.fromEntries(counts));

api.stop();
