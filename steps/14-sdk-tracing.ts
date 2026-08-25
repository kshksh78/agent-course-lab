// [14단계] SDK 에이전트 관측: query() 하나를 Langfuse 트레이스로
// 관찰 포인트 1: Part 1(13단계)에선 모델 호출마다 generation을 우리가 찍었다. SDK에선 루프가 서브프로세스 안이라
//   API 왕복 하나하나가 우리 코드에 안 보인다. 보이는 단위는 query 하나(AGENT)와 도구 호출(TOOL)이다.
//   추상화가 올라가면 관측 단위도 올라간다. 왕복을 세려면 6단계처럼 assistant 메시지의 message.id를 센다.
// 관찰 포인트 2: OpenInference 계측기가 query()를 감싸 AGENT span을 만들고, 훅(PreToolUse/PostToolUse)을 주입해
//   도구 호출마다 TOOL span을 단다. 10단계의 훅이 관측 도구로 재사용되는 셈이다. 에이전트 코드는 11단계 그대로다.
//   실측(2026-08-23): 12단계처럼 outputFormat을 같이 주면 StructuredOutput 도구 호출이 세 번 실패하고 structured_output이
//   비어 온다(permission_denials 0건, canUseTool 거부 0건인데 모델은 "호출이 거부되고 있다"고 답함). 계측기가 주입한 훅과
//   SDK의 StructuredOutput 처리가 충돌하는 것으로 보이며 원인은 미확인. 그래서 이 실습은 outputFormat 없이 11단계 구조로 간다.
// 관찰 포인트 3: 토큰·비용은 result에서 읽어 AGENT span 속성으로 올라간다. total_cost_usd는 SDK에 번들된 가격표로
//   계산한 클라이언트 추정치다. 과금 근거로 쓰지 않는다(정확한 값은 Usage and Cost API).
//   usage는 메인 루프만 세고, total_cost_usd와 modelUsage는 서브에이전트(auditor)까지 포함한다.
// 관찰 포인트 4: 세션·유저 단위 관측은 우리가 붙인다. propagateAttributes로 userId·sessionId·tags를 트레이스에
//   실으면 Langfuse가 유저별·세션별로 비용을 집계한다. query()마다 result가 독립이라 합산도 우리 몫이다.
// 관찰 포인트 5: 계측기 span 이름은 규약 고정(ClaudeAgent.query)이고 트레이스 이름을 채우지 않는다.
//   startActiveObservation으로 지붕 span을 씌우면 트레이스 이름이 우리 것이 되고 계측기 span은 그 아래로 들어간다.
//   실측(2026-08-25): 지붕 없으면 trace name이 빈 값, 지붕 있으면 root SPAN 아래 AGENT(ClaudeAgent.query)가 중첩된다.
// 준비물: .env에 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL (13단계와 동일)

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { ClaudeAgentSDKInstrumentation } from "@arizeai/openinference-instrumentation-claude-agent-sdk";
import * as ClaudeAgentSDK from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";
import { api, makeGate, pachi } from "../src/pachi-mcp";

// ── 계측 셋업: 13단계의 Langfuse 프로바이더 + SDK 계측기 ──
// 실측(2026-08-23): LangfuseSpanProcessor의 기본 필터는 자기 tracer·gen_ai.* 속성·알려진 LLM 계측기의 span만 내보낸다.
// OpenInference의 Claude Agent SDK 계측기는 그 목록에 없어 AGENT span이 조용히 버려졌다(debug 로그: "Dropped span due to
// shouldExportSpan filter"). shouldExportSpan으로 전부 내보내게 연다.
// 실무 팁: () => true는 우리 span밖에 없는 실습용이다. OTel 계측이 깔린 실제 앱에서는 인프라 span까지 다 쏘게 되므로
//   scope로 좁게 연다: ({ otelSpan }) => otelSpan.instrumentationScope.name.includes("claude-agent-sdk")
//   부모만 거르면 자식 span이 고아가 되어 트리가 깨지니, 부분 필터는 계층 단위로 열고 닫을 것.
const provider = new NodeTracerProvider({
  spanProcessors: [new LangfuseSpanProcessor({ shouldExportSpan: () => true })],
});
provider.register();
const instrumentation = new ClaudeAgentSDKInstrumentation({ tracerProvider: provider });
const { query } = instrumentation.manuallyInstrument(ClaudeAgentSDK); // query()를 감싼 버전. 이후 코드는 11단계와 같다

