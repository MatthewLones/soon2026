/**
 * Compact serialization of a normalized Room for the agent's system prompt.
 *
 * The JS schema (normalize.ts) keeps explicit fields for code readability;
 * the LLM-facing form drops defaults to save tokens. The agent system prompt
 * documents this shape inline so the model can read it.
 */

import type {
  Room,
  NormalizedWall,
  NormalizedSurface,
  NormalizedObject,
  NormalizedRegion,
  Vec2,
  Vec3,
} from './normalize';

type CompactWall = {
  id: string;
  pos: [number, number, number];
  yaw: number;
  heading: string;
  dim: [number, number];
  curve?: [number, number, number];
  poly?: Array<[number, number]>;
  conf?: 'low' | 'medium'; // omitted when high
};

type CompactSurface = {
  id: string;
  type: 'door' | 'window' | 'opening';
  parent: string | null;
  pos: [number, number, number];
  yaw: number;
  dim: [number, number];
  conf?: 'low' | 'medium';
};

type CompactObject = {
  id: string;
  cat: string;
  pos: [number, number];
  yaw: number;
  dim: [number, number, number]; // [w, d, h]
  conf?: 'low' | 'medium';
  attr?: string[];
  decision?: 'remove' | 'ignore'; // omitted when keep
};

type CompactRegion = {
  id: string;
  label: string;
  c: [number, number];
};

export type CompactRoom = {
  id: string;
  dim: [number, number, number]; // [width, depth, height]
  floor: Array<[number, number]>;
  walls: CompactWall[];
  doors?: CompactSurface[];
  windows?: CompactSurface[];
  openings?: CompactSurface[];
  objects?: CompactObject[];
  regions?: CompactRegion[];
};

const t2 = (v: Vec2): [number, number] => [v.x, v.z];
const t3 = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];

function compactWall(w: NormalizedWall): CompactWall {
  const out: CompactWall = {
    id: w.id,
    pos: t3(w.position),
    yaw: w.rotation_y,
    heading: w.heading,
    dim: [w.dimensions.w, w.dimensions.h],
  };
  if (w.curve) out.curve = [w.curve.radius, w.curve.start_angle, w.curve.end_angle];
  if (w.polygon_corners) out.poly = w.polygon_corners.map(t2);
  if (w.confidence !== 'high') out.conf = w.confidence;
  return out;
}

function compactSurface(s: NormalizedSurface): CompactSurface {
  const out: CompactSurface = {
    id: s.id,
    type: s.type,
    parent: s.parent_wall_id,
    pos: t3(s.position),
    yaw: s.rotation_y,
    dim: [s.dimensions.w, s.dimensions.h],
  };
  if (s.confidence !== 'high') out.conf = s.confidence;
  return out;
}

function compactObject(o: NormalizedObject): CompactObject {
  const out: CompactObject = {
    id: o.id,
    cat: o.category,
    pos: [o.position.x, o.position.z],
    yaw: o.rotation_y,
    dim: [o.dimensions.w, o.dimensions.d, o.dimensions.h],
  };
  if (o.confidence !== 'high') out.conf = o.confidence;
  if (o.attributes.length > 0) out.attr = o.attributes;
  if (o.user_decision !== 'keep') out.decision = o.user_decision;
  return out;
}

function compactRegion(r: NormalizedRegion): CompactRegion {
  return { id: r.id, label: r.label, c: [r.center.x, r.center.z] };
}

export function compactRoom(room: Room): CompactRoom {
  const out: CompactRoom = {
    id: room.id,
    dim: [room.dimensions.width, room.dimensions.depth, room.dimensions.height],
    floor: room.floor_polygon.map(t2),
    walls: room.walls.map(compactWall),
  };
  if (room.doors.length > 0) out.doors = room.doors.map(compactSurface);
  if (room.windows.length > 0) out.windows = room.windows.map(compactSurface);
  if (room.openings.length > 0) out.openings = room.openings.map(compactSurface);
  if (room.detected_objects.length > 0)
    out.objects = room.detected_objects.map(compactObject);
  if (room.regions.length > 0) out.regions = room.regions.map(compactRegion);
  return out;
}

/** Doc string the agent sees alongside the JSON, telling it what shape to expect. */
export const COMPACT_ROOM_DOC = `
Room schema (compact, all numbers in meters, floor-centered coords):
  dim: [width, depth, height]
  floor: array of [x, z] polygon corners (CCW)
  walls[]: { id, pos:[x,y,z], yaw (radians), heading: N|NE|E|SE|S|SW|W|NW (outward),
             dim:[w,h], curve?:[r,start,end], poly?:[[x,z]...], conf?:low|medium }
  doors[]/windows[]/openings[]: { id, type, parent: wall_id|null, pos:[x,y,z], yaw, dim:[w,h] }
  objects[]: { id, cat, pos:[x,z], yaw, dim:[w,d,h], attr?:[strings], decision?:remove|ignore }
  regions[]: { id, label, c:[x,z] }
Defaults omitted: conf:"high", decision:"keep". Use ids exactly as given.
`.trim();
