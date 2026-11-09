import { reductionRatio } from './compact.js';
import type { CompactResult, Message, ToolUse } from './types.js';

/**
 * Extracts a concise target identifier (file path, CLI command, etc.) from tool inputs.
 */
function extractToolTarget(input: Record<string, unknown>): string {
  const namedTarget =
    input.Path ??
    input.CommandLine ??
    input.file_path ??
    input.command ??
    input.path;

  if (namedTarget) {
    return String(namedTarget).replace(/^["']|["']$/g, '');
  }

  const entries = Object.entries(input);
  if (entries.length === 0) return '';

  const firstEntry = entries[0];
  if (!firstEntry) return '';

  const [firstKey, firstVal] = firstEntry;
  if (typeof firstVal === 'string' || typeof firstVal === 'number' || typeof firstVal === 'boolean') {
    return `${firstKey}: ${firstVal}`;
  }

  return '';
}

/**
 * Formats a single tool execution into a concise Markdown bullet point.
 */
function describeToolUse(use: ToolUse): string {
  const target = extractToolTarget(use.input);
  const targetStr = target ? ` (${target})` : '';
  const status = use.isError ? ' [FAILED]' : '';
  const textSnippet = use.text ? `: ${use.text.trim().slice(0, 120).replace(/\s+/g, ' ')}` : '';

  return `- \`${use.tool}\`${targetStr}${status}${textSnippet}`;
}

/**
 * Extracts and formats user requests from compacted messages.
 */
function formatUserRequests(messages: readonly Message[]): string {
  const requests: string[] = [];

  for (const message of messages) {
    if (message.role === 'user' && message.text.trim()) {
      requests.push(`- ${message.text.trim()}`);
    }
  }

  if (requests.length === 0) return '';

  return ['## User Requests', ...requests].join('\n');
}

/**
 * Extracts and formats key tool interactions across all assistant messages.
 */
function formatToolInteractions(messages: readonly Message[]): string {
  const toolLines: string[] = [];

  for (const message of messages) {
    for (const use of message.toolUses) {
      toolLines.push(describeToolUse(use));
    }
  }

  if (toolLines.length === 0) return '';

  return ['## Key Tool Interactions', ...toolLines].join('\n');
}

/**
 * Extracts and formats recent assistant progress messages.
 */
function formatRecentProgress(messages: readonly Message[]): string {
  const notes: string[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && message.text.trim()) {
      notes.push(`- ${message.text.trim().slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  }

  if (notes.length === 0) return '';

  const recent = notes.slice(-5);
  return ['## Recent Progress & Context', ...recent].join('\n');
}

/**
 * Formats Jev compaction statistics into Markdown.
 */
function formatStatsSection(result: CompactResult): string {
  const pct = Math.round(reductionRatio(result) * 100);
  const { stats } = result;

  return [
    '# Previous Session Summary',
    '',
    '## Compaction Statistics',
    `- Messages: retained ${stats.messagesAfter} of ${stats.messagesBefore} (${pct}% reduction)`,
    `- Tool calls: ${stats.kept} kept, ${stats.resultsDropped} results truncated, ${stats.callsDropped} calls dropped`,
  ].join('\n');
}

/**
 * Formats a CompactResult into a structured Markdown session summary
 * for injection into Antigravity's native CortexStepCheckpoint.
 */
export function formatAgySessionSummary(result: CompactResult): string {
  const sections = [
    formatStatsSection(result),
    formatUserRequests(result.messages),
    formatToolInteractions(result.messages),
    formatRecentProgress(result.messages),
  ].filter((section) => section.length > 0);

  return sections.join('\n\n');
}
