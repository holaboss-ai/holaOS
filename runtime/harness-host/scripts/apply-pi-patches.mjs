import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");

function patchFile(relativePath, replacements) {
  const filePath = path.join(rootDir, relativePath);
  let contents = fs.readFileSync(filePath, "utf8");
  let changed = false;

  for (const replacement of replacements) {
    if (replacement.verify && contents.includes(replacement.verify)) {
      continue;
    }
    if (replacement.pattern) {
      if (!replacement.pattern.test(contents)) {
        throw new Error(`Expected patch pattern not found in ${relativePath}`);
      }
      contents = contents.replace(replacement.pattern, replacement.replace);
      changed = true;
      continue;
    }
    if (!contents.includes(replacement.match)) {
      throw new Error(`Expected patch target not found in ${relativePath}`);
    }
    contents = contents.replace(replacement.match, replacement.replace);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, contents);
  }
}

patchFile("node_modules/@mariozechner/pi-ai/dist/providers/openai-responses.js", [
  {
    verify: "function supportsPromptCacheRetention(baseUrl) {",
    match: `/**
 * Get prompt cache retention based on cacheRetention and base URL.
 * Only applies to direct OpenAI API calls (api.openai.com).
 */
function getPromptCacheRetention(baseUrl, cacheRetention) {
    if (cacheRetention !== "long") {
        return undefined;
    }
    if (baseUrl.includes("api.openai.com")) {
        return "24h";
    }
    return undefined;
}
`,
    replace: `/**
 * Get prompt cache retention based on cacheRetention and base URL.
 * Applies to direct OpenAI API calls and explicit proxy routes that target OpenAI.
 */
function supportsPromptCacheRetention(baseUrl) {
    if (baseUrl.includes("api.openai.com")) {
        return true;
    }
    try {
        const url = new URL(baseUrl);
        return /(?:^|\\/)openai(?:\\/|$)/.test(url.pathname);
    }
    catch {
        return /(?:^|\\/)openai(?:\\/|$)/.test(baseUrl);
    }
}
function getPromptCacheRetention(baseUrl, cacheRetention) {
    if (cacheRetention !== "long") {
        return undefined;
    }
    if (supportsPromptCacheRetention(baseUrl)) {
        return "24h";
    }
    return undefined;
}
`,
  },
]);

