// [5단계] while 루프 = 에이전트
// 4단계의 수동 왕복을 stop_reason이 tool_use인 동안 반복한다. 이것이 에이전트다.
// 관찰 포인트 1: 실행 경로를 우리가 그리지 않았다. 모델이 list_files → read_file 순서를
//   스스로 정한다. 2b단계에서 경로를 몰라 되묻던 모델이, 도구가 있으니 스스로 탐색한다.
// 관찰 포인트 2: 요청서가 한 응답에 여러 개 올 수 있다(병렬 호출).
//   for문으로 전부 실행하고, 결과를 하나의 user 메시지에 담아 돌려준다.
// 관찰 포인트 3: 매 턴 입력 토큰이 커진다. 대화(요청서, 실행 결과)가 누적 재전송되기 때문이다.
// 관찰 포인트 4: 실패(없는 파일, 금지 경로)도 is_error로 돌려주면 모델이 스스로 경로를 고친다.

import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

const client = new Anthropic();
const ROOT = process.cwd();

const SYSTEM =
  "너는 프로젝트 루트 디렉토리에서 실행 중인 코딩 어시스턴트다. 상대 경로는 프로젝트 루트 기준으로 해석된다.";

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "read_file",
    description: "지정한 경로의 파일 내용을 텍스트로 읽어 반환한다. 한 번에 최대 4,000자를 반환한다.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "읽을 파일의 상대 경로" },
        offset: { type: "number", description: "읽기 시작 위치(문자). 잘린 파일을 이어 읽을 때 사용. 기본 0" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "지정한 디렉토리의 파일과 폴더 목록을 반환한다.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "나열할 디렉토리 경로. 생략하면 프로젝트 루트" } },
      required: [],
    },
  },
];

// 프로젝트 안 경로만 허용하고, 숨김 파일(.env 등)은 접근을 막는다
function guard(path: string): string | null {
  const resolved = resolve(ROOT, path);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + "/")) return null;
  if (basename(resolved).startsWith(".")) return null;
  return resolved;
}

// 도구 실행. 어떤 실패든 is_error로 돌려준다. 실패도 결과다.
async function runTool(
  toolUse: Anthropic.Messages.ToolUseBlock,
): Promise<Anthropic.Messages.ToolResultBlockParam> {
  const fail = (message: string): Anthropic.Messages.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: toolUse.id,
    content: message,
    is_error: true,
  });

  try {
    if (toolUse.name === "read_file") {
      const { path, offset = 0 } = toolUse.input as { path: string; offset?: number };
      const resolved = guard(path);
      if (!resolved) return fail("허용되지 않은 경로입니다. 프로젝트 안의 일반 파일만 읽을 수 있습니다.");
      // 도구 결과도 컨텍스트 예산이다. 큰 파일은 잘라서 돌려준다 (Claude Code도 같은 전략)
      // 잘렸으면 이어 읽는 법(offset)을 결과에 안내한다. 모델이 필요하면 스스로 이어 읽는다.
      const text = await Bun.file(resolved).text();
      const LIMIT = 4000;
      const chunk = text.slice(offset, offset + LIMIT);
      const content =
        offset + LIMIT < text.length
          ? `${chunk}\n...(잘림: 전체 ${text.length}자. 이어 읽으려면 offset: ${offset + LIMIT})`
          : chunk;
      return { type: "tool_result", tool_use_id: toolUse.id, content };
    }
    if (toolUse.name === "list_files") {
      const { path = "." } = toolUse.input as { path?: string };
      const resolved = guard(path === "." ? "" : path) ?? (path === "." ? ROOT : null);
      if (!resolved) return fail("허용되지 않은 경로입니다.");
      const entries = (await readdir(resolved)).filter(
        (name) => !name.startsWith(".") && name !== "node_modules",
      );
      return { type: "tool_result", tool_use_id: toolUse.id, content: entries.join("\n") };
    }
    return fail(`알 수 없는 도구: ${toolUse.name}`);
  } catch (error) {
    return fail(`실행 실패: ${error}`);
  }
}

// ── 에이전트 루프 ──
const messages: Anthropic.Messages.MessageParam[] = [
  {
    role: "user",
    content: "이 프로젝트에 어떤 파일이 있는지 파악하고, 핵심 소스 파일을 찾아 무슨 코드인지 요약해줘.",
  },
];

const MAX_TURNS = 10; // 안전장치: 루프가 폭주하지 않도록 상한을 둔다. 1턴 = 요청 1 + 응답 1 (병렬 도구 호출도 한 턴)

// 비용 집계 (Part 2의 Agent SDK와 비교하기 위해 우리도 기록한다)
let totalInput = 0;
let totalOutput = 0;

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048, // 마지막 턴의 최종 답변이 잘리지 않도록 앞 단계보다 여유 있게
    system: SYSTEM,
    tools,
    messages,
  });

  console.log(`[턴 ${turn}] stop_reason: ${res.stop_reason} (입력 ${res.usage.input_tokens} 토큰)`);
  totalInput += res.usage.input_tokens;
  totalOutput += res.usage.output_tokens;
  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") {
    // 할 일이 끝났다. 최종 답변을 출력하고 루프를 나간다.
    console.log("\n── 모델의 최종 답변 ──");
    for (const block of res.content) {
      if (block.type === "text") console.log(block.text);
    }
    break;
  }

  // 요청서를 전부 실행하고, 결과를 하나의 user 메시지에 담아 돌려준다
  const results: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const block of res.content) {
    if (block.type !== "tool_use") continue;
    console.log(`  실행: ${block.name}(${JSON.stringify(block.input)})`);
    results.push(await runTool(block));
  }
  messages.push({ role: "user", content: results });
}

// 합계와 추정 비용. 단가는 기본 모델(Haiku 4.5, 2026-08) 기준이라 모델을 바꾸면 갱신해야 한다.
const cost = (totalInput * 1 + totalOutput * 5) / 1_000_000; // $1 / $5 per 1M tokens
console.log(
  `\n합계: 입력 ${totalInput.toLocaleString()} + 출력 ${totalOutput.toLocaleString()} 토큰, 추정 비용 $${cost.toFixed(4)}`,
);
