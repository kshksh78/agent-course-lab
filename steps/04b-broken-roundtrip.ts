// [4b단계] 규칙 위반 실험: 요청서를 무시하면 어떻게 되나?
// 관찰 포인트 1: tool_use를 받고도 tool_result 없이 다음 질문만 보내면 API가 400을 던진다.
// 관찰 포인트 2: 에러 메시지를 읽어보라. "모든 tool_use에는 다음 메시지에서
//   tool_result가 짝지어져야 한다"는 왕복의 규칙을 API가 강제하고 있다.

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

const messages: Anthropic.Messages.MessageParam[] = [
  { role: "user", content: "이 프로젝트의 src/index.ts 파일을 읽고 무슨 코드인지 요약해줘." },
];

const first = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools,
  messages,
});

console.log(`1차 stop_reason: ${first.stop_reason} (요청서를 받았다)`);

// 요청서를 무시하고, tool_result 없이 그냥 다음 질문만 보낸다
messages.push({ role: "assistant", content: first.content });
messages.push({ role: "user", content: "됐고, 그냥 아무 얘기나 해줘." });

try {
  await client.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages });
  console.log("2차 성공? 규칙이 바뀌었는지 확인해보라.");
} catch (e) {
  if (e instanceof Anthropic.APIError) {
    console.log(`\n2차 실패. 상태 코드: ${e.status}`);
    console.log(`에러 메시지: ${e.message}`);
  } else {
    throw e;
  }
}
