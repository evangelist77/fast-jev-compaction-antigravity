import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agyTranscriptToMessages,
  compactAgyTranscript,
  formatAgyCompactionReport,
  formatAgySessionSummary,
} from '../src/antigravity.js';
import { JevClient } from '../src/client.js';
import { compact, reductionRatio } from '../src/compact.js';
import type { CompactResult, JevAsker } from '../src/types.js';

/** Expected input shape passed to Antigravity PreInvocation hooks via stdin. */
export interface AgyHookInput {
  conversationId?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  lastUserInput?: string;
  prompt?: string;
}

/** Matches slash command '/compact' with optional trailing arguments. */
const COMPACT_COMMAND_REGEX = /^\/compact(?:\s+(.*))?$/i;

/** Minimum required reduction ratio to trigger auto-compaction notice. */
const MIN_AUTO_REDUCTION_RATIO = 0.25;

/** Resolves the TypeSafe API key from environment variables or ~/.typesafe_key fallback file. */
export function readApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const envKey = env.TYPESAFE_API_KEY?.trim();
  if (envKey) return envKey;

  if (env === process.env) {
    const keyPath = path.join(os.homedir(), '.typesafe_key');
    if (fs.existsSync(keyPath)) {
      try { return fs.readFileSync(keyPath, 'utf8').trim(); } catch { /* Ignore read error */ }
    }
  }

  return '';
}

/** Writes compacted result payload into session artifact directory when available. */
function writeArtifactReport(dirPath: string | undefined, result: CompactResult): void {
  if (!dirPath || !fs.existsSync(dirPath)) return;
  try {
    fs.writeFileSync(path.join(dirPath, 'jev-compacted-context.json'), JSON.stringify(result, null, 2), 'utf8');
  } catch {
    // Artifact write failure should never abort the hook turn
  }
}

/** Constructs the Antigravity PreInvocation injection response object. */
function buildInjectionResponse(summary: string): string {
  return JSON.stringify({
    injectSteps: [{ systemMessage: { systemMessage: '', metadata: { user_markdown: `> \`${summary}\`` } } }],
  });
}

/** Constructs the Antigravity PreInvocation response for manual /compact. */
function buildManualCompactResponse(sessionSummary: string, report: string): string {
  return JSON.stringify({
    injectSteps: [{
      systemMessage: {
        systemMessage: sessionSummary,
        metadata: { user_markdown: `> **Fast Jev Compaction Complete**\n> \`${report}\`\n\n${sessionSummary}` },
      },
    }],
    terminationBehavior: 'terminate',
  });
}

/** Handles explicit /compact command invocation by injecting a compacted session message. */
async function handleManualCompact(
  payload: AgyHookInput,
  asker: JevAsker,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (!payload.transcriptPath || !fs.existsSync(payload.transcriptPath)) return '{}';

  const userInput = (payload.lastUserInput ?? payload.prompt ?? '').trim();
  const jsonl = fs.readFileSync(payload.transcriptPath, 'utf8');
  const messages = agyTranscriptToMessages(jsonl);
  const keepMatch = userInput.match(/keep\s+(\d+)/i);
  const defaultPreserve = Number(env.JEV_PRESERVE_RECENT ?? '4');
  const requestedPreserve = keepMatch?.[1] ? Number(keepMatch[1]) : defaultPreserve;
  const preserveRecent = Math.min(requestedPreserve, Math.max(0, messages.length - 3));

  const result = await compact(messages, asker, {
    preserveRecentMessages: preserveRecent,
    keepThreshold: Number(env.JEV_KEEP_THRESHOLD ?? '0.5'),
  });

  const summary = formatAgySessionSummary(result);
  const report = formatAgyCompactionReport(result);
  writeArtifactReport(payload.artifactDirectoryPath, result);
  return buildManualCompactResponse(summary, report);
}

/** Handles automatic threshold-based compaction when minSteps is met. */
async function handleAutoCompact(
  payload: AgyHookInput,
  asker: JevAsker,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const minSteps = Number(env.JEV_MIN_STEPS ?? '20');
  if ((payload.initialNumSteps ?? 0) < minSteps) return '{}';
  if (!payload.transcriptPath || !fs.existsSync(payload.transcriptPath)) return '{}';

  const jsonl = fs.readFileSync(payload.transcriptPath, 'utf8');
  const result = await compactAgyTranscript(jsonl, asker, {
    preserveRecentMessages: Number(env.JEV_PRESERVE_RECENT ?? '6'),
    keepThreshold: Number(env.JEV_KEEP_THRESHOLD ?? '0.5'),
  });

  if (reductionRatio(result) < MIN_AUTO_REDUCTION_RATIO) return '{}';

  writeArtifactReport(payload.artifactDirectoryPath, result);
  return buildInjectionResponse(formatAgyCompactionReport(result));
}

/** Executes the Antigravity PreInvocation hook logic for manual or auto compaction. */
export async function runAgyHook(
  stdinJson: string,
  env: NodeJS.ProcessEnv = process.env,
  customAsker?: JevAsker,
): Promise<string> {
  try {
    const payload = JSON.parse(stdinJson || '{}') as AgyHookInput;
    const apiKey = readApiKey(env);
    if (!apiKey && !customAsker) return '{}';

    const asker = customAsker ?? new JevClient({ apiKey });
    const userInput = (payload.lastUserInput ?? payload.prompt ?? '').trim();

    if (COMPACT_COMMAND_REGEX.test(userInput)) {
      return await handleManualCompact(payload, asker, env);
    }

    return await handleAutoCompact(payload, asker, env);
  } catch {
    return '{}';
  }
}

/** CLI handler for standalone transcript file compaction via --compact-file. */
async function handleCompactFileCommand(args: string[]): Promise<void> {
  const apiKey = readApiKey(process.env);
  if (!apiKey) {
    console.error('Error: TYPESAFE_API_KEY is not set and ~/.typesafe_key was not found.');
    process.exit(1);
  }

  const filePath = args[1];
  if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Error: Transcript file not found: ${filePath}`);
    process.exit(1);
  }

  const jsonl = fs.readFileSync(filePath, 'utf8');
  const result = await compactAgyTranscript(jsonl, new JevClient({ apiKey }));
  console.log(formatAgyCompactionReport(result));

  for (const decision of result.decisions) {
    const scores = `call=${decision.keepCall.toFixed(2)} result=${decision.keepResult.toFixed(2)}`;
    console.log(`  ${decision.id} | ${decision.tool} | ${decision.action} (${decision.reason}) | ${scores}`);
  }

  if (args[2]) {
    fs.writeFileSync(args[2], JSON.stringify(result.messages, null, 2), 'utf8');
    console.log(`Compacted messages written to ${args[2]}`);
  }
}

/** CLI entrypoint orchestrating stdin consumption or command-line dispatch. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--compact-file') {
    await handleCompactFileCommand(args);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks).toString('utf8');
  const output = await runAgyHook(input, process.env);
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
