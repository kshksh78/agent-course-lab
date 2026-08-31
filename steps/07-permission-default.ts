// [7단계] 권한 실험: 기본 모드에서 누가 승인하고 누가 거부하는가?
// 관찰 포인트 1: SDK 세션의 permissionMode 기본값은 'default'다. 공식 문서 기준으로
//   "claude -p와 Agent SDK"의 시작 모드는 default. CLI 대화 세션(Pro·Max·Team)의 기본이
//   auto(분류기가 사람 대신 검토)인 것과 다르다.
// 관찰 포인트 2: default 모드에서 읽기는 자유. Bash는 승인 대상이지만, 내장 "읽기 전용
//   명령 목록"(pwd, ls 등)은 자동 실행된다. 6단계에서 Bash가 돌았던 이유가 이것이다.
// 관찰 포인트 3: 쓰기(Write)는 승인이 필요한데, 승인자(canUseTool 콜백)가 없으면 자동
//   거부된다. result의 permission_denials에 기록이 남고, hello.txt는 만들어지지 않는다.
// 관찰 포인트 4(중요): 거부됐는데도 "만들었습니다"라고 답하는 경우가 생길 수 있다(할루시네이션,
//   2026-08-17 실측). 최종 답변을 믿지 말고 파일 존재는 우리가 확인한다. 거부 처리는 우리 책임이고, 결과 검증(Part 3)이 필요한 이유다.
// 다음(7b단계): canUseTool로 승인 게이트를 직접 구현한다.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";

await Bun.file("hello.txt").delete().catch(() => {}); // 이전 실행(7b 등)의 흔적 제거

const result = query({
  prompt: "프로젝트 루트에 hello.txt 파일을 '안녕'이라는 내용으로 만들어줘. 그리고 루트의 파일 목록도 보여줘.",
  options: { model: MODEL, maxTurns: 8, settingSources: [], strictMcpConfig: true }, // maxTurns: API 왕복 수의 상한(정의는 06단계 참고). settingSources·strictMcpConfig: 격리 모드
});

for await (const message of result) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(`세션 시작: permissionMode=${message.permissionMode}, model=${message.model}`);
  }
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`  시도: ${block.name}(${JSON.stringify(block.input).slice(0, 90)})`);
    }
  }
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}`);
    console.log("거부 기록:", JSON.stringify(message.permission_denials, null, 2));
    if (message.subtype === "success") console.log("\n최종 답변:\n" + message.result.slice(0, 400));
  }
}
