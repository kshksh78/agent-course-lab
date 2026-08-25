// [15단계] 평가: 검증을 반복 가능하게. 케이스 N개를 돌려 통과율을 본다
// 관찰 포인트 1: 한 번 맞은 답이 계속 맞는다는 보장은 없다(2b단계 확률). 프롬프트·모델·옵션을 바꾸면 더 그렇다.
//   Part 3 검증(상태 대조, 출력 대조)을 한 번 수동으로 하는 대신, 입력과 기대값을 데이터셋으로 두고 자동으로 돌린다.
// 관찰 포인트 2: 구조는 셋. dataset(입력 + 기대값) → task(에이전트 실행) → evaluator(판정 = score).
//   Langfuse가 실행마다 dataset run을 만들어 두니, 프롬프트를 바꾼 뒤 run끼리 비교하면 회귀가 보인다.
// 관찰 포인트 3: 판정은 결정적으로 둔다. 정규화한 문자열 일치. 12단계 structured output으로 answer 필드만 받으니
//   모델 문장을 파싱할 일이 없다. 비용도 score로 같이 남겨 "맞는데 비싼" 변경을 잡는다.
// 관찰 포인트 4: 평가 중엔 쓰기 도구를 막는다. disallowedTools로 create_order를 빼면 모델이 시도해도 도구가 없다.
//   "주문하지 말고 계산만" 케이스가 그걸 시험한다.
// 관찰 포인트 5(실측 2026-08-23, run 세 번): maxConcurrency 2로 돌린 baseline은 3/5. 틀린 둘은 "pachi 도구에 접근할 수
//   없어"라고 답했다. 도구 검색(9b단계) 탓인가 해서 EVAL_VARIANT=toolsearch-off(ENABLE_TOOL_SEARCH=false)로 다시 돌렸더니
//   똑같이 3/5. 가설 기각. EVAL_CONCURRENCY=1로 돌리자 5/5, 평균 비용도 $0.039 → $0.019. 원인은 query() 둘이 같은
//   in-process MCP 서버 객체(pachi)를 동시에 쓰면서 한쪽이 도구 목록을 못 받은 것. 모델이 아니라 우리 인프라였다.
//   한 번 돌려선 안 보이는 실패를 평가가 잡았고, 틀린 답이 맞은 답보다 쌌다. 비용만 보면 속는다.
//   기본값은 1이다. EVAL_CONCURRENCY=2로 돌리면 실패를 재현할 수 있다(실행마다 2~3/5로 흔들림 — 2026-08-25 재확인).
//   해결 실측(2026-08-25): EVAL_VARIANT=isolated EVAL_CONCURRENCY=2 → 5/5. query()마다 makePachi()로
//   새 인스턴스를 넘기면 MCP 세션이 분리돼 동시 2에서도 전부 통과한다. 가설이 실측으로 확정됐다.
//   실습 시나리오: ① bun run steps/15-evals.ts (5/5) → ② EVAL_CONCURRENCY=2 (실패 재현) →
//   ③ EVAL_VARIANT=isolated EVAL_CONCURRENCY=2 (해결 확인)
// 준비물: .env에 LANGFUSE_* 키 (13·14단계와 동일)

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MODEL } from "../src/config";
import { api, makeGate, makePachi, pachi } from "../src/pachi-mcp";

// ── Langfuse: 트레이스(OTel) + 데이터셋·스코어(API 클라이언트) ──
const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
provider.register();
const langfuse = new LangfuseClient();

// ── 데이터셋: 입력 + 기대값. 기대값은 src/index.ts 재고표에서 사람이 확정한 ground truth ──
const DATASET = "pachi-inventory-qa";
const VARIANT = Bun.env.EVAL_VARIANT ?? "baseline"; // baseline | toolsearch-off | isolated
const CONCURRENCY = Number(Bun.env.EVAL_CONCURRENCY ?? 1); // 동시에 돌릴 query() 수. 2면 pachi 공유로 실패 재현(관찰 포인트 5)
const CASES = [
  { id: "qa-1", input: "SKU-7002의 현재 재고 수량은? 숫자만 답해.", expectedOutput: "0" },
  { id: "qa-2", input: "품절인 상품의 SKU는? SKU만 답해.", expectedOutput: "SKU-7002" },
  { id: "qa-3", input: "재고가 20개 미만인 상품은 몇 개인가? 숫자만 답해.", expectedOutput: "2" },
  { id: "qa-4", input: "가장 비싼 상품의 이름은? 이름만 답해.", expectedOutput: "초코 파치 인형" },
  { id: "qa-5", input: "SKU-7003을 5개 주문하면 남는 재고는? 주문하지 말고 계산만. 숫자만 답해.", expectedOutput: "335" },
];
await langfuse.api.datasets.create({ name: DATASET, description: "파치마켓 재고 QA. 기대값은 src/index.ts 기준" });
for (const c of CASES) {
  await langfuse.dataset.createItem({ datasetName: DATASET, ...c }); // id가 같으면 덮어쓴다
}

