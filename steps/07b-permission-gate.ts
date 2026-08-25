// [7b단계] canUseTool 승인 콜백: 이번엔 우리가 승인자다
// 7단계에서 Write는 "승인자가 없어서" 거부됐다. canUseTool 콜백을 넘기면 승인 대상 도구가
// 실행되기 직전에 SDK가 우리 코드를 부른다. 여기서 allow/deny를 결정한다.
// canUseTool의 계약:
//   - toolName: 문자열. 내장 도구 이름(Write, Edit, Bash, NotebookEdit, WebFetch, Task ...) 또는
//     MCP 도구 이름(mcp__<서버>__<도구>). 정해진 유니온 타입은 없고 string이다.
//   - input: 모델이 보낸 인자 그대로(Write면 { file_path, content }, Bash면 { command }).
//   - options: blockedPath, decisionReason, suggestions(항상 허용 규칙 후보), toolUseID, agentID 등.
//   - 반환: { behavior: "allow", updatedInput } 또는 { behavior: "deny", message }.
//     allow의 updatedInput으로 인자를 고쳐 넘길 수 있고, deny의 message는 모델에게 전달된다.
//   - 읽기 도구(Read, Glob, Grep)와 allowedTools에 올린 도구는 승인 대상이 아니라 여기 오지 않는다.
// 관찰 포인트 1: canUseTool은 Part 1의 guard()와 같은 규칙이다. 프로젝트 밖 경로와 숨김 파일은 거부.
//   4단계에서 우리 루프 안에 직접 넣었던 가드를, SDK에서는 콜백 하나로 같은 자리에 끼운다.
// 관찰 포인트 2: Write가 막히면 모델은 다른 길(Bash로 echo > 파일)을 찾는다. canUseTool은 도구
//   하나가 아니라 "승인 대상 전부"를 받으므로 우회도 같은 자리에서 잡힌다.
// 관찰 포인트 3: 읽기(Read, Glob, 읽기 전용 Bash)는 default 모드가 자동 승인하므로 canUseTool에
//   오지 않는다. canUseTool 로그에 Write와 Bash만 찍히는 이유다.
// 관찰 포인트 4: 모델의 "만들었습니다"를 믿지 않는다. 끝난 뒤 파일 존재를 우리가 직접 확인한다.

import { basename, resolve } from "node:path";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";

const ROOT = process.cwd();

// 프로젝트 안 경로만 허용하고, 숨김 파일(.env 등)은 막는다 (5단계 guard와 동일)
function guard(path: string): boolean {
  const resolved = resolve(ROOT, path);
  if (!resolved.startsWith(ROOT + "/")) return false;
  if (basename(resolved).startsWith(".")) return false;
  return true;
}

// canUseTool 승인 콜백. 승인 대상 도구가 실행되기 직전에 SDK가 호출한다.
const gate: CanUseTool = async (toolName, input) => {
  const summary = `${toolName} ${JSON.stringify(input).slice(0, 70)}`;
  if (toolName !== "Write" && toolName !== "Edit") {
    console.log(`  canUseTool: ${summary} → 거부 (파일 도구만 허용)`);
    return { behavior: "deny", message: "파일 도구만 쓸 수 있습니다." };
  }
  if (!guard(String(input.file_path))) {
    console.log(`  canUseTool: ${summary} → 거부 (프로젝트 밖 또는 숨김 파일)`);
    return { behavior: "deny", message: "프로젝트 밖은 쓸 수 없습니다." };
  }
  console.log(`  canUseTool: ${summary} → 승인`);
  return { behavior: "allow", updatedInput: input };
};

const INSIDE = "hello.txt";
const OUTSIDE = "/tmp/outside.txt";
await Bun.file(INSIDE).delete().catch(() => { }); // 이전 실행의 흔적 제거

const result = query({
  prompt: `프로젝트 루트에 ${INSIDE} 파일을 '안녕'이라는 내용으로 만들어줘. 그리고 ${OUTSIDE}에도 같은 내용의 파일을 만들어줘. 끝나면 각 파일을 만들었는지 알려줘.`,
  options: { model: MODEL, maxTurns: 10, canUseTool: gate, settingSources: [], strictMcpConfig: true }, // maxTurns: 왕복 상한(6단계)
});

for await (const message of result) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(`세션 시작: permissionMode=${message.permissionMode}`);
  }
  if (message.type === "result") {
    console.log(`\n종료: ${message.subtype}, 턴 ${message.num_turns}, 거부 기록 ${message.permission_denials.length}건`);
    if (message.subtype === "success") console.log("\n최종 답변:\n" + message.result.slice(0, 500));
  }
}

// 모델의 보고를 믿지 않고 직접 확인한다
console.log("\n── 검증 ──");
console.log(`${INSIDE}: ${(await Bun.file(INSIDE).exists()) ? "있음 (승인됨)" : "없음"}`);
console.log(`${OUTSIDE}: ${(await Bun.file(OUTSIDE).exists()) ? "있음 (canUseTool이 뚫렸다!)" : "없음 (거부됨)"}`);
