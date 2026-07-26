const AI_SPAN_ATTRIBUTE = "holaboss.ai_span";

export interface HarnessGenAiUsageMetrics {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  totalTokens?: number | null;
  totalCostUsd?: number | null;
  inputCostUsd?: number | null;
  outputCostUsd?: number | null;
}

type SpanStatus = { code: number; message?: string };

type MinimalSpan = {
  setAttribute(key: string, value: string | number | boolean | undefined): unknown;
  setStatus(status: SpanStatus): unknown;
};

// Gen-AI run instrumentation used to be exported as Sentry spans. Sentry has
// been removed, so these spans run against a no-op sink instead — the rich
// call sites (usage metrics, run status) keep their shape without emitting
// telemetry and without any surgery to the harness loop.
const NOOP_SPAN: MinimalSpan = {
  setAttribute: () => undefined,
  setStatus: () => undefined,
};

export async function runGenAiSpan<T>(
  _options: {
    name: string;
    op?: string;
    attributes?: Record<string, string | number | boolean>;
  },
  run: (span: MinimalSpan) => Promise<T>,
): Promise<T> {
  return run(NOOP_SPAN);
}

export function harnessGenAiSpanAttributes(params: {
  operationName: string;
  model: string;
  providerId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  userId?: string | null;
  sandboxId?: string | null;
  agentName?: string | null;
  thinkingValue?: string | null;
}): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    [AI_SPAN_ATTRIBUTE]: true,
    "gen_ai.operation.name": params.operationName,
    "gen_ai.request.model": params.model,
  };
  if (params.providerId?.trim()) {
    attributes["holaboss.provider_id"] = params.providerId.trim();
  }
  if (params.workspaceId?.trim()) {
    attributes["holaboss.workspace_id"] = params.workspaceId.trim();
  }
  if (params.sessionId?.trim()) {
    attributes["holaboss.session_id"] = params.sessionId.trim();
  }
  if (params.inputId?.trim()) {
    attributes["holaboss.input_id"] = params.inputId.trim();
  }
  if (params.userId?.trim()) {
    attributes["holaboss.user_id"] = params.userId.trim();
  }
  if (params.sandboxId?.trim()) {
    attributes["holaboss.sandbox_id"] = params.sandboxId.trim();
  }
  if (params.agentName?.trim()) {
    attributes["gen_ai.agent.name"] = params.agentName.trim();
  }
  if (params.thinkingValue?.trim()) {
    attributes["holaboss.thinking_value"] = params.thinkingValue.trim();
  }
  return attributes;
}

export function applyHarnessGenAiUsageMetrics(
  span: MinimalSpan,
  usage: HarnessGenAiUsageMetrics | null | undefined,
): void {
  if (!usage) {
    return;
  }
  if (usage.inputTokens !== null && usage.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== null && usage.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  if (usage.cachedInputTokens !== null && usage.cachedInputTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cached",
      usage.cachedInputTokens,
    );
  }
  if (
    usage.cacheWriteInputTokens !== null &&
    usage.cacheWriteInputTokens !== undefined
  ) {
    span.setAttribute(
      "gen_ai.usage.input_tokens.cache_write",
      usage.cacheWriteInputTokens,
    );
  }
  if (usage.totalTokens !== null && usage.totalTokens !== undefined) {
    span.setAttribute("holaboss.token_usage.total_tokens", usage.totalTokens);
  }
  if (usage.inputCostUsd !== null && usage.inputCostUsd !== undefined) {
    span.setAttribute("gen_ai.cost.input_tokens", usage.inputCostUsd);
  }
  if (usage.outputCostUsd !== null && usage.outputCostUsd !== undefined) {
    span.setAttribute("gen_ai.cost.output_tokens", usage.outputCostUsd);
  }
  if (usage.totalCostUsd !== null && usage.totalCostUsd !== undefined) {
    span.setAttribute("gen_ai.cost.total_tokens", usage.totalCostUsd);
  }
}
