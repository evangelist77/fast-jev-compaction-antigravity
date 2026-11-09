import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgyHook } from '../hooks/agy-hook.ts';
import type { JevAsker, JevQuestions } from '../src/types.js';

/** Expected structure of a system message injected step. */
interface SystemMessageStep {
  systemMessage?: {
    systemMessage?: string;
    metadata?: {
      user_markdown?: string;
    };
  };
}

/** Expected output format from Antigravity PreInvocation hook. */
interface PreInvocationResult {
  injectSteps?: SystemMessageStep[];
  terminationBehavior?: string;
}

/** Input payload passed to the Antigravity PreInvocation hook. */
interface HookTestPayload {
  conversationId?: string;
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  lastUserInput?: string;
}

/**
 * Creates a mock JevAsker with deterministic probability scoring.
 */
function createMockAsker(scorer: (key: string) => number): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: scorer(key) }]),
        ),
      };
    },
  };
}

/**
 * Generates sample transcript JSONL content with user requests and tool executions.
 */
function createSampleTranscriptJsonl(): string {
  return [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nFix parser errors\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Running tests.', tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'export const parse = () => true;\n'.repeat(25) }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', content: 'FAIL: syntax error\n'.repeat(20) }),
  ].join('\n');
}

/**
 * Executes runAgyHook with the provided payload and returns parsed JSON.
 */
async function executeHook(
  payload: HookTestPayload,
  env: NodeJS.ProcessEnv = {},
  asker?: JevAsker,
): Promise<PreInvocationResult> {
  const output = await runAgyHook(JSON.stringify(payload), env, asker);
  return JSON.parse(output) as PreInvocationResult;
}

describe('Antigravity /compact hook interception', () => {
  let tempDirectory: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-compact-test-'));
    transcriptPath = path.join(tempDirectory, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, createSampleTranscriptJsonl(), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('injects compacted session summary and terminates when lastUserInput is "/compact"', async () => {
    const mockAsker = createMockAsker(() => 0.1);
    const parsed = await executeHook(
      { conversationId: 'c1', transcriptPath, artifactDirectoryPath: tempDirectory, lastUserInput: '/compact' },
      { TYPESAFE_API_KEY: 'test-key' },
      mockAsker,
    );

    expect(parsed.terminationBehavior).toBe('terminate');
    expect(parsed.injectSteps).toHaveLength(1);
    expect(typeof parsed.injectSteps?.[0]?.systemMessage?.systemMessage).toBe('string');
    expect(parsed.injectSteps?.[0]?.systemMessage?.systemMessage?.length).toBeGreaterThan(0);
    expect(parsed.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown).toContain('Fast Jev Compaction Complete');
  });

  it('handles "/compact" with additional user arguments', async () => {
    const mockAsker = createMockAsker(() => 0.1);
    const parsed = await executeHook(
      { conversationId: 'c2', transcriptPath, artifactDirectoryPath: tempDirectory, lastUserInput: '/compact keep 3 turns' },
      { TYPESAFE_API_KEY: 'test-key' },
      mockAsker,
    );

    expect(parsed.terminationBehavior).toBe('terminate');
    expect(typeof parsed.injectSteps?.[0]?.systemMessage?.systemMessage).toBe('string');
    expect(parsed.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown).toContain('Fast Jev Compaction Complete');
  });

  it('returns empty object {} when lastUserInput is regular text', async () => {
    const mockAsker = createMockAsker(() => 0.1);
    const parsed = await executeHook(
      { conversationId: 'c3', transcriptPath, initialNumSteps: 5, lastUserInput: 'hello world' },
      { TYPESAFE_API_KEY: 'test-key' },
      mockAsker,
    );

    expect(parsed).toEqual({});
  });

  it('returns empty object {} when user input contains "/compact" but does not start with it', async () => {
    const mockAsker = createMockAsker(() => 0.1);
    const parsed = await executeHook(
      { conversationId: 'c4', transcriptPath, initialNumSteps: 5, lastUserInput: 'explain /compact' },
      { TYPESAFE_API_KEY: 'test-key' },
      mockAsker,
    );

    expect(parsed).toEqual({});
  });

  it('returns empty object {} gracefully when Jev API throws an error', async () => {
    const failingAsker: JevAsker = {
      async ask() { throw new Error('Jev API service unavailable'); },
    };
    const parsed = await executeHook(
      { conversationId: 'c5', transcriptPath, lastUserInput: '/compact' },
      { TYPESAFE_API_KEY: 'test-key' },
      failingAsker,
    );

    expect(parsed).toEqual({});
  });

  it('returns empty object {} gracefully when API key is missing and no asker is provided', async () => {
    const parsed = await executeHook(
      { conversationId: 'c6', transcriptPath, lastUserInput: '/compact' },
      {},
    );
    expect(parsed).toEqual({});
  });

  it('returns empty object {} when transcript file does not exist', async () => {
    const mockAsker = createMockAsker(() => 0.1);
    const parsed = await executeHook(
      { conversationId: 'c7', transcriptPath: path.join(tempDirectory, 'missing.jsonl'), lastUserInput: '/compact' },
      { TYPESAFE_API_KEY: 'test-key' },
      mockAsker,
    );

    expect(parsed).toEqual({});
  });
});
