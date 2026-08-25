// [2단계] 도구를 "선언"만 하고 같은 질문하기
// 관찰 포인트 1: 모델이 도구를 실행하는 게 아니라, "실행해달라"는 요청 블록(tool_use)을 보낸다.
// 관찰 포인트 2: 경로가 명확해서 거의 매번 tool_use가 나온다 (실측 2026-08-17: 5회 연속).
//   같은 코드에서 행동이 실행마다 갈리는 확률적 성질은 2b단계에서 관찰한다.
//   (참고: 2026-08-15 실측에서는 이 요청도 tool_use와 end_turn이 갈렸다. 그날그날 다르다.)

import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic();

const res = await client.messages.create({
  model: MODEL, // .env의 ANTHROPIC_MODEL

  max_tokens: 1024,
  tools: [
    {
      name: "read_file", // 이름과 스키마뿐인 "명세서". 구현은 어디에도 없다
      description: "지정한 경로의 파일 내용을 텍스트로 읽어 반환한다.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "읽을 파일의 상대 경로" },
        },
        required: ["path"],
      },
    },
  ],
  messages: [
    {
      role: "user",
      content: "이 프로젝트의 src/index.ts 파일을 읽고 무슨 코드인지 요약해줘.",
    },
  ],
});

console.log(JSON.stringify(res, null, 2));
