// [8단계] 세션: 대화를 이어가기
// 관찰 포인트 1: query()는 호출마다 새 세션이다. Part 1의 stateless와 같다. 이어갈지는 우리가 정한다.
// 관찰 포인트 2: Part 1에서는 messages 배열을 우리가 들고 다녔다. SDK에서는 session_id 하나만 들고
//   있으면 된다. 대화 원문은 SDK가 디스크(~/.claude/projects/<프로젝트>/<session_id>.jsonl)에 적는다.
// 관찰 포인트 3: resume하면 이전 대화가 통째로 컨텍스트에 실린다. 도구를 다시 부르지 않고 기억으로
//   답하지만, 그만큼 입력이 커진다(Part 1의 누적 재전송과 같은 원리).
// 관찰 포인트 4: resume 없이 같은 후속 질문을 던지면 모델은 "무슨 파일?"이 된다.
//   세션은 마법이 아니라 저장과 재전송이다. 백엔드에서는 session_id를 사용자·대화 키에 매핑해 둔다.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL } from "../src/config";

type Outcome = { sessionId: string; toolCalls: number; cost: number; answer: string };

async function ask(prompt: string, sessionId?: string): Promise<Outcome> {
  const outcome: Outcome = { sessionId: "", toolCalls: 0, cost: 0, answer: "" };
  const result = query({ prompt, options: { model: MODEL, maxTurns: 6, resume: sessionId, settingSources: [], strictMcpConfig: true } }); // resume에 세션 id. 없으면 새 세션
  for await (const message of result) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        outcome.toolCalls++;
        console.log(`  도구: ${block.name}(${JSON.stringify(block.input).slice(0, 60)})`);
      }
    }
    if (message.type === "result") {
      outcome.sessionId = message.session_id;
      outcome.cost = message.total_cost_usd;
      if (message.subtype === "success") outcome.answer = message.result;
    }
  }
  console.log(`  세션 ${outcome.sessionId} · 도구 ${outcome.toolCalls}회 · $${outcome.cost.toFixed(4)}`);
  console.log(`  답변: ${outcome.answer.replace(/\s+/g, " ").slice(0, 160)}\n`);
  return outcome;
}

console.log("── 1차: 새 세션에서 파일을 읽힌다 ──");
const target = `${process.cwd()}/src/index.ts`; // 상대 경로는 모델이 엉뚱하게 풀 수 있다. 절대 경로로 (ACI)
const first = await ask(`${target}를 읽고 한 문장으로 요약해줘.`);

const q2 = "엔드포인트가 몇 개였지? 다시 읽지 말고 기억으로 답해.";

console.log("── 2차: resume으로 이어서 묻는다 ──");
await ask(q2, first.sessionId); // 2차: resume으로 잇는다

console.log("── 3차: resume 없이 같은 질문 ──");
await ask(q2); // 3차: 새 세션

const slug = process.cwd().replace(/\//g, "-");
console.log(`세션 원문: ~/.claude/projects/${slug}/${first.sessionId}.jsonl`);