// ── 11단계 그대로: auditor 위임 ──
const target = `${process.cwd()}/src/index.ts`;
const PROMPT = `auditor 에이전트에게 ${target}의 재고표 점검을 맡기고, 그 보고를 받아 주의가 필요한 상품만 정리해줘. 직접 읽지 말고 반드시 auditor에게 맡겨.`;

const run = async () => {
  let last: SDKResultMessage | undefined;
  for await (const message of query({
    prompt: PROMPT,
    options: {
      model: MODEL,
      agents: {
        auditor: {
          description: "재고표를 읽고 품절·부족 상품을 보고하는 감사 담당",
          prompt: "너는 파치마켓 감사 담당이다. 재고표를 읽고 품절 상품과 재고 20개 미만 상품을 한 문단으로 보고하라.",
          tools: ["Read"],
        },
      },
      mcpServers: { pachi },
      canUseTool: makeGate(["Agent", "Task"]),
      maxTurns: 10,
      settingSources: [],
      strictMcpConfig: true,
    },
  })) {
    if (message.type === "assistant") {
      const who = message.parent_tool_use_id ? "    └ [auditor]" : "  [main]";
      for (const block of message.message.content) {
        if (block.type === "tool_use") console.log(`${who} 도구 요청: ${block.name}`);
      }
    }
    if (message.type === "result") last = message;
  }
  return last;
};

// 지붕 span을 씌워 트레이스 이름을 짓고(계측기의 ClaudeAgent.query는 그 아래로 들어간다),
// propagateAttributes로 콜백 안에서 만들어진 span 전부에 유저·세션·태그를 전파한다.
// 트레이스 목록의 Input/Output 칼럼은 지붕 span의 input/output에서 오므로 13단계처럼 직접 싣는다.
const last = await startActiveObservation("inventory-audit", async (roof) => {
  roof.update({ input: PROMPT });
  const result = await propagateAttributes(
    { userId: "manager-kim", sessionId: "shift-2026-08-23", tags: ["lab14", "inventory-audit"] },
    run,
  );
  roof.update({ output: result?.subtype === "success" ? result.result : result?.subtype });
  return result;
});

if (last) {
  console.log(`\n종료: ${last.subtype}, 턴 ${last.num_turns}, 거부 기록 ${last.permission_denials.length}건 ${JSON.stringify(last.permission_denials.map((d) => d.tool_name))}`);
  if (last.subtype === "success") console.log(`최종 답변: ${last.result.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(`total_cost_usd: $${last.total_cost_usd.toFixed(4)}  (추정치. 서브에이전트 포함)`);
  console.log(`usage(메인 루프만): 입력 ${last.usage.input_tokens} · 출력 ${last.usage.output_tokens} · 캐시 읽기 ${last.usage.cache_read_input_tokens ?? 0} · 캐시 생성 ${last.usage.cache_creation_input_tokens ?? 0}`);
  for (const [model, u] of Object.entries(last.modelUsage)) {
    console.log(`modelUsage ${model}: $${u.costUSD.toFixed(4)} · 입력 ${u.inputTokens} · 출력 ${u.outputTokens} · 캐시 읽기 ${u.cacheReadInputTokens} · 캐시 생성 ${u.cacheCreationInputTokens}`);
  }
}

await provider.shutdown(); // 남은 span을 Langfuse로 flush
api.stop();
console.log("\nLangfuse › Traces에서 user manager-kim, session shift-2026-08-23 트레이스를 확인하라.");
