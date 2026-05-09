/**
 * PRD §9.7 spike — verify the §9.4 hand-rolled agent loop works against
 * Composio v0.9.0 + Anthropic SDK + a single custom tool.
 *
 * Run: npx tsx scripts/spike-composio.ts
 *
 * Pass criteria:
 *   - Agent receives the SEARCH_FURNITURE tool def
 *   - Agent calls it (we see the tool_call log line BEFORE the loop continues)
 *   - Stub result flows back, agent produces a final assistant message
 *   - Conversation terminates (stop_reason !== 'tool_use')
 */

import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const USER_ID = 'demo_user';
const MODEL = 'claude-sonnet-4-6';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. Set it in .env.local and re-run.`);
    process.exit(1);
  }
  return v;
}

const COMPOSIO_API_KEY = requireEnv('COMPOSIO_API_KEY');
const ANTHROPIC_API_KEY = requireEnv('ANTHROPIC_API_KEY');

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const composio = new Composio({
  apiKey: COMPOSIO_API_KEY,
  provider: new AnthropicProvider(),
});

// Stub catalog for the spike
const STUB_RESULTS = [
  {
    id: 'abo_lounge_chair_walnut',
    name: 'Walnut Lounge Chair',
    price_usd: 480,
    style_tags: ['modern', 'mid-century', 'warm-wood'],
    dimensions: { w: 0.78, d: 0.82, h: 0.84 },
  },
  {
    id: 'abo_floor_lamp_brass',
    name: 'Brass Arc Floor Lamp',
    price_usd: 220,
    style_tags: ['modern', 'brass', 'warm'],
    dimensions: { w: 0.4, d: 1.6, h: 1.9 },
  },
];

async function registerCustomTools() {
  await composio.tools.createCustomTool({
    slug: 'SEARCH_FURNITURE',
    name: 'Search furniture catalog',
    description:
      'Searches the home furniture catalog. Returns up to N items matching the filter. ' +
      'Use this to find candidate items before placing them in the room.',
    inputParams: z.object({
      query: z.string().optional().describe('Free-text query, e.g. "warm wood reading chair"'),
      max_price: z.number().optional().describe('USD upper bound'),
      style_tags: z
        .array(z.string())
        .optional()
        .describe('Any-of match against style_tags, e.g. ["modern","scandi"]'),
      limit: z.number().int().positive().max(20).optional().default(8),
    }),
    execute: async (input) => {
      // Stub: ignore filters and return fixed data.
      return {
        data: { items: STUB_RESULTS, count: STUB_RESULTS.length },
        error: null,
        successful: true,
      };
    },
  });
}

type SseEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'assistant_message'; text: string; t: number };

function emit(event: SseEvent) {
  const tag = `[t+${event.t.toString().padStart(5)}ms]`;
  if (event.type === 'tool_call') {
    console.log(`${tag} → tool_call  ${event.name} (${event.id})`);
    console.log(`         input: ${JSON.stringify(event.input)}`);
  } else if (event.type === 'tool_result') {
    console.log(`${tag} ← tool_result (${event.id})`);
    const preview = JSON.stringify(event.result);
    console.log(`         data:  ${preview.length > 200 ? preview.slice(0, 200) + '…' : preview}`);
  } else {
    console.log(`${tag} ✦ assistant: ${event.text}`);
  }
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

async function runAgentTurn(
  userMessage: string,
  tools: Anthropic.Tool[],
  start: number
): Promise<void> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools,
    messages,
  });

  let safety = 0;
  while (response.stop_reason === 'tool_use') {
    if (++safety > 10) throw new Error('Tool loop exceeded 10 iterations');

    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      emit({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input,
        t: Date.now() - start,
      });

      const result = await composio.tools.execute(block.name, {
        userId: USER_ID,
        arguments: block.input as Record<string, unknown>,
      });

      emit({
        type: 'tool_result',
        id: block.id,
        result: result.data,
        t: Date.now() - start,
      });

      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.data),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools,
      messages,
    });
  }

  emit({
    type: 'assistant_message',
    text: extractText(response),
    t: Date.now() - start,
  });

  console.log(`\nstop_reason: ${response.stop_reason}`);
  console.log(`turns through tool loop: ${safety}`);
}

async function main() {
  const start = Date.now();
  console.log('Spike start: registering custom tool...');
  await registerCustomTools();
  console.log('Custom tool registered. Fetching tool defs in Anthropic format...');

  const tools = (await composio.tools.get(USER_ID, {
    tools: ['SEARCH_FURNITURE'],
  })) as Anthropic.Tool[];

  console.log(`Got ${tools.length} tool def(s):`);
  for (const t of tools) console.log(`  - ${t.name}`);
  console.log('\n--- Starting agent turn ---\n');

  await runAgentTurn(
    "Find me a warm-wood lounge chair and a brass floor lamp under $600 each. Just call the search tool once with sensible filters and tell me what you'd pick.",
    tools,
    start
  );

  console.log(`\nTotal time: ${Date.now() - start}ms`);
  console.log('Spike PASS ✓');
}

main().catch((err) => {
  console.error('\nSpike FAIL ✗');
  console.error(err);
  process.exit(1);
});
