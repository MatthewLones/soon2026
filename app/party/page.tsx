/**
 * /party — laptop stage. Renders the AI-furnished room with all current
 * players walking around in it. Connects to the relay as host (no avatar,
 * no collision) so the audience-facing big screen never gets a fake host
 * cube wedged into the scene.
 *
 * Query params:
 *   roomId  required — relay's room id (returned by /api/party/start)
 *   host    "1" to connect as host (panic controls, V to ghost-walk)
 */

import { Suspense } from 'react';
import StageClient from './stage-client';

export const dynamic = 'force-dynamic';

export default async function PartyPage({
  searchParams,
}: {
  searchParams: Promise<{ roomId?: string; host?: string }>;
}) {
  const { roomId, host } = await searchParams;
  if (!roomId) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-neutral-900 text-white">
        <div className="rounded-md border border-neutral-700 bg-neutral-800 px-6 py-4 text-sm">
          Missing <code className="font-mono">roomId</code> query param.
        </div>
      </main>
    );
  }
  return (
    <Suspense fallback={null}>
      <StageClient roomId={roomId} host={host === '1'} />
    </Suspense>
  );
}
