// [15b단계] LLM-as-a-Judge: 서술형 답은 모델이 판정한다
// 관찰 포인트 1: 15단계의 exact match는 "0", "SKU-7002"처럼 답이 하나로 정해질 때만 쓸 수 있다.
//   "재고 상황을 보고해줘" 같은 서술형은 정답 문자열이 없다. 판정 기준(rubric)을 주고 판정 자체를 모델에 맡긴다.
// 관찰 포인트 2: 구조는 15단계 그대로다. dataset → task → evaluator. evaluator 자리의 코드 판정이
//   모델 호출로 바뀔 뿐이다. 기대 요점(expectedOutput)을 judge에게 같이 주는 reference 기반 판정이라
//   "모델 마음대로 채점"이 아니라 "사람이 확정한 요점과 대조"다.
// 관찰 포인트 3: judge를 믿을 수 있게 만드는 장치 셋 — ① pass 조건을 rubric으로 명시 ② temperature 0
//   ③ structured output(output_config)으로 pass/reason 스키마를 강제. 12단계의 outputFormat이 Agent SDK 층이었다면
//   이건 같은 개념의 Messages API 층이다. reason은 score comment로 남아 Langfuse에서 판정 근거를 감사한다.
// 관찰 포인트 4: 판정 한 건도 모델 호출이다(Langfuse 문서 기준 건당 $0.01~0.10). 실무에선 judge 모델을 따로
//   고르고(정확도가 필요하면 상위 모델), 프로덕션에선 샘플링으로 평가량을 조절한다.
// 관찰 포인트 5: judge도 평가 대상이다. 믿기 전에 사람이 판정한 소수 케이스와 비교(calibration)하라.
//   잘 설계된 rubric이면 사람 판정과 80~90% 일치한다는 게 Langfuse 문서의 수치다.
// 관찰 포인트 6(실측 2026-08-25): 서술형 3케이스 judge_pass 3/3, 판정 근거가 score comment로 남았다.
//   프롬프트로 "JSON만" 지시하던 초기 버전은 ```json 펜스가 섞여 정규식 추출이 필요했는데,
//   output_config로 스키마를 강제한 뒤로는 순수 JSON만 와서 그 방어 코드가 필요 없다.
// 관찰 포인트 7(실측 2026-08-25, policy 변형): "내부 수치 비노출" CS 정책 한 줄을 프롬프트에 넣었더니
//   처음엔 judge가 "품절 상태입니다"를 핵심 충족으로 보고 3/3을 줬다 — 평가는 rubric에 적힌 것만 잡는다.
//   보고 기준(수치 필수)을 rubric에 명시하자 policy 0/3, baseline 3/3으로 갈렸다. 도구도 데이터도 정상인데
//   프롬프트 한 줄(두 요구사항의 충돌)이 만든 품질 회귀를 평가가 드러낸 것이다.
// 준비물: .env에 LANGFUSE_* 키 (15단계와 동일)

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseClient } from "@langfuse/client";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODEL } from "../src/config";
import { api, makeGate, pachi } from "../src/pachi-mcp";

const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
provider.register();
const langfuse = new LangfuseClient();
const anthropic = new Anthropic();

// ── 데이터셋: 서술형 질문 + 사람이 확정한 기대 요점(정답 문자열이 아니라 판정 기준점) ──
const DATASET = "pachi-inventory-report";
// 변형은 "일부러 고장 낸 에이전트"가 아니라, 팀이 실제로 할 법한 변경이 품질을 깨는 시나리오다.
// policy: CS 정책 변경 한 줄 — "내부 수치는 노출하지 말라". 도구도 데이터도 정상인데
//   답에서 수치가 빠져 기대 요점에 미달한다 → judge가 "누락" fail을 준다. 프롬프트 변경이 만든 품질 회귀다.
const VARIANT = Bun.env.JUDGE_VARIANT ?? "baseline"; // baseline | policy
const POLICY_PROMPT =
  "너는 파치마켓 재고 담당이다. pachi 도구로 재고를 확인하되, 재고 수량 같은 내부 수치는 " +
  "고객에게 노출하지 말고 가능/불가·충분/부족 같은 상태 표현으로만 두 문장 이내로 답하라.";
const CASES = [
  {
    id: "r-1",
    input: "SKU-7002의 재고 상황을 한 문장으로 보고해줘.",
    expectedOutput: "민트 파치 키링은 재고 0개로 완전 품절 상태다",
  },
  {
    id: "r-2",
    input: "재고가 20개 미만인 상품을 찾아 각각 조치를 제안해줘.",
    expectedOutput: "SKU-7001 초코 파치 인형은 12개라 재입고 필요, SKU-7002 민트 파치 키링은 0개 품절이라 긴급 재입고 필요",
  },
  {
    id: "r-3",
    input: "SKU-7003으로 300개 대량 주문이 들어오면 대응 가능한지 근거와 함께 답해줘. 주문은 하지 마.",
    expectedOutput: "재고가 340개라 300개 주문에 대응 가능하다",
  },
];
await langfuse.api.datasets.create({ name: DATASET, description: "파치마켓 재고 서술형 보고. 기대 요점은 src/index.ts 기준" });
for (const c of CASES) {
  await langfuse.dataset.createItem({ datasetName: DATASET, ...c });
}

