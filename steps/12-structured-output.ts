// [12단계] structured output: 에이전트의 답을 코드가 쓸 수 있는 JSON으로 받는다
// 관찰 포인트 1: 11단계까지 result.result는 자유 텍스트였다. 코드가 쓰려면 파싱해야 하고 실행마다 문장이
//   바뀐다. outputFormat에 JSON Schema를 주면 SDK가 루프의 마지막 답을 스키마로 검증해 result.structured_output에
//   싣는다. 11단계 options에서 달라진 건 outputFormat 한 줄과 결과를 읽는 자리뿐이다.
// 관찰 포인트 2: 도구 호출과 서브에이전트 위임은 그대로 돈다. 스키마는 루프의 "마지막 답"에만 걸린다.
//   실측(2026-08-23): Agent(auditor) → Read 뒤에 StructuredOutput 도구 호출이 하나 더 찍힌다. SDK는 우리 스키마를
//   입력으로 갖는 도구를 끼워 넣고 마지막 답을 그 입력으로 받는다. Part 1 tools 배열의 input_schema가 출력
//   스키마로 쓰이는 셈이다. canUseTool에는 오지 않는다(자동 승인). 턴 4, $0.1180.
// 관찰 포인트 3: SDK 층은 "검증 + 재프롬프트"다. 스키마에 안 맞으면 다시 시키고, 한도를 넘으면
//   error_max_structured_output_retries로 끝난다. Part 1의 Messages API 층(output_config.format)은
//   constrained decoding이라 디코딩 단계에서 스키마 밖 토큰이 아예 안 나온다. 같은 이름, 다른 보장.
// 관찰 포인트 4: success인데 structured_output이 비어 있을 수 있다. 그것도 실패로 다룬다. zod safeParse로
//   한 번 더 검증해 타입이 붙은 값으로 만든다. 그 뒤는 그냥 코드다. 품절만 골라 담당자에게 알리는 식.
// 관찰 포인트 5: SDK 검증기는 JSON Schema draft-07이다. zod 4의 toJSONSchema 기본은 2020-12라
//   target: "draft-7"을 준다. 재귀 스키마, minimum/maxLength 같은 수치 제약은 지원하지 않는다.

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MODEL } from "../src/config";
import { api, makeGate, pachi } from "../src/pachi-mcp";

// 코드가 받고 싶은 모양. 타입과 검증을 동시에 얻는다 (9단계의 도구 입력 스키마와 같은 zod, 방향만 반대)
const Report = z.object({
  alerts: z.array(
    z.object({
      sku: z.string().describe("상품 코드. 예: SKU-7002"),
      name: z.string().describe("상품명"),
      stock: z.number().int().describe("현재 재고 수량"),
      status: z.enum(["soldout", "low"]).describe("soldout: 재고 0, low: 20개 미만"),
    }),
  ),
  summary: z.string().describe("한 문장 요약"),
});
type Report = z.infer<typeof Report>;

const target = `${process.cwd()}/src/index.ts`;

const result = query({
  prompt: `auditor 에이전트에게 ${target}의 재고표 점검을 맡기고, 그 보고를 받아 주의가 필요한 상품만 정리해줘. 직접 읽지 말고 반드시 auditor에게 맡겨.`,
  options: {
    model: MODEL,
    agents: {
      auditor: {
        description: "재고표를 읽고 품절·부족 상품을 보고하는 감사 담당",
        prompt: "너는 파치마켓 감사 담당이다. 재고표를 읽고 품절 상품과 재고 20개 미만 상품을 SKU, 상품명, 재고 수량과 함께 보고하라.",
        tools: ["Read"],
      },
    },
    outputFormat: { type: "json_schema", schema: z.toJSONSchema(Report, { target: "draft-7" }) }, // 11단계와 다른 한 줄
    mcpServers: { pachi },
    canUseTool: makeGate(["Agent", "Task"]),
    maxTurns: 10,
    settingSources: [],
    strictMcpConfig: true,
  },
});

let last: SDKResultMessage | undefined;
try {
  for await (const message of result) {
    if (message.type === "assistant") {
      const who = message.parent_tool_use_id ? "    └ [auditor]" : "  [main]";
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          const input = block.input as { subagent_type?: string; description?: string };
          const detail = block.name === "Agent" || block.name === "Task" ? `subagent_type=${input.subagent_type}, "${input.description}"` : JSON.stringify(block.input).slice(0, 80);
          console.log(`${who} 도구 요청: ${block.name}(${detail})`);
        }
      }
    }
    if (message.type === "result") last = message; // 마지막 result를 읽는다 (11단계)
  }
} catch (error) {
  console.log(`\n예외로 종료: ${error}`); // error_max_structured_output_retries 등 error 계열 result는 예외로 끝난다
}

if (last) console.log(`\n종료: ${last.subtype}, 턴 ${last.num_turns}, $${last.total_cost_usd.toFixed(4)}`);

// success여도 structured_output이 비어 있을 수 있다. 둘 다 확인한다.
if (!last || last.subtype !== "success" || last.structured_output === undefined) {
  console.log("구조화된 답이 없다. 실패로 다룬다.");
} else {
  const parsed = Report.safeParse(last.structured_output); // SDK가 검증했지만 우리 타입으로 한 번 더
  if (!parsed.success) {
    console.log("스키마 불일치:", parsed.error.issues);
  } else {
    const report: Report = parsed.data;
    console.log("\nstructured_output:\n" + JSON.stringify(report, null, 2));
    // 여기부터는 그냥 코드다. 모델 문장을 파싱할 일이 없다.
    const soldout = report.alerts.filter((a) => a.status === "soldout").map((a) => a.sku);
    console.log(`\n코드가 바로 쓴다: 품절 ${soldout.length}건 [${soldout.join(", ")}] → 담당자 알림, 재발주 큐`);
  }
}

api.stop();
