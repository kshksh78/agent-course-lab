// [13단계] LLM 관측: 5단계 에이전트 루프에 Langfuse 트레이싱을 붙인다
// 관찰 포인트 1: 콘솔 로그 대신 대시보드. 실행(trace) 하나에 턴별 모델 호출(generation)과
//   도구 실행(span)이 트리로 쌓이고, 토큰·비용·지연이 자동 집계된다.
// 관찰 포인트 2: 코드 변경은 계측 코드뿐이다. 에이전트 로직은 5단계와 동일하다.
// 준비물: .env에 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL

import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation } from "@langfuse/tracing";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../src/config";

// ── Langfuse 계측 셋업: OpenTelemetry 프로바이더에 Langfuse 프로세서를 끼운다 ──
const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
provider.register();

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

function guard(path: string): string | null {
  const resolved = resolve(ROOT, path);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + "/")) return null;
  if (basename(resolved).startsWith(".")) return null;
  return resolved;
}

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

// ── 에이전트 루프 (5단계와 동일) + 계측 ──
const QUESTION = "이 프로젝트에 어떤 파일이 있는지 파악하고, 핵심 소스 파일을 찾아 무슨 코드인지 요약해줘.";

const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: QUESTION }];
const MAX_TURNS = 10;

const trace = startObservation("agent-loop", { input: QUESTION });

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  // 턴 하나 = 모델 호출 하나 = generation 관측 하나
  const generation = trace.startObservation(
    `턴 ${turn} 모델 호출`,
    { model: MODEL, input: messages },
    { asType: "generation" },
  );

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    tools,
    messages,
  });

  generation.update({
    output: res.content,
    usageDetails: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  });
  generation.end();

  console.log(`[턴 ${turn}] stop_reason: ${res.stop_reason} (입력 ${res.usage.input_tokens} 토큰)`);
  messages.push({ role: "assistant", content: res.content });

  if (res.stop_reason !== "tool_use") {
    const finalText = res.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    console.log("\n── 모델의 최종 답변 ──\n" + finalText);
    trace.update({ output: finalText });
    break;
  }

  const results: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const block of res.content) {
    if (block.type !== "tool_use") continue;
    console.log(`  실행: ${block.name}(${JSON.stringify(block.input)})`);
    // 도구 실행 = span 관측
    const toolSpan = trace.startObservation(`도구: ${block.name}`, { input: block.input });
    const result = await runTool(block);
    toolSpan.update({ output: { is_error: result.is_error ?? false } });
    toolSpan.end();
    results.push(result);
  }
  messages.push({ role: "user", content: results });
}

trace.end();
await provider.shutdown(); // 남은 관측 데이터를 Langfuse로 flush한다
console.log("\nLangfuse로 전송 완료. 대시보드에서 agent-loop 트레이스를 확인하라.");
