// [7c단계·선택] 사람에게 묻는 승인자: Claude Code CLI가 하는 일을 직접 만든다
// 7b는 규칙으로 자동 판정했다. 여기서는 같은 자리에 사람을 넣는다.
// canUseTool은 async 콜백이고, 반환할 때까지 에이전트는 그 자리에 멈춰 선다.
//   공식 문서: "Execution remains paused until your callback returns."
//   그래서 콜백 안에서 터미널 입력을 기다려도 되고, 서버라면 웹소켓으로 UI에 물어도 된다.
// 관찰 포인트 1: y/n을 입력할 때까지 아무 일도 일어나지 않는다. 이 멈춤이 CLI의 승인 프롬프트다.
// 관찰 포인트 2: 거부하면 message가 모델에게 전달되고, 모델은 다른 길을 찾거나 포기한다.
// 관찰 포인트 3: 읽기 도구는 자동 승인이라 여기 오지 않는다. 물어보는 건 승인 대상 도구뿐이다.
// 주의: 사람이 오래 걸리는 실제 서비스라면 콜백에서 무한정 기다리지 말고 PreToolUse 훅의
//   defer 결정으로 세션을 저장했다가 나중에 재개한다(공식 문서 권고).

import * as readline from "node:readline/promises";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// 승인자가 규칙이 아니라 사람이다. 7b의 gate와 자리는 완전히 같다.
const askHuman: CanUseTool = async (toolName, input) => {
  console.log(`\n  ── 승인 요청 ──`);
  console.log(`  도구: ${toolName}`);
  console.log(`  인자: ${JSON.stringify(input).slice(0, 120)}`);

  const answer = (await rl.question("  허용할까요? (y/n): ")).trim().toLowerCase();

  if (answer === "y") {
    console.log("  → 승인");
    return { behavior: "allow", updatedInput: input }; // 인자를 고쳐 넘길 수도 있다
  }
  console.log("  → 거부");
  return { behavior: "deny", message: "사용자가 거부했습니다." }; // 이 문장을 모델이 읽는다
};

await Bun.file("hello.txt").delete().catch(() => {}); // 이전 실행의 흔적 제거

const result = query({
  prompt: "프로젝트 루트에 hello.txt 파일을 '안녕'이라는 내용으로 만들어줘.",
  options: { model: MODEL, maxTurns: 8, canUseTool: askHuman, settingSources: [], strictMcpConfig: true },
});

for await (const message of result) {
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}`);
    if (message.subtype === "success") console.log(`최종 답변: ${message.result.slice(0, 200)}`);
  }
}

// 모델의 보고를 믿지 않는다. 파일 존재는 우리가 확인한다.
console.log(`hello.txt: ${(await Bun.file("hello.txt").exists()) ? "있음" : "없음"}`);
rl.close();
