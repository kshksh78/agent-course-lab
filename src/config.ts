// 사용할 모델은 .env의 ANTHROPIC_MODEL로 관리한다.
// 모델이 deprecated 되면 코드를 고치지 않고 .env 한 줄만 바꾸면 된다.
export const MODEL = Bun.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
