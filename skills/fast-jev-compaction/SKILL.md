---
name: fast-jev-compaction
description: >
  Verbatim Jev-guided context and transcript compaction using TypeSafe's Jev model.
  Use when asked to compact a conversation transcript, prune stale tool calls/results
  with Jev, or run /fast-jev-compaction.
---

# Fast Jev Compaction

Verbatim context compaction powered by TypeSafe's `jev-latest` model. Instead of
summarizing history (which loses exact paths, errors, and constraints), this
plugin scores every tool call and tool result in the transcript and drops or
truncates stale tool outputs while keeping user and assistant messages verbatim.

## Requirements

Set `TYPESAFE_API_KEY` in your environment or store the key in `~/.typesafe_key`:

```bash
export TYPESAFE_API_KEY="<your-typesafe-api-key>"
# or
echo "<your-typesafe-api-key>" > ~/.typesafe_key
```

## Usage in Antigravity

### 1. Compact an Antigravity Session Transcript (`transcript.jsonl`)

Run the bundled CLI adapter against the current conversation's `transcript.jsonl`:

```bash
npx --prefix ~/.gemini/config/plugins/fast-jev-compaction tsx \
  ~/.gemini/config/plugins/fast-jev-compaction/hooks/agy-hook.ts \
  --compact-file "<path/to/transcript.jsonl>" \
  "<optional/output/compacted-messages.json>"
```

### 2. Run the Live Demo

```bash
cd ~/.gemini/config/plugins/fast-jev-compaction && npm run demo
```

### 3. Programmatic Library Usage (Node.js / TypeScript)

```typescript
import { compactMessages, compactAgyTranscript, reductionRatio } from 'fast-jev-compaction';
```
