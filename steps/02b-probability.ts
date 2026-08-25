// [2b단계] 같은 요청을 여러 번 보내 행동 분포를 관찰한다
// 2단계와 코드는 같고, 요청만 일부러 모호하게 바꿨다 (경로를 주지 않는다).
// 관찰 포인트 1: 같은 코드·같은 요청인데 stop_reason이 실행마다 갈린다.
// 관찰 포인트 2: 도구를 쓸 때도 추측한 경로가 갈린다 (README.md vs README).
// 관찰 포인트 3: 경로가 명확한 2단계는 거의 매번 tool_use다. 모호할수록 판단이 흔들린다.
// 실측(2026-08-17): 12회 중 tool_use 5회(README.md 4, README 1), end_turn 7회.

import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic();
const RUNS = 6;

const tally = new Map<string, number>();

for (let i = 1; i <= RUNS; i++) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [
      {
        name: "read_file",
        description: "지정한 경로의 파일 내용을 텍스트로 읽어 반환한다.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", description: "읽을 파일의 상대 경로" } },
          required: ["path"],
        },
      },
    ],
    // 2단계와 달리 경로를 정확히 주지 않는다. 모델은 추측하거나 되물어야 한다.
    messages: [{ role: "user", content: "README를 읽고 요약해줘." }],
  });

  const toolUse = res.content.find((block) => block.type === "tool_use");
  const detail =
    toolUse?.type === "tool_use" ? `read_file(${JSON.stringify(toolUse.input)})` : "도구 미사용";
  console.log(`${i}회: ${res.stop_reason}  → ${detail}`);
  tally.set(res.stop_reason ?? "?", (tally.get(res.stop_reason ?? "?") ?? 0) + 1);
}

console.log("\n분포:", Object.fromEntries(tally));
