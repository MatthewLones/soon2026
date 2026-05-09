'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RoomPlanRaw } from '@/lib/roomplan';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { CompactRoom } from '@/lib/room/serialize';
import type { Vec3 } from '@/lib/room/normalize';
import type { Placement } from '@/lib/room/grid';
import ScanCanvas from './scan-canvas';
import AgentPanel from './panel';

export type AgentContext = {
  catalog: CatalogItem[];
  compactRoom: CompactRoom;
  compactRoomJson: string;
  summary: string;
  schemaDoc: string;
  defaultRolePrompt: string;
  placements: Placement[];
  originOffset: Vec3;
  tokenEstimates: {
    json: number;
    summary: number;
    schemaDoc: number;
    rolePrompt: number;
  };
};

export default function ScanLayout({
  room,
  splatUrl,
}: {
  room: RoomPlanRaw;
  splatUrl?: string;
}) {
  const [ctx, setCtx] = useState<AgentContext | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-context', { cache: 'no-store' });
      setCtx((await r.json()) as AgentContext);
    } catch (e) {
      console.error('agent-context fetch failed', e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-[#dad3c5]">
      <div className="relative min-w-0 flex-1">
        <ScanCanvas
          room={room}
          splatUrl={splatUrl}
          placements={ctx?.placements ?? []}
          catalog={ctx?.catalog ?? []}
          originOffset={ctx?.originOffset}
        />
      </div>
      <AgentPanel ctx={ctx} onRefresh={refresh} />
    </main>
  );
}
