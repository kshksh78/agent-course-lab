// [9b단계] 도구 검색(tool search) 옵션을 코드에 넣는 자리. 09와 같은 과제를 정책만 바꿔 돌린다.
// 관찰 포인트 1: env 옵션의 ENABLE_TOOL_SEARCH가 런타임 정책이다. "auto"는 미룰 수 있는 도구 정의가
//   컨텍스트의 10%에 닿을 때만 검색 모드로 간다. 기본 실행(auto)에서는 09의 첫 도구 요청이던 ToolSearch가
//   사라지고 list_products를 바로 부른다. TypeScript의 env는 자식 프로세스 환경을 통째로 바꾸므로
//   ...process.env를 꼭 펼친다(안 펼치면 ANTHROPIC_API_KEY도 같이 사라진다).
// 관찰 포인트 2: 실측(2026-08-21, Haiku 4.5 200K). false 0회, auto 0회, auto:5 1회, 기본값(미설정) 1회.
//   auto:5에서 검색이 켜진 이유는 합산 대상에 "미룰 수 있는 내장 도구" 정의도 들어가기 때문이다.
//   pachi 3개만으로는 5%에 못 미치지만 내장 지연 도구까지 더하면 5~10% 사이다.
// 관찰 포인트 3: 서버 단위 createSdkMcpServer({ alwaysLoad: true })와 도구 단위 tool(..., { alwaysLoad, searchHint })는
//   정책과 무관하게 "이건 처음부터 실어라"를 표시한다. 매 턴 쓰는 3~5개에만 쓴다.
// 관찰 포인트 4: systemPrompt.append 한 줄이 모델에게 "무엇을 찾을 수 있는지"를 알려 탐색성 검색을 줄인다.
//   settingSources: []로 CLAUDE.md 등을 끊은 상태에서도 preset 프롬프트에 한 줄 덧붙이는 방식이다.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";
import { api, BASE, makeGate, pachi } from "../src/pachi-mcp";

const POLICY = process.argv[2] ?? "auto"; // bun run steps/09b-tool-search-options.ts [false|true|auto|auto:N]

const result = query({
  prompt:
    "재고가 있는 상품 중 가장 싼 상품 하나를 골라 수량 2개로 주문해줘. 주문 뒤 그 상품의 남은 재고를 다시 조회해서 알려줘.",
  options: {
    model: MODEL,
    mcpServers: { pachi }, // 서버만 처음부터 실으려면 createSdkMcpServer({ ..., alwaysLoad: true })
    canUseTool: makeGate(),
    maxTurns: 8,
    settingSources: [],
    strictMcpConfig: true,
    env: { ...process.env, ENABLE_TOOL_SEARCH: POLICY }, // 런타임 정책. auto = 미룰 정의가 10%에 닿을 때만 검색
    systemPrompt: { type: "preset", preset: "claude_code", append: "재고·주문 작업은 pachi 서버의 도구를 쓴다." },
  },
});

let toolSearchCalls = 0;
for await (const message of result) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        if (block.name === "ToolSearch") toolSearchCalls++;
        console.log(`  도구 요청: ${block.name}(${JSON.stringify(block.input)})`);
      }
    }
  }
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}, $${message.total_cost_usd.toFixed(4)}`);
    if (message.subtype === "success") console.log("\n최종 답변:\n" + message.result);
  }
}

console.log(`\nENABLE_TOOL_SEARCH=${POLICY} → ToolSearch 호출 ${toolSearchCalls}회`);
const after = (await (await fetch(`${BASE}/inventory/SKU-7003`)).json()) as { stock: number };
console.log(`검증: SKU-7003 재고 ${after.stock} (시작은 340. 2개 주문이 실제로 반영됐으면 338)`);

api.stop();