patchFile("node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js", [
  {
    verify: "const SUMMARIZATION_ESTIMATED_BYTES_PER_TOKEN = 2;",
    pattern:
      /const UPDATE_SUMMARIZATION_PROMPT = `[\s\S]*?export function prepareCompaction/,
    replace: `const UPDATE_SUMMARIZATION_PROMPT = \`The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.\`;
const SUMMARIZATION_REQUEST_TOKEN_SAFETY = 4096;
const SUMMARIZATION_DEFAULT_MESSAGE_CHAR_BUDGET = 12000;
const SUMMARIZATION_MIN_MESSAGE_CHAR_BUDGET = 1200;
const SUMMARIZATION_ESTIMATED_BYTES_PER_TOKEN = 2;
function estimateSummaryPromptTokens(text) {
    return Math.ceil(Buffer.byteLength(text, "utf8") / SUMMARIZATION_ESTIMATED_BYTES_PER_TOKEN);
}
function resolveCompactionContextWindow(model, reserveTokens) {
    return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
        ? model.contextWindow
        : Math.max(reserveTokens * 6, reserveTokens + 32768);
}
function truncateSummaryText(text, maxChars, suffix = "for compaction") {
    if (text.length <= maxChars) {
        return text;
    }
    const truncatedChars = text.length - maxChars;
    return \`\${text.slice(0, maxChars)}\\n\\n[... \${truncatedChars} more characters truncated \${suffix}]\`;
}
function serializeTextBlocks(blocks, maxCharsPerBlock) {
    let content = "";
    for (const block of blocks) {
        if (block.type === "text" && block.text) {
            content += block.text;
            continue;
        }
        if (block.type === "image") {
            content += "[image omitted during compaction]";
        }
    }
    return truncateSummaryText(content, maxCharsPerBlock);
}
function serializeMessageForSummary(message, maxCharsPerBlock) {
    if (message.role === "user") {
        const content = typeof message.content === "string"
            ? truncateSummaryText(message.content, maxCharsPerBlock)
            : serializeTextBlocks(message.content, maxCharsPerBlock);
        return content ? \`[User]: \${content}\` : "";
    }
    if (message.role === "assistant") {
        const parts = [];
        const textParts = [];
        const thinkingParts = [];
        const toolCalls = [];
        for (const block of message.content) {
            if (block.type === "text") {
                textParts.push(block.text);
                continue;
            }
            if (block.type === "thinking") {
                thinkingParts.push(block.thinking);
                continue;
            }
            if (block.type === "toolCall") {
                const argsStr = truncateSummaryText(JSON.stringify(block.arguments), maxCharsPerBlock, "for compaction");
                toolCalls.push(\`\${block.name}(\${argsStr})\`);
            }
        }
        if (thinkingParts.length > 0) {
            parts.push(\`[Assistant thinking]: \${truncateSummaryText(thinkingParts.join("\\n"), Math.max(SUMMARIZATION_MIN_MESSAGE_CHAR_BUDGET, Math.floor(maxCharsPerBlock / 2)))}\`);
        }
        if (textParts.length > 0) {
            parts.push(\`[Assistant]: \${truncateSummaryText(textParts.join("\\n"), maxCharsPerBlock)}\`);
        }
        if (toolCalls.length > 0) {
            parts.push(\`[Assistant tool calls]: \${truncateSummaryText(toolCalls.join("; "), maxCharsPerBlock)}\`);
        }
        return parts.join("\\n\\n");
    }
    if (message.role === "toolResult") {
        const content = serializeTextBlocks(message.content, maxCharsPerBlock);
        return content ? \`[Tool result]: \${content}\` : "";
    }
    if (message.role === "custom" || message.role === "bashExecution") {
        const content = typeof message.content === "string"
            ? truncateSummaryText(message.content, maxCharsPerBlock)
            : serializeTextBlocks(message.content, maxCharsPerBlock);
        return content ? \`[Context]: \${content}\` : "";
    }
    if (message.role === "branchSummary" || message.role === "compactionSummary") {
        return \`[Summary]: \${truncateSummaryText(message.summary, maxCharsPerBlock)}\`;
    }
    return "";
}
function serializeMessagesForSummary(messages, maxCharsPerBlock) {
    const parts = [];
    for (const message of messages) {
        const serialized = serializeMessageForSummary(message, maxCharsPerBlock);
        if (serialized) {
            parts.push(serialized);
        }
    }
    return parts.join("\\n\\n");
}
function buildSummaryPromptText(conversationText, basePrompt, previousSummary) {
    let promptText = \`<conversation>\\n\${conversationText}\\n</conversation>\\n\\n\`;
    if (previousSummary) {
        promptText += \`<previous-summary>\\n\${previousSummary}\\n</previous-summary>\\n\\n\`;
    }
    promptText += basePrompt;
    return promptText;
}
function buildSummaryCompletionOptions(model, maxTokens, signal, apiKey, headers, sessionId) {
    return model.reasoning
        ? { maxTokens, signal, apiKey, headers, reasoning: "high", sessionId }
        : { maxTokens, signal, apiKey, headers, sessionId };
}
function isCompactionContextOverflow(error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (normalized.includes("context") && (normalized.includes("exceed") || normalized.includes("overflow")))
        || normalized.includes("maximum context length");
}
function estimateSummaryRequestTokens(promptText, maxTokens, reserveTokens) {
    return estimateSummaryPromptTokens(SUMMARIZATION_SYSTEM_PROMPT)
        + estimateSummaryPromptTokens(promptText)
        + maxTokens
        + Math.max(SUMMARIZATION_REQUEST_TOKEN_SAFETY, Math.floor(reserveTokens * 0.25));
}
function estimateSerializedMessageTokens(message, maxCharsPerBlock) {
    return estimateSummaryPromptTokens(serializeMessageForSummary(message, maxCharsPerBlock));
}
function chooseCompactionSplitIndex(messages, maxCharsPerBlock) {
    if (messages.length <= 1) {
        return 1;
    }
    const isTurnStart = (message) => message.role === "user" || message.role === "bashExecution" || message.role === "custom";
    const totalTokens = messages.reduce((sum, message) => sum + estimateSerializedMessageTokens(message, maxCharsPerBlock), 0);
    const targetTokens = Math.max(1, Math.floor(totalTokens / 2));
    let runningTokens = 0;
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 1; i < messages.length; i++) {
        runningTokens += estimateSerializedMessageTokens(messages[i - 1], maxCharsPerBlock);
        if (!isTurnStart(messages[i])) {
            continue;
        }
        const distance = Math.abs(targetTokens - runningTokens);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }
    if (bestIndex !== -1) {
        return bestIndex;
    }
    return Math.floor(messages.length / 2);
}
function resolveSummaryPrompt(basePrompt, updatePrompt, previousSummary, customInstructions) {
    let prompt = previousSummary ? updatePrompt : basePrompt;
    if (customInstructions) {
        prompt = \`\${prompt}\\n\\nAdditional focus: \${customInstructions}\`;
    }
    return prompt;
}
function createSummaryMergeMessages(summary) {
    return [
        {
            role: "compactionSummary",
            summary,
            timestamp: Date.now(),
        },
    ];
}
async function requestSummary(messages, options, maxCharsPerBlock) {
    const { model, reserveTokens, apiKey, headers, signal, basePrompt, previousSummary, sessionId, maxTokens, } = options;
    const conversationText = serializeMessagesForSummary(messages, maxCharsPerBlock);
    const promptText = buildSummaryPromptText(conversationText, basePrompt, previousSummary);
    const estimatedTokens = estimateSummaryRequestTokens(promptText, maxTokens, reserveTokens);
    if (estimatedTokens > resolveCompactionContextWindow(model, reserveTokens)) {
        const error = new Error("Summarization failed: estimated compaction prompt exceeds the model context window");
        error.name = "ContextLengthExceededError";
        throw error;
    }
    const summarizationMessages = [
        {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
        },
    ];
    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, buildSummaryCompletionOptions(model, maxTokens, signal, apiKey, headers, sessionId));
    if (response.stopReason === "error") {
        throw new Error(\`Summarization failed: \${response.errorMessage || "Unknown error"}\`);
    }
    return response.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\\n");
}
async function summarizeDirect(messages, options) {
    let lastOverflowError = null;
    for (const maxCharsPerBlock of [
        SUMMARIZATION_DEFAULT_MESSAGE_CHAR_BUDGET,
        Math.max(SUMMARIZATION_MIN_MESSAGE_CHAR_BUDGET * 2, Math.floor(SUMMARIZATION_DEFAULT_MESSAGE_CHAR_BUDGET / 2)),
        SUMMARIZATION_MIN_MESSAGE_CHAR_BUDGET,
    ]) {
        try {
            return await requestSummary(messages, options, maxCharsPerBlock);
        }
        catch (error) {
            if (!isCompactionContextOverflow(error)) {
                throw error;
            }
            lastOverflowError = error;
        }
    }
    if (lastOverflowError) {
        throw lastOverflowError;
    }
    throw new Error("Summarization failed: unable to summarize direct chunk");
}
async function mergeSummaryPair(leftSummary, rightSummary, options) {
    if (!rightSummary) {
        return leftSummary;
    }
    return await summarizeDirect(createSummaryMergeMessages(rightSummary), {
        ...options,
        previousSummary: leftSummary,
        basePrompt: resolveSummaryPrompt(options.basePrompt, options.updatePrompt, leftSummary, options.customInstructions),
    });
}
async function summarizeMessagesLeftFirst(messages, options) {
    const { previousSummary, maxTokens = Math.floor(0.8 * options.reserveTokens), basePrompt, updatePrompt, customInstructions, } = options;
    if (messages.length === 0) {
        return previousSummary || "";
    }
    const resolvedOptions = {
        ...options,
        previousSummary,
        maxTokens,
        basePrompt: resolveSummaryPrompt(basePrompt, updatePrompt, previousSummary, customInstructions),
        updatePrompt,
        customInstructions,
    };
    try {
        return await summarizeDirect(messages, resolvedOptions);
    }
    catch (error) {
        if (!isCompactionContextOverflow(error)) {
            throw error;
        }
        if (messages.length <= 1) {
            throw error;
        }
    }
    const splitIndex = chooseCompactionSplitIndex(messages, SUMMARIZATION_DEFAULT_MESSAGE_CHAR_BUDGET);
    if (splitIndex <= 0 || splitIndex >= messages.length) {
        throw new Error("Summarization failed: unable to split compaction history");
    }
    const leftMessages = messages.slice(0, splitIndex);
    const rightMessages = messages.slice(splitIndex);
    const leftSummary = await summarizeMessagesLeftFirst(leftMessages, {
        ...options,
        previousSummary,
        maxTokens,
    });
    try {
        return await summarizeDirect(rightMessages, {
            ...options,
            previousSummary: leftSummary,
            maxTokens,
            basePrompt: resolveSummaryPrompt(basePrompt, updatePrompt, leftSummary, customInstructions),
            updatePrompt,
            customInstructions,
        });
    }
    catch (error) {
        if (!isCompactionContextOverflow(error)) {
            throw error;
        }
    }
    const rightSummary = await summarizeMessagesLeftFirst(rightMessages, {
        ...options,
        previousSummary: undefined,
        maxTokens,
    });
    return await mergeSummaryPair(leftSummary, rightSummary, {
        ...options,
        previousSummary: undefined,
        maxTokens,
        basePrompt,
        updatePrompt,
        customInstructions,
    });
}
/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, sessionId) {
    const llmMessages = convertToLlm(currentMessages);
    return await summarizeMessagesLeftFirst(llmMessages, {
        model,
        reserveTokens,
        apiKey,
        headers,
        signal,
        basePrompt: SUMMARIZATION_PROMPT,
        updatePrompt: UPDATE_SUMMARIZATION_PROMPT,
        customInstructions,
        previousSummary,
        sessionId,
    });
}
export function prepareCompaction`,
  },
  {
    verify: "const UPDATE_TURN_PREFIX_SUMMARIZATION_PROMPT =",
    pattern:
      /const TURN_PREFIX_SUMMARIZATION_PROMPT = `[\s\S]*?async function generateTurnPrefixSummary\(messages, model, reserveTokens, apiKey, headers, signal(?:, sessionId)?\) \{[\s\S]*?\n\}/,
    replace: `const TURN_PREFIX_SUMMARIZATION_PROMPT = \`This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.\`;
const UPDATE_TURN_PREFIX_SUMMARIZATION_PROMPT = \`The messages above are ADDITIONAL prefix messages from the same oversized turn. Update the existing prefix summary in <previous-summary>.

Use this EXACT format:

## Original Request
[Preserve the original request, updating only if the new prefix clarifies it]

## Early Progress
- [Preserve prior items and add newly discovered work from the additional prefix]

## Context for Suffix
- [Preserve required context for the retained suffix and add any newly relevant details]

Be concise. Avoid repeating information already captured in <previous-summary>.\`;
/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(preparation, model, apiKey, headers, customInstructions, signal, sessionId) {
    const { firstKeptEntryId, messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings, } = preparation;
    let summary;
    if (isSplitTurn && turnPrefixMessages.length > 0) {
        const [historyResult, turnPrefixResult] = await Promise.all([
            messagesToSummarize.length > 0
                ? generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, sessionId)
                : Promise.resolve("No prior history."),
            generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, signal, sessionId),
        ]);
        summary = \`\${historyResult}\\n\\n---\\n\\n**Turn Context (split turn):**\\n\\n\${turnPrefixResult}\`;
    }
    else {
        summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, sessionId);
    }
    const { readFiles, modifiedFiles } = computeFileLists(fileOps);
    summary += formatFileOperations(readFiles, modifiedFiles);
    if (!firstKeptEntryId) {
        throw new Error("First kept entry has no UUID - session may need migration");
    }
    return {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { readFiles, modifiedFiles },
    };
}
/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, signal, sessionId) {
    const llmMessages = convertToLlm(messages);
    return await summarizeMessagesLeftFirst(llmMessages, {
        model,
        reserveTokens,
        apiKey,
        headers,
        signal,
        basePrompt: TURN_PREFIX_SUMMARIZATION_PROMPT,
        updatePrompt: UPDATE_TURN_PREFIX_SUMMARIZATION_PROMPT,
        previousSummary: undefined,
        customInstructions: undefined,
        sessionId,
        maxTokens: Math.floor(0.5 * reserveTokens),
    });
}`,
  },
]);

