// [3단계] 환경 컨텍스트 주입: system 프롬프트로 작업 디렉토리를 알려주기
// 2단계에서 모델이 "경로 기준이 어디냐"며 도구를 안 쓰기도 했다.
// 모델은 자기가 어느 디렉토리에서 실행되는지 전혀 모르기 때문이다.
// 환경 정보를 system 프롬프트로 주입하면 행동이 안정된다.
// 참고: Claude Code의 시스템 프롬프트에 "Primary working directory: ..."가 들어있는 이유.
// 100% 강제가 필요하면 tool_choice: { type: "any" } 파라미터도 있다.

import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic();

const res = await client.messages.create({
  model: MODEL, // .env의 ANTHROPIC_MODEL

  max_tokens: 1024,
  system:
    "너는 프로젝트 루트 디렉토리에서 실행 중인 코딩 어시스턴트다. 상대 경로는 프로젝트 루트 기준으로 해석된다.",
  tools: [
    {
      name: "read_file",
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