// ── task: 케이스 하나 = query() 하나. 답은 structured output으로 answer 필드만 ──
const Answer = z.object({ answer: z.string().describe("질문에 대한 답. 단위·설명 없이 값만") });
const costByInput = new Map<string, number>(); // evaluator에게 비용을 넘기기 위한 사이드 채널

async function askAgent(prompt: string): Promise<string> {
  let last: SDKResultMessage | undefined;
  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: "너는 파치마켓 재고 담당이다. pachi 도구로 재고를 확인하고 답하라.",
      // isolated: query()마다 새 서버 인스턴스 = MCP 세션 분리. 동시 실행 실패(관찰 포인트 5)의 해법
      mcpServers: { pachi: VARIANT === "isolated" ? makePachi() : pachi },
      disallowedTools: ["mcp__pachi__create_order"], // 평가 중엔 쓰기 금지. 도구 목록에서 아예 빠진다
      canUseTool: makeGate(),
      outputFormat: { type: "json_schema", schema: z.toJSONSchema(Answer, { target: "draft-7" }) },
      maxTurns: 6,
      settingSources: [],
      strictMcpConfig: true,
      // 변형: 도구 검색을 끄면 MCP 스키마가 처음부터 실린다(9b단계). 같은 데이터셋으로 run을 하나 더 만든다
      env: VARIANT === "toolsearch-off" ? { ...process.env, ENABLE_TOOL_SEARCH: "false" } : process.env,
    },
  })) {
    if (message.type === "result") last = message;
  }
  if (last) costByInput.set(prompt, last.total_cost_usd);
  const parsed = Answer.safeParse(last?.subtype === "success" ? last.structured_output : undefined);
  return parsed.success ? parsed.data.answer : "(구조화된 답 없음)";
}
const task = async ({ input }: { input?: unknown }) => askAgent(String(input));

// ── evaluator: 결정적 판정. 정규화 후 일치 ──
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\s,]/g, "").replace(/개$/, "");
const exact = async ({ output, expectedOutput }: { output?: unknown; expectedOutput?: unknown }) => ({
  name: "exact",
  value: +(norm(output) === norm(expectedOutput)),
  comment: `답 "${output}" / 기대 "${expectedOutput}"`,
});
const cost = async ({ input }: { input?: unknown }) => ({
  name: "cost_usd",
  value: costByInput.get(String(input)) ?? 0,
  comment: "result.total_cost_usd (추정치)",
});
const passRate = async ({ itemResults }: { itemResults: { evaluations: { name: string; value: unknown }[] }[] }) => {
  const hits = itemResults.filter((r) => r.evaluations.some((e) => e.name === "exact" && e.value === 1)).length;
  return { name: "pass_rate", value: hits / itemResults.length, comment: `${hits}/${itemResults.length}` };
};

// ── 실행: dataset run 하나가 생긴다. 프롬프트를 바꾸고 다시 돌리면 run끼리 비교할 수 있다 ──
const dataset = await langfuse.dataset.get(DATASET);
const result = await dataset.runExperiment({
  name: "재고 QA 평가",
  runName: `${VARIANT}-c${CONCURRENCY}-${new Date().toISOString().slice(0, 16)}`,
  description:
    VARIANT === "toolsearch-off" ? "ENABLE_TOOL_SEARCH=false, create_order 차단"
    : VARIANT === "isolated" ? "query()마다 새 pachi 인스턴스, create_order 차단"
    : "system prompt v1, create_order 차단",
  task,
  evaluators: [exact, cost],
  runEvaluators: [passRate],
  maxConcurrency: CONCURRENCY,
});

console.log(await result.format({ includeItemResults: true }));
if (result.datasetRunUrl) console.log(`Langfuse dataset run: ${result.datasetRunUrl}`);

await langfuse.flush();
await provider.shutdown();
api.stop();
