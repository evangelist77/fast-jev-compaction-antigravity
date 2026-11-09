import { compact, reductionRatio } from './compact.js';
export { formatAgySessionSummary } from './session-summary.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from './types.js';

/** Tool call representation in Antigravity transcript lines. */
export interface AgyToolCall {
  name: string;
  args?: Record<string, unknown>;
}

/** Single step/record in Antigravity's transcript.jsonl. */
export interface AgyStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: AgyToolCall[];
}

/** Extracts user prompt text, stripping Antigravity <USER_REQUEST> wrapper if present. */
function extractUserText(raw: string): string {
  const match = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (match ? match[1]! : raw).trim();
}

/** Parses raw JSONL string into an array of typed Antigravity steps, ignoring malformed lines. */
function parseAgySteps(jsonl: string): AgyStep[] {
  const steps: AgyStep[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      steps.push(JSON.parse(trimmed) as AgyStep);
    } catch {
      // Ignore malformed/partial lines
    }
  }
  return steps;
}

/** Pairs tool calls from a PLANNER_RESPONSE step with corresponding subsequent GENERIC result steps. */
function pairToolCallsAndResults(
  step: AgyStep,
  stepPosition: number,
  steps: readonly AgyStep[],
): { toolUses: ToolUse[]; toolResults: ToolResult[] } {
  const rawCalls = step.tool_calls ?? [];
  const baseId = `agy_step_${step.step_index ?? stepPosition}`;
  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];

  for (let c = 0; c < rawCalls.length; c += 1) {
    const call = rawCalls[c]!;
    const tool_use_id = `${baseId}_${c}`;
    const nextStep = steps[stepPosition + 1 + c];
    const hasResult = nextStep && nextStep.type === 'GENERIC';
    const resultText = hasResult ? (nextStep.content ?? '') : '';
    const isError = hasResult ? nextStep.status === 'ERROR' : false;

    const use: ToolUse = {
      tool_use_id,
      tool: call.name || 'unknown',
      input: call.args ?? {},
    };

    if (hasResult) {
      use.text = resultText;
      if (isError) use.isError = true;
      toolResults.push({ tool_use_id, text: resultText, isError });
    }
    toolUses.push(use);
  }

  return { toolUses, toolResults };
}

/**
 * Parses Antigravity `transcript.jsonl` content into `fast-jev-compaction`
 * `Message[]`, pairing `PLANNER_RESPONSE.tool_calls` with subsequent `GENERIC`
 * tool output steps.
 */
export function agyTranscriptToMessages(jsonl: string): Message[] {
  const steps = parseAgySteps(jsonl);
  const messages: Message[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;

    if (step.type === 'USER_INPUT') {
      const text = extractUserText(step.content ?? '');
      if (text) messages.push({ role: 'user', text, toolUses: [] });
      continue;
    }

    if (step.type !== 'PLANNER_RESPONSE') {
      continue;
    }

    const text = (step.content ?? '').trim();
    const rawCalls = step.tool_calls ?? [];

    if (rawCalls.length === 0) {
      if (text) messages.push({ role: 'assistant', text, toolUses: [] });
      continue;
    }

    const { toolUses, toolResults } = pairToolCallsAndResults(step, i, steps);
    messages.push({ role: 'assistant', text, toolUses });

    if (toolResults.length > 0) {
      messages.push({ role: 'user', text: '', toolUses: [], toolResults });
      i += toolResults.length;
    }
  }

  return messages;
}

/** Runs Jev compaction on an Antigravity JSONL transcript string. */
export async function compactAgyTranscript(
  jsonl: string,
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const messages = agyTranscriptToMessages(jsonl);
  return compact(messages, asker, options);
}

/** Formats a concise one-line diagnostic summary of Jev compaction results. */
export function formatAgyCompactionReport(result: CompactResult): string {
  const { stats } = result;
  const pct = Math.round(reductionRatio(result) * 100);
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);

  return `fast-jev-compaction: ${stats.messagesAfter}/${stats.messagesBefore} messages (${pct}% char reduction; ${parts.join(', ') || 'no tool calls'}; ~${stats.stateTokens} state tokens in ${stats.requests} req)`;
}
