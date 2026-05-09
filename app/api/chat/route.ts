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
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    rolePromptOverride?: string;
  };
  const message = body.message;
  if (!message || typeof message !== 'string') {
    return new Response('Missing or non-string `message`', { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SseEvent) => {
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        await runAgentTurn(message, send, { rolePromptOverride: body.rolePromptOverride });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        const frame = `event: error\ndata: ${JSON.stringify({ message: text })}\n\n`;
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