patchFile("node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.d.ts", [
  {
    verify: "previousSummary?: string, sessionId?: string",
    match: "export declare function generateSummary(currentMessages: AgentMessage[], model: Model<any>, reserveTokens: number, apiKey: string, headers?: Record<string, string>, signal?: AbortSignal, customInstructions?: string, previousSummary?: string): Promise<string>;",
    replace: "export declare function generateSummary(currentMessages: AgentMessage[], model: Model<any>, reserveTokens: number, apiKey: string, headers?: Record<string, string>, signal?: AbortSignal, customInstructions?: string, previousSummary?: string, sessionId?: string): Promise<string>;",
  },
  {
    verify: "signal?: AbortSignal, sessionId?: string",
    match: "export declare function compact(preparation: CompactionPreparation, model: Model<any>, apiKey: string, headers?: Record<string, string>, customInstructions?: string, signal?: AbortSignal): Promise<CompactionResult>;",
    replace: "export declare function compact(preparation: CompactionPreparation, model: Model<any>, apiKey: string, headers?: Record<string, string>, customInstructions?: string, signal?: AbortSignal, sessionId?: string): Promise<CompactionResult>;",
  },
]);

patchFile("node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/branch-summarization.js", [
  {
    verify: "reserveTokens = 16384, sessionId } = options",
    match: "    const { model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;",
    replace: "    const { model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens = 16384, sessionId } = options;",
  },
  {
    verify: "maxTokens: 2048, sessionId",
    match: "    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, { apiKey, headers, signal, maxTokens: 2048 });",
    replace: "    const response = await completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, { apiKey, headers, signal, maxTokens: 2048, sessionId });",
  },
]);

patchFile("node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/branch-summarization.d.ts", [
  {
    verify: "sessionId?: string;",
    match: `    /** Tokens reserved for prompt + LLM response (default 16384) */
    reserveTokens?: number;
`,
    replace: `    /** Tokens reserved for prompt + LLM response (default 16384) */
    reserveTokens?: number;
    /** Stable cache key for summarization requests */
    sessionId?: string;
`,
  },
]);

patchFile("node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js", [
  {
    verify: "this._compactionAbortController.signal, this.sessionId",
    match: "const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal);",
    replace: "const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.sessionId);",
  },
  {
    verify: "this._autoCompactionAbortController.signal, this.sessionId",
    match: "const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal);",
    replace: "const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.sessionId);",
  },
  {
    verify: "reserveTokens: branchSummarySettings.reserveTokens,\n                sessionId: this.sessionId,",
    match: `                reserveTokens: branchSummarySettings.reserveTokens,
            });
`,
    replace: `                reserveTokens: branchSummarySettings.reserveTokens,
                sessionId: this.sessionId,
            });
`,
  },
]);
