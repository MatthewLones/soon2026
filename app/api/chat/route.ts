/**
 * SSE chat endpoint. Streams `tool_call`, `tool_result`, `assistant_message`,
 * and `loop_aborted` events as they happen during the hand-rolled agent loop
 * (PRD §11.4).
 *
 * Body: { message: string }
 * Response: text/event-stream with `event: <type>\ndata: <json>\n\n` frames.
 */

import { runAgentTurn, type SseEvent } from '@/lib/agent/loop';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  console.log('[chat/route] POST received');
  const body = (await req.json().catch((e) => {
    console.error('[chat/route] Failed to parse request body:', e);
    return {};
  })) as {
    message?: string;
    rolePromptOverride?: string;
    model?: 'sonnet' | 'opus';
    thinkingBudget?: number;
    maxToolIterations?: number;
  };
  const message = body.message;
  console.log('[chat/route] message:', message?.slice(0, 120), '...');
  if (!message || typeof message !== 'string') {
    console.error('[chat/route] Rejected — missing or non-string message');
    return new Response('Missing or non-string `message`', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SseEvent) => {
        console.log(`[chat/route] SSE → ${event.type}`, 'name' in event ? (event as { name: string }).name : '');
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        console.log('[chat/route] Starting agent turn…');
        const result = await runAgentTurn(message, send, {
          rolePromptOverride: body.rolePromptOverride,
          model: body.model,
          thinkingBudget: body.thinkingBudget,
          maxToolIterations: body.maxToolIterations,
        });
        console.log('[chat/route] Agent turn completed:', result);
      } catch (err) {
        const text = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        console.error('[chat/route] Agent turn THREW:', text);
        const frame = `event: error\ndata: ${JSON.stringify({ type: 'error', message: text })}\n\n`;
        controller.enqueue(encoder.encode(frame));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
