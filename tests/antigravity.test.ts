import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgyHook } from '../hooks/agy-hook.ts';
import {
  agyTranscriptToMessages,
  compactAgyTranscript,
  formatAgyCompactionReport,
  formatAgySessionSummary,
} from '../src/antigravity.js';
import type { CompactResult, JevAsker, JevQuestions } from '../src/types.js';

const sampleJsonl = [
  JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    content: '<USER_REQUEST>\nFix the failing test in parser.ts\n</USER_REQUEST>',
  }),
  JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'I will read parser.ts and run tests.',
    tool_calls: [
      { name: 'read_file', args: { Path: '"/repo/src/parser.ts"' } },
      { name: 'run_command', args: { CommandLine: '"npm test"' } },
    ],
  }),
  JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    content: 'export const parse = () => {};\n'.repeat(40),
  }),
  JSON.stringify({
    step_index: 3,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'ERROR',
    content: 'FAIL src/parser.test.ts\n'.repeat(30),
  }),
  JSON.stringify({
    step_index: 4,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Found the issue in parser.ts.',
  }),
  JSON.stringify({
    step_index: 5,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    content: 'Please fix it now.',
  }),
].join('\n');

function fakeAsker(prob: (key: string) => number): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: prob(k) }]),
        ),
      };
    },
  };
}

describe('Antigravity transcript adapter', () => {
  it('converts Antigravity transcript.jsonl lines into paired Message objects', () => {
    const messages = agyTranscriptToMessages(sampleJsonl);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({
      role: 'user',
      text: 'Fix the failing test in parser.ts',
      toolUses: [],
    });
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.toolUses).toHaveLength(2);
    expect(messages[1]?.toolUses[0]?.tool).toBe('read_file');
    expect(messages[1]?.toolUses[1]?.tool).toBe('run_command');
    expect(messages[1]?.toolUses[1]?.isError).toBe(true);
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.toolResults).toHaveLength(2);
    expect(messages[2]?.toolResults?.[0]?.tool_use_id).toBe('agy_step_1_0');
    expect(messages[2]?.toolResults?.[1]?.isError).toBe(true);
  });

  it('compacts an Antigravity transcript using Jev decisions and formats a report', async () => {
    const result = await compactAgyTranscript(
      sampleJsonl,
      fakeAsker((k) => (k.endsWith('t1') ? 0.1 : 0.9)),
      { preserveRecentMessages: 1 },
    );
    expect(result.decisions.map((d) => [d.id, d.action])).toEqual([
      ['t1', 'drop_call'],
      ['t2', 'keep'],
    ]);
    const report = formatAgyCompactionReport(result);
    expect(report).toContain('fast-jev-compaction:');
    expect(report).toContain('1 kept');
    expect(report).toContain('1 call_dropped');

    const sessionSummary = formatAgySessionSummary(result);
    expect(sessionSummary).toContain('# Previous Session Summary');
    expect(sessionSummary).toContain('## Compaction Statistics');
    expect(sessionSummary).toContain('## User Requests');
    expect(sessionSummary).toContain('Fix the failing test in parser.ts');
    expect(sessionSummary).toContain('## Key Tool Interactions');
  });

  it('handles edge cases in transcript parsing and reporting', () => {
    // Malformed JSON and empty lines
    const mixedJsonl = '\n{"type":"UNKNOWN"}\nnot-json\n{"type":"USER_INPUT","content":"Plain question"}\n';
    const messages = agyTranscriptToMessages(mixedJsonl);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: 'user',
      text: 'Plain question',
      toolUses: [],
    });

    // Report with resultsDropped and pinned
    const dummyResult: CompactResult = {
      messages: [],
      decisions: [],
      stats: {
        messagesBefore: 10, messagesAfter: 5, charsBefore: 1000, charsAfter: 500,
        calls: 4, kept: 1, resultsDropped: 1, callsDropped: 1, pinned: 1,
        stateTokens: 120, stateStage: 'verbatim', requests: 1, ms: 15,
      },
    };
    const report = formatAgyCompactionReport(dummyResult);
    expect(report).toContain('50% char reduction');
    expect(report).toContain('1 kept, 1 results truncated, 1 call_dropped, 1 pinned');
  });

  it('returns {} without error when apiKey is missing or input is empty/invalid', async () => {
    const out1 = await runAgyHook('{}', {});
    expect(JSON.parse(out1)).toEqual({});

    const out2 = await runAgyHook('invalid json', {});
    expect(JSON.parse(out2)).toEqual({});

    const out3 = await runAgyHook(JSON.stringify({ transcriptPath: '/nonexistent/file.jsonl' }), {
      TYPESAFE_API_KEY: 'test-key',
    });
    expect(JSON.parse(out3)).toEqual({});
  });

  it('returns {} when initialNumSteps is below minimum threshold', async () => {
    const out = await runAgyHook(
      JSON.stringify({ transcriptPath: '/tmp/test.jsonl', initialNumSteps: 5 }),
      { TYPESAFE_API_KEY: 'test-key', JEV_MIN_STEPS: '20' },
    );
    expect(JSON.parse(out)).toEqual({});
  });

  it('injects user_markdown notice and writes artifact on successful compaction', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hook-test-'));
    const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptFile, sampleJsonl, 'utf8');

    const fakeAsker: JevAsker = {
      async ask() {
        return {
          answers: {
            call_t1: { type: 'noul' as const, noul: 0.1 }, result_t1: { type: 'noul' as const, noul: 0.1 },
            call_t2: { type: 'noul' as const, noul: 0.9 }, result_t2: { type: 'noul' as const, noul: 0.9 },
          },
        };
      },
    };

    const payload = {
      conversationId: 'test-conv', transcriptPath: transcriptFile,
      artifactDirectoryPath: tmpDir, initialNumSteps: 25,
    };

    const outStr = await runAgyHook(
      JSON.stringify(payload),
      { TYPESAFE_API_KEY: 'mock', JEV_PRESERVE_RECENT: '1' },
      fakeAsker,
    );
    const parsed = JSON.parse(outStr) as { injectSteps?: Array<{ systemMessage?: { metadata?: { user_markdown?: string } } }> };
    expect(parsed.injectSteps).toBeDefined();
    expect(parsed.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown).toContain('fast-jev-compaction:');

    const artifactPath = path.join(tmpDir, 'jev-compacted-context.json');
    expect(fs.existsSync(artifactPath)).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