// ── task: 15단계와 같은 에이전트. 단 서술형이라 structured output 없이 문장 그대로 받는다 ──
async function askAgent(prompt: string): Promise<string> {
  let last: SDKResultMessage | undefined;
  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt:
        VARIANT === "policy"
          ? POLICY_PROMPT
          : "너는 파치마켓 재고 담당이다. pachi 도구로 재고를 확인하고, 구체 수량을 포함해 두 문장 이내로 답하라.",
      mcpServers: { pachi },
      disallowedTools: ["mcp__pachi__create_order"],
      canUseTool: makeGate(),
      maxTurns: 6,
      settingSources: [],
      strictMcpConfig: true,
    },
  })) {
    if (message.type === "result") last = message;
  }
  return last?.subtype === "success" ? last.result : "(실패)";
}
const task = async ({ input }: { input?: unknown }) => askAgent(String(input));

// ── evaluator: LLM-as-a-Judge. rubric + 기대 요점을 주고 pass/reason을 JSON으로만 받는다 ──
const Verdict = z.object({ pass: z.boolean(), reason: z.string() });

const judge = async ({ input, output, expectedOutput }: { input?: unknown; output?: unknown; expectedOutput?: unknown }) => {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    temperature: 0, // 같은 답엔 같은 판정이 나오게. 주의: Opus 4.6 이후 출시 모델은 설정 미지원(1.0 외 400) — Haiku 4.5는 지원
    // 12단계의 outputFormat(Agent SDK)과 같은 개념의 Messages API 층. 스키마가 강제되니 펜스·잡담이 섞일 수 없다
    output_config: { format: { type: "json_schema", schema: z.toJSONSchema(Verdict, { target: "draft-7" }) } },
    system: "너는 채점자다. 판정 기준에 따라 평가하라.",
    messages: [
      {
        role: "user",
        content: [
          `[질문] ${input}`,
          `[에이전트 답] ${output}`,
          `[기대 요점] ${expectedOutput}`,
          "[판정 기준] 에이전트 답이 기대 요점의 사실(수치·상태·SKU)과 모순되지 않고 핵심을 담으면 pass.",
          "수치가 틀리거나, 기대 요점의 항목이 빠졌거나, 없는 사실을 지어냈으면 fail.",
          "재고 보고에는 기대 요점의 구체 수치(재고 수량)가 포함되어야 한다. 수치 없이 상태 표현만 있으면 fail.",
        ].join("\n"),
      },
    ],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = Verdict.safeParse(JSON.parse(text)); // 스키마 강제 덕에 정규식 추출이 필요 없다
  if (!parsed.success) return { name: "judge_pass", value: 0, comment: `judge 응답 파싱 실패: ${text.slice(0, 80)}` };
  return { name: "judge_pass", value: +parsed.data.pass, comment: parsed.data.reason };
};

const passRate = async ({ itemResults }: { itemResults: { evaluations: { name: string; value: unknown }[] }[] }) => {
  const hits = itemResults.filter((r) => r.evaluations.some((e) => e.name === "judge_pass" && e.value === 1)).length;
  return { name: "judge_pass_rate", value: hits / itemResults.length, comment: `${hits}/${itemResults.length}` };
};

// ── 실행: 15단계와 같은 dataset run. 점수 이름만 judge_pass로 바뀐다 ──
const dataset = await langfuse.dataset.get(DATASET);
const result = await dataset.runExperiment({
  name: "재고 보고 평가 (LLM judge)",
  runName: `judge-${VARIANT}-${new Date().toISOString().slice(0, 16)}`,
  description:
    VARIANT === "policy"
      ? "CS 정책 변경(내부 수치 비노출): 프롬프트 한 줄이 만든 품질 회귀를 judge가 잡는지 확인"
      : "서술형 답을 reference 기반 LLM judge로 판정",
  task,
  evaluators: [judge],
  runEvaluators: [passRate],
  maxConcurrency: 1, // 15단계 관찰 포인트 5: in-process pachi 공유 문제 회피
});

console.log(await result.format({ includeItemResults: true }));
if (result.datasetRunUrl) console.log(`Langfuse dataset run: ${result.datasetRunUrl}`);

await langfuse.flush();
await provider.shutdown();
api.stop();
