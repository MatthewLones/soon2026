/**
 * Returns everything the agent panel needs in one fetch:
 *   - the catalog (everything the agent can place)
 *   - the compact room JSON the agent reads
 *   - the NL summary
 *   - the schema doc (tells the LLM how to interpret the JSON)
 *   - the default role prompt (editable from the panel; sent back via /api/chat)
 *   - active placements
 *   - rough token estimates
 */

import { getSession } from '@/lib/agent/state';
import { COMPACT_ROOM_DOC } from '@/lib/room/serialize';
import { estimateTokens } from '@/lib/room/describe';
import { DEFAULT_ROLE_PROMPT } from '@/lib/agent/loop';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const s = getSession();
  const compactJson = JSON.stringify(s.compact_room);
  return Response.json({
    catalog: s.catalog,
    compactRoom: s.compact_room,
    compactRoomJson: compactJson,
    summary: s.room_summary,
    schemaDoc: COMPACT_ROOM_DOC,
    defaultRolePrompt: DEFAULT_ROLE_PROMPT,
    placements: s.placements,
    // The renderer is in raw RoomPlan world coords; agent state is in
    // floor-centered coords. Add originOffset to convert: world = floor + offset.
    originOffset: s.room.origin_offset,
    tokenEstimates: {
      json: estimateTokens(compactJson),
      summary: estimateTokens(s.room_summary),
      schemaDoc: estimateTokens(COMPACT_ROOM_DOC),
      rolePrompt: estimateTokens(DEFAULT_ROLE_PROMPT),
    },
  });
}
