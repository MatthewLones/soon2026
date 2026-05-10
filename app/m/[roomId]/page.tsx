/**
 * /m/[roomId] — phone landing page. Wraps the state-machine client.
 * The roomId comes straight off the QR.
 */

import MobileClient from './mobile-client';

export const dynamic = 'force-dynamic';

export default async function MobileRoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <MobileClient roomId={roomId} />;
}
