// [4단계] 수동 왕복 1회: 요청서를 진짜로 실행하고 결과를 돌려준다
// 관찰 포인트 1: 도구 실행 코드는 특별할 게 없다. 그냥 파일을 읽는 평범한 백엔드 코드다.
// 관찰 포인트 2: tool_result는 role: "user" 메시지로 들어간다. 대화상 우리가 말할 차례다.
// 관찰 포인트 3: tool_use_id로 요청서와 결과를 짝짓는다.
// 관찰 포인트 4: 2차 응답에서 모델이 "실제 파일 내용"을 근거로 요약한다. 파치마켓이 나오는지 보라.
// 관찰 포인트 5: 2차 입력 토큰: 대화 전체 + 파일 내용이 통째로 다시 실려 간다.

import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic();

const SYSTEM =
  "너는 프로젝트 루트 디렉토리에서 실행 중인 코딩 어시스턴트다. 상대 경로는 프로젝트 루트 기준으로 해석된다.";

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "read_file",
    description: "지정한 경로의 파일 내용을 텍스트로 읽어 반환한다.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "읽을 파일의 상대 경로" } },
      required: ["path"],
    },
  },
];

// 대화 기록. 매 요청에 통째로 실려 간다.
const messages: Anthropic.Messages.MessageParam[] = [
  { role: "user", content: "이 프로젝트의 src/index.ts 파일을 읽고 무슨 코드인지 요약해줘." },
];

// ── 1차 호출: 모델이 실행 요청서(tool_use)를 보낸다 (3단계까지의 내용) ──
const first = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools,
  messages,
});

console.log(`1차 stop_reason: ${first.stop_reason} (입력 토큰 ${first.usage.input_tokens})`);

const toolUse = first.content.find((block) => block.type === "tool_use");
if (!toolUse || toolUse.type !== "tool_use") {
  console.log("모델이 도구를 요청하지 않았다. 다시 실행해보라.");
  process.exit(1);
}

console.log(`요청서: ${toolUse.name}(${JSON.stringify(toolUse.input)})  id: ${toolUse.id}`);

// ── 도구 실행: 여기가 "우리 백엔드의 몫" ──
// 모델이 준 인자는 사용자 입력이다. 검증 없이 실행하지 않는다.
const { path } = toolUse.input as { path: string };
const resolved = resolve(process.cwd(), path);
const allowed = resolved.startsWith(process.cwd() + "/"); // 프로젝트 밖 경로 거부
const fileText = allowed ? await Bun.file(resolved).text() : "";
console.log(allowed ? `실행: ${path} 읽음 (${fileText.length}자)` : `거부: ${path} (프로젝트 밖)`);

// ── 2차 호출: 대화에 ① 모델의 요청서 ② 우리의 실행 결과를 이어 붙여 다시 보낸다 ──
messages.push({ role: "assistant", content: first.content });
messages.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: toolUse.id, // 요청서의 id와 짝을 맞춘다
      content: allowed ? fileText : "허용되지 않은 경로입니다. 프로젝트 안의 상대 경로만 읽을 수 있습니다.",
      is_error: !allowed, // 거부해도 대화는 계속된다. 실패도 결과다.
    },
  ],
});

const second = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools,
  messages,
});

console.log(`\n2차 stop_reason: ${second.stop_reason} (입력 토큰 ${second.usage.input_tokens})`);
console.log("\n── 모델의 최종 답변 ──");
for (const block of second.content) {
  if (block.type === "text") console.log(block.text);
}
