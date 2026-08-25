// 파치마켓 MCP 서버(도구 셋)와 canUseTool 승인 콜백. 9~15단계(13 제외)가 공유한다. (14단계 실측: query() 여러 개가 같은 인스턴스를 동시에 쓰면 한쪽이 도구 목록을 못 받는다. 동시 실행엔 인스턴스를 따로 만들 것)
// Part 1의 tools 배열 한 칸과 같다. 이름, 설명, 스키마에 더해 실행 코드(핸들러)까지 한 자리에.

import { createSdkMcpServer, tool, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { server } from "./index"; // 파치마켓 API를 이 프로세스에서 띄운다 (:4173)

export const api = server;
export const BASE = `http://localhost:${api.port}`;

// 핸들러의 반환 형식: MCP의 CallToolResult. 텍스트 블록에 JSON을 담아 돌려준다.
const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

export const listProducts = tool("list_products", "파치마켓 상품 전체의 재고와 가격을 돌려준다.", {}, async () => {
  console.log("  [pachi] list_products()");
  return asText(await (await fetch(`${BASE}/products`)).json());
});

export const getInventory = tool(
  "get_inventory",
  "SKU로 재고와 가격을 조회한다.",
  { sku: z.string().describe("상품 코드. 예: SKU-7001") },
  async ({ sku }) => {
    console.log(`  [pachi] get_inventory(${sku})`);
    const res = await fetch(`${BASE}/inventory/${sku}`);
    return { ...asText(await res.json()), isError: !res.ok };
  },
);

export const createOrder = tool(
  "create_order",
  "상품을 주문해 재고를 차감한다. 되돌릴 수 없다.",
  { sku: z.string().describe("상품 코드. 예: SKU-7001"), qty: z.number().int().min(1).describe("수량") },
  async ({ sku, qty }) => {
    console.log(`  [pachi] create_order(${sku}, ${qty})`);
    const res = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku, qty }),
    });
    return { ...asText(await res.json()), isError: !res.ok };
  },
);

// 이 프로세스 안에서 도는 MCP 서버. 도구 이름은 mcp__pachi__<도구>가 된다.
// instructions: 서버 단위 안내문. 런타임은 MCP 도구의 스키마를 처음부터 싣지 않고 이름과 이 안내문만 모델에게 보여준 뒤,
// 모델이 ToolSearch로 찾을 때 스키마를 실어 준다(도구 검색, 기본 켜짐). 그래서 "언제 이 서버를 찾을지"가 여기 적힌다. 2KB에서 잘린다.
// 인스턴스 하나 = MCP 세션 한 벌이다. query() 여러 개가 같은 인스턴스를 동시에 쓰면 한쪽이 도구 목록을
// 못 받는다(15단계 관찰 포인트 5). 동시 실행이 필요하면 query()마다 makePachi()로 새로 만들어 넘긴다.
export const makePachi = () =>
  createSdkMcpServer({
    name: "pachi",
    instructions: "파치마켓 재고·주문 API. 상품 목록, 재고 조회, " +
      "주문이 필요할 때 이 서버의 도구를 찾아라.",
    tools: [listProducts, getInventory, createOrder],
  });
export const pachi = makePachi();

// canUseTool 승인 콜백 (7b의 canUseTool 그대로). 읽기는 통과, 주문은 되돌릴 수 없으니 한 번에 5개까지만.
// alsoAllow: 이 실습에서 추가로 허용할 도구 이름 (11단계의 Task 등)
export function makeGate(alsoAllow: string[] = []): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "mcp__pachi__list_products" || toolName === "mcp__pachi__get_inventory") {
      return { behavior: "allow", updatedInput: input }; // 읽기 도구
    }
    if (toolName === "mcp__pachi__create_order") {
      const { sku, qty } = input as { sku: string; qty: number };
      const ok = qty <= 5;
      console.log(`  canUseTool: create_order(${sku}, ${qty}) → ${ok ? "승인" : "거부 (5개 초과)"}`);
      if (ok) return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: "한 번에 5개까지입니다." };
    }
    if (alsoAllow.includes(toolName)) {
      console.log(`  canUseTool: ${toolName} → 승인`);
      return { behavior: "allow", updatedInput: input };
    }
    console.log(`  canUseTool: ${toolName} → 거부 (허용 목록 밖)`);
    return { behavior: "deny", message: `${toolName}은(는) 이 실습에서 사용할 수 없습니다.` };
  };
}
