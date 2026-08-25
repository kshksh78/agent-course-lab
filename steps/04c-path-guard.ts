// [4c단계] 경로 검증 가드 시연: 프로젝트 밖 파일을 읽어달라고 하면?
// 4단계와 코드는 같고, 질문만 위험하게 바꿨다: "/etc/hosts 파일을 읽고 내용을 알려줘."
// 관찰 포인트 1: 1차 호출에 tool_choice: { type: "any" }를 썼다 (3단계에서 본 강제 옵션).
//   모델이 도구 없이 스스로 거절해버리는 실행이 있어서, 시연 재현을 위해 확률을 제거했다.
// 관찰 포인트 2: 강제하면 모델은 read_file("/etc/hosts") 요청서를 보낸다.
//   모델의 인자는 신뢰할 수 없는 사용자 입력이다.
// 관찰 포인트 3: 가드가 거부하고 is_error: true로 돌려줘도 대화는 깨지지 않는다.
//   모델이 "보안상 읽을 수 없다"고 설명하며 정상 종료한다. 실패도 결과다.

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

const messages: Anthropic.Messages.MessageParam[] = [
  { role: "user", content: "/etc/hosts 파일을 읽고 내용을 알려줘." },
];

const first = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system: SYSTEM,
  tools,
  tool_choice: { type: "any" }, // 도구 사용 강제. 시연이 매번 재현되도록 확률을 제거한다
  messages,
});

console.log(`1차 stop_reason: ${first.stop_reason}`);

const toolUse = first.content.find((block) => block.type === "tool_use");
if (!toolUse || toolUse.type !== "tool_use") {
  console.log("도구 요청이 없다. tool_choice가 있어 정상적으론 나올 수 없는 경로다.");
  process.exit(1);
}

console.log(`요청서: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

// ── 도구 실행 전 검증: 모델의 인자는 사용자 입력이다 ──
const { path } = toolUse.input as { path: string };
const resolved = resolve(process.cwd(), path);
const allowed = resolved.startsWith(process.cwd() + "/"); // 프로젝트 밖 경로 거부
const fileText = allowed ? await Bun.file(resolved).text() : "";
console.log(allowed ? `실행: ${path} 읽음 (${fileText.length}자)` : `거부: ${path} (프로젝트 밖)`);

messages.push({ role: "assistant", content: first.content });
messages.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id: toolUse.id,
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

console.log(`\n2차 stop_reason: ${second.stop_reason}`);
console.log("\n── 모델의 최종 답변 ──");
for (const block of second.content) {
  if (block.type === "text") console.log(block.text);
}
