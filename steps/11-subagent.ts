// [11단계] 서브에이전트: 하위 작업을 별도 컨텍스트로 보내고 결과만 받는다
// 관찰 포인트 1: agents 옵션에 이름·설명·프롬프트·도구를 적으면 에이전트가 하나 생긴다. 메인 에이전트는
//   Agent 도구(구 Task)로 그 에이전트를 부른다. 15장 오케스트레이터-워커 패턴의 SDK판이다.
// 관찰 포인트 2: 서브에이전트의 메시지는 parent_tool_use_id가 채워져서 온다. 스트림에서 누가 한 일인지
//   구분할 수 있다. 서브에이전트의 탐색은 메인 컨텍스트에 쌓이지 않는다. 결과 보고만 돌아온다.
// 관찰 포인트 3: 서브에이전트에게 줄 도구를 tools로 제한한다. 여기서는 Read만 준다. 주문은 못 한다.
//   (실측: 같은 프로세스 MCP 서버(pachi)의 도구는 서브에이전트에서 실행되지 않았다. 그래서 Read를 쓴다.)
// 관찰 포인트 4: 서브에이전트는 백그라운드 작업으로 돌 수 있어 result가 두 번 올 수 있다. 마지막 result를
//   읽는다(6단계 참조). 모델이 위임을 안 하고 직접 할 때도 있어 프롬프트에 "반드시 auditor에게"라고 명시한다.

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";
import { api, makeGate, pachi } from "../src/pachi-mcp";

const target = `${process.cwd()}/src/index.ts`;

const result = query({
  prompt: `auditor 에이전트에게 ${target}의 재고표 점검을 맡기고, 그 보고를 받아 주의가 필요한 상품만 정리해줘. 직접 읽지 말고 반드시 auditor에게 맡겨.`,
  options: {
    model: MODEL,
    agents: {
      auditor: {
        description: "재고표를 읽고 품절·부족 상품을 보고하는 감사 담당",
        prompt: "너는 파치마켓 감사 담당이다. 재고표를 읽고 품절 상품과 재고 20개 미만 상품을 한 문단으로 보고하라.",
        tools: ["Read"], // 읽기만. 주문(create_order)은 메인 에이전트만 할 수 있다
      },
    },
    mcpServers: { pachi },
    canUseTool: makeGate(["Agent", "Task"]), // 서브에이전트 호출 도구가 승인 대상이 되면 허용
    maxTurns: 10,
    settingSources: [],
    strictMcpConfig: true,
  },
});

let last: SDKResultMessage | undefined;
for await (const message of result) {
  if (message.type === "assistant") {
    const who = message.parent_tool_use_id ? "    └ [auditor]" : "  [main]"; // 서브에이전트의 메시지는 parent_tool_use_id가 있다
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        const input = block.input as { subagent_type?: string; description?: string; file_path?: string };
        const detail = block.name === "Agent" || block.name === "Task" ? `subagent_type=${input.subagent_type}, "${input.description}"` : JSON.stringify(block.input).slice(0, 80);
        console.log(`${who} 도구 요청: ${block.name}(${detail})`);
      }
    }
  }
  if (message.type === "result") last = message; // 백그라운드 서브에이전트 때문에 두 번 올 수 있다
}

if (last) {
  console.log(`\n종료: ${last.subtype}, 턴 ${last.num_turns}, $${last.total_cost_usd.toFixed(4)}`);
  if (last.subtype === "success") console.log("\n최종 답변:\n" + last.result);
}

api.stop();
