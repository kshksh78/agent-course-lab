// [9단계] 커스텀 도구: 우리 백엔드 API를 에이전트의 손발로
// 관찰 포인트 1: Part 1의 tools 배열(이름·설명·input_schema)과 같은 것을 SDK에서는 tool()로 선언한다.
//   차이는 선언과 실행 코드(핸들러)가 한 자리에 있다는 것. zod 스키마가 타입과 검증을 동시에 준다.
// 관찰 포인트 2: createSdkMcpServer는 별도 프로세스 없이 이 프로세스 안에서 도는 MCP 서버다.
//   프로덕션에서는 같은 도구를 stdio/HTTP MCP 서버로 떼어내 여러 에이전트가 공유할 수 있다.
// 관찰 포인트 3: 도구 이름은 mcp__<서버>__<도구>가 된다. MCP 도구는 기본적으로 승인 대상이라 전부
//   7b의 canUseTool을 지난다. 읽기 둘은 통과시키고 쓰기(create_order)는 조건부로 허용한다.
//   권한 모델이 우리 도구에도 그대로 적용된다. (읽기 도구를 allowedTools에 올리면 canUseTool을 건너뛴다.
//   SDK가 "canUseTool will not be invoked" 경고로 알려준다.)
// 관찰 포인트 4: 도구가 여럿이면 어떤 것을 어떤 순서로 부를지 모델이 정한다. 목록 → 주문 순서를
//   우리가 짜지 않았다. 끝나면 서버 상태(재고)를 직접 확인한다. 모델의 보고를 믿지 않는다.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";
import { api, BASE, makeGate, pachi } from "../src/pachi-mcp"; // 도구 셋·canUseTool은 src/pachi-mcp.ts에

const result = query({
  prompt:
    "재고가 있는 상품 중 가장 싼 상품 하나를 골라 수량 2개로 주문해줘. 주문 뒤 그 상품의 남은 재고를 다시 조회해서 알려주고, 품절 상품도 알려줘.",
  options: {
    model: MODEL,
    mcpServers: { pachi },
    canUseTool: makeGate(), // pachi 도구는 전부 canUseTool을 지난다. 읽기는 통과, 쓰기는 조건부
    maxTurns: 8,
    settingSources: [],
    strictMcpConfig: true, // 격리 모드. pachi는 옵션으로 넘겼으니 그대로 쓰인다
  },
});

for await (const message of result) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`  도구 요청: ${block.name}(${JSON.stringify(block.input)})`);
    }
  }
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}, $${message.total_cost_usd.toFixed(4)}`);
    if (message.subtype === "success") console.log("\n최종 답변:\n" + message.result);
  }
}

// 모델의 보고를 믿지 않는다. 서버 상태를 직접 확인한다.
const after = (await (await fetch(`${BASE}/inventory/SKU-7003`)).json()) as { stock: number };
console.log(`\n검증: SKU-7003 재고 ${after.stock} (시작은 340. 2개 주문이 실제로 반영됐으면 338)`);

api.stop(); // API 서버를 내려야 프로세스가 끝난다
