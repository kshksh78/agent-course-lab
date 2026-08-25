// [1단계] 도구 없이 파일에 대해 물어보기
// 관찰 포인트: 모델이 파일을 읽을 수 있나? 없다면 뭐라고 반응하나? (거절? 날조?)

import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic(); // ANTHROPIC_API_KEY를 환경변수(.env)에서 읽는다

const res = await client.messages.create({
  model: MODEL, // .env의 ANTHROPIC_MODEL

  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: "이 프로젝트의 src/index.ts 파일을 읽고 무슨 코드인지 요약해줘.",
    },
  ],
});

// 응답 원문 전체를 그대로 본다. content 블록 구조, stop_reason, 토큰 사용량까지
console.log(JSON.stringify(res, null, 2));
