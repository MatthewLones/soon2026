'use client';

/**
 * 3D overlay that visualises the semantic tree on top of the raw scan:
 *   - Compartment AABBs (color-cycled, room id label).
 *   - Wall labels with facing, length, and max free span (placeable walls
 *     in the room color; non-placeable greyed out).
 *   - Free-span line markers stretched along the wall axis at floor level.
 *   - Object / placement footprint halos with side-clearance arrows.
 *
 * Hover sync: hovering an element here lifts the node id up to the parent
 * via `onNodeHover`; hovering a row in the tree panel highlights the same
 * element fuchsia. The overlay sits inside the same group as walls/floors
 * so it picks up rotation + centering automatically.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { RoomPlanRaw } from '@/lib/roomplan';
import type { Vec3 } from '@/lib/room/normalize';
import type { Placement } from '@/lib/room/grid';
import type {
  ObjectNode,
  SemanticRoom,
  SemanticTree,
  WallNode,
} from '@/lib/room/semantic_tree';

const ROOM_COLORS = [
  '#22d3ee', // cyan-400
  '#a78bfa', // violet-400
  '#f472b6', // pink-400
  '#fb923c', // orange-400
  '#34d399', // emerald-400
  '#facc15', // yellow-400
  '#f87171', // red-400
];

const HOVER = '#e879f9'; // fuchsia-400

type Props = {
  tree: SemanticTree;
  room: RoomPlanRaw;
  placements: Placement[];
  originOffset?: Vec3;
  floorY: number;
  ceilingHeight: number;
  hoveredNodeId: string | null;
  onNodeHover?: (id: string | null) => void;
};

export default function TreeDebugOverlay({
  tree,
  room,
  placements,
  originOffset,
  floorY,
  ceilingHeight,
  hoveredNodeId,
  onNodeHover,
}: Props) {
  const offX = originOffset?.x ?? 0;
  const offZ = originOffset?.z ?? 0;
  const offY = originOffset?.y ?? 0;

  // Build lookup tables from raw → tree id space. Tree wall id is
  // `wall_${rawIdentifier.slice(0,8).toLowerCase()}` — see normalize.ts:147.
  const wallByTreeId = useMemo(() => {
    const m = new Map<string, RoomPlanRaw['walls'][number]>();
    for (const w of room.walls) {
      const id = `wall_${w.identifier.slice(0, 8).toLowerCase()}`;
      m.set(id, w);
    }
    return m;
  }, [room.walls]);

  const objectByTreeId = useMemo(() => {
    const m = new Map<string, RoomPlanRaw['objects'][number]>();
    for (const o of room.objects) {
      // objects use the category prefix in normalize.ts (categoryOf), but the
      // raw object only knows itself — we just match by identifier suffix.
      m.set(o.identifier.slice(0, 8).toLowerCase(), o);
    }
    return m;
  }, [room.objects]);

  const placementByTreeId = useMemo(() => {
    const m = new Map<string, Placement>();
    for (const p of placements) m.set(p.id, p);
    return m;
  }, [placements]);

  return (
    <group>
      {tree.building.rooms.map((r, idx) => (
        <RoomLayer
          key={r.id}
          room={r}
          color={ROOM_COLORS[idx % ROOM_COLORS.length]}
          offset={{ x: offX, y: offY, z: offZ }}
          floorY={floorY}
          ceilingHeight={ceilingHeight}
          hoveredNodeId={hoveredNodeId}
          onNodeHover={onNodeHover}
          wallByTreeId={wallByTreeId}
          objectByTreeId={objectByTreeId}
          placementByTreeId={placementByTreeId}
        />
      ))}
    </group>
  );
}

function RoomLayer({
  room,
  color,
  offset,
  floorY,
  ceilingHeight,
  hoveredNodeId,
  onNodeHover,
  wallByTreeId,
  objectByTreeId,
  placementByTreeId,
}: {
  room: SemanticRoom;
  color: string;
  offset: { x: number; y: number; z: number };
  floorY: number;
  ceilingHeight: number;
  hoveredNodeId: string | null;
  onNodeHover?: (id: string | null) => void;
  wallByTreeId: Map<string, RoomPlanRaw['walls'][number]>;
  objectByTreeId: Map<string, RoomPlanRaw['objects'][number]>;
  placementByTreeId: Map<string, Placement>;
}) {
  const isHovered = hoveredNodeId === room.id;
  // Compartment AABB in world coords.
  const minX = room.bounds.min.x + offset.x;
  const maxX = room.bounds.max.x + offset.x;
  const minZ = room.bounds.min.z + offset.z;
  const maxZ = room.bounds.max.z + offset.z;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  return (
    <group>
      {/* Filled polygon footprint on the floor (the actual flood-fill outline) */}
      {room.polygon.length >= 3 && (
        <RoomPolygonFloor
          polygon={room.polygon}
          offsetX={offset.x}
          offsetZ={offset.z}
          floorY={floorY}
          color={isHovered ? HOVER : color}
          onPointerOver={() => onNodeHover?.(room.id)}
          onPointerOut={() => onNodeHover?.(null)}
        />
      )}

      {/* Compartment AABB wireframe (still useful for "how big is the bbox") */}
      <CompartmentWire
        minX={minX}
        maxX={maxX}
        minZ={minZ}
        maxZ={maxZ}
        floorY={floorY}
        height={ceilingHeight}
        color={isHovered ? HOVER : color}
        onPointerOver={() => onNodeHover?.(room.id)}
        onPointerOut={() => onNodeHover?.(null)}
      />

      {/* Room id label, hovering at ceiling height */}
      <Html
        position={[cx, floorY + ceilingHeight - 0.1, cz]}
        center
        occlude={false}
        zIndexRange={[40, 0]}
      >
        <div
          onMouseEnter={() => onNodeHover?.(room.id)}
          onMouseLeave={() => onNodeHover?.(null)}
          className={`pointer-events-auto cursor-default whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-semibold shadow ${
            isHovered ? 'bg-fuchsia-500 text-white' : 'text-neutral-900'
          }`}
          style={!isHovered ? { backgroundColor: color } : undefined}
        >
          {room.id} · {room.area_m2} m²
        </div>
      </Html>

      {room.walls.map((w) => (
        <WallAnnotation
          key={`${room.id}-${w.id}`}
          wall={w}
          rawWall={wallByTreeId.get(w.id)}
          floorY={floorY}
          color={color}
          hoveredNodeId={hoveredNodeId}
          onNodeHover={onNodeHover}
        />
      ))}

      {room.objects.map((o) => (
        <ObjectAnnotation
          key={`${room.id}-${o.id}`}
          obj={o}
          rawObj={lookupRawObject(objectByTreeId, o.id)}
          placement={null}
          offset={offset}
          floorY={floorY}
          color={color}
          hoveredNodeId={hoveredNodeId}
          onNodeHover={onNodeHover}
        />
      ))}
      {room.placements.map((o) => (
        <ObjectAnnotation
          key={`${room.id}-${o.id}`}
          obj={o}
          rawObj={undefined}
          placement={placementByTreeId.get(o.id) ?? null}
          offset={offset}
          floorY={floorY}
          color={color}
          hoveredNodeId={hoveredNodeId}
          onNodeHover={onNodeHover}
        />
      ))}
    </group>
  );
}

function lookupRawObject(
  map: Map<string, RoomPlanRaw['objects'][number]>,
  treeId: string
): RoomPlanRaw['objects'][number] | undefined {
  // Tree object id format: `${category}_${identifier.slice(0,8)}` from
  // normalize.ts:147 — the suffix after the underscore is what we keyed by.
  const idx = treeId.lastIndexOf('_');
  if (idx === -1) return undefined;
  return map.get(treeId.slice(idx + 1));
}

// ---------- Room polygon (filled triangulated shape) ----------

function RoomPolygonFloor({
  polygon,
  offsetX,
  offsetZ,
  floorY,
  color,
  onPointerOver,
  onPointerOut,
}: {
  polygon: { x: number; z: number }[];
  offsetX: number;
  offsetZ: number;
  floorY: number;
  color: string;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
}) {
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    if (polygon.length === 0) return s;
    s.moveTo(polygon[0].x + offsetX, polygon[0].z + offsetZ);
    for (let i = 1; i < polygon.length; i++) {
      s.lineTo(polygon[i].x + offsetX, polygon[i].z + offsetZ);
    }
    s.closePath();
    return s;
  }, [polygon, offsetX, offsetZ]);

  const geometry = useMemo(() => {
    const g = new THREE.ShapeGeometry(shape);
    // Default ShapeGeometry sits in the XY plane; rotate so it lies on the
    // XZ floor plane.
    g.rotateX(Math.PI / 2);
    return g;
  }, [shape]);

  return (
    <mesh
      geometry={geometry}
      position={[0, floorY + 0.02, 0]}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <meshBasicMaterial color={color} transparent opacity={0.18} side={THREE.DoubleSide} />
    </mesh>
  );
}

// ---------- Compartment wireframe (line segments) ----------

function CompartmentWire({
  minX,
  maxX,
  minZ,
  maxZ,
  floorY,
  height,
  color,
  onPointerOver,
  onPointerOut,
}: {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorY: number;
  height: number;
  color: string;
  onPointerOver?: () => void;
  onPointerOut?: () => void;
}) {
  const positions = useMemo(() => {
    const yLo = floorY + 0.005;
    const yHi = floorY + height - 0.05;
    const c = [
      [minX, yLo, minZ],
      [maxX, yLo, minZ],
      [maxX, yLo, maxZ],
      [minX, yLo, maxZ],
      [minX, yHi, minZ],
      [maxX, yHi, minZ],
      [maxX, yHi, maxZ],
      [minX, yHi, maxZ],
    ];
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const arr: number[] = [];
    for (const [a, b] of edges) arr.push(...c[a], ...c[b]);
    return new Float32Array(arr);
  }, [minX, maxX, minZ, maxZ, floorY, height]);

  return (
    <lineSegments onPointerOver={onPointerOver} onPointerOut={onPointerOut}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
          count={positions.length / 3}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.85} />
    </lineSegments>
  );
}

// ---------- Wall annotation ----------

function WallAnnotation({
  wall,
  rawWall,
  floorY,
  color,
  hoveredNodeId,
  onNodeHover,
}: {
  wall: WallNode;
  rawWall: RoomPlanRaw['walls'][number] | undefined;
  floorY: number;
  color: string;
  hoveredNodeId: string | null;
  onNodeHover?: (id: string | null) => void;
}) {
  if (!rawWall) return null;
  const isHovered = hoveredNodeId === wall.id;
  const pos = decomposeWall(rawWall.transform);
  const yaw = pos.yaw;
  const half = wall.length_m / 2;
  const cx = pos.x;
  const cz = pos.z;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const p0 = new THREE.Vector3(cx - cosY * half, floorY + 0.04, cz - sinY * half);
  const p1 = new THREE.Vector3(cx + cosY * half, floorY + 0.04, cz + sinY * half);

  // Free-span markers along the wall axis. start_m / end_m are along the
  // axis from p0 → p1, so the world segment is p0 + t * unit(p1-p0).
  const axisDir = new THREE.Vector3().subVectors(p1, p0).setY(0).normalize();
  const spanSegments = useMemo(() => {
    const out: number[] = [];
    for (const span of wall.free_spans) {
      const a = new THREE.Vector3().copy(p0).addScaledVector(axisDir, span.start_m);
      const b = new THREE.Vector3().copy(p0).addScaledVector(axisDir, span.end_m);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    return new Float32Array(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall.free_spans, p0.x, p0.z, p1.x, p1.z, floorY]);

  const labelColor = !wall.placeable
    ? '#9ca3af' // grey
    : isHovered
    ? HOVER
    : color;

  return (
    <group
      onPointerOver={() => onNodeHover?.(wall.id)}
      onPointerOut={() => onNodeHover?.(null)}
    >
      {/* Wall axis line at floor level (helps see id placement in walk view) */}
      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[new Float32Array([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z]), 3]}
            count={2}
            array={new Float32Array([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z])}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={labelColor} transparent opacity={isHovered ? 1 : 0.5} />
      </line>

      {/* Free-span highlights — fatter line at the same level as the axis */}
      {wall.free_spans.length > 0 && (
        <lineSegments position={[0, 0.005, 0]}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[spanSegments, 3]}
              count={spanSegments.length / 3}
              array={spanSegments}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial color={isHovered ? HOVER : '#10b981'} linewidth={3} />
        </lineSegments>
      )}

      <Html
        position={[cx, floorY + 1.4, cz]}
        center
        occlude={false}
        zIndexRange={[30, 0]}
      >
        <div
          onMouseEnter={() => onNodeHover?.(wall.id)}
          onMouseLeave={() => onNodeHover?.(null)}
          className={`pointer-events-auto cursor-default whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-mono shadow ${
            isHovered
              ? 'bg-fuchsia-500 text-white'
              : wall.placeable
              ? 'bg-white/95 text-neutral-800'
              : 'bg-neutral-300/85 text-neutral-500 line-through'
          }`}
          style={{ borderLeft: `3px solid ${labelColor}` }}
        >
          {wall.id} · {wall.facing} · {wall.length_m}m
        </div>
      </Html>
    </group>
  );
}

function decomposeWall(transform: number[]): { x: number; y: number; z: number; yaw: number } {
  // Mirrors lib/room/normalize.ts:positionOf + yawOf.
  return {
    x: transform[12],
    y: transform[13],
    z: transform[14],
    yaw: Math.atan2(transform[2], transform[0]),
  };
}

// ---------- Object / placement annotation ----------

function ObjectAnnotation({
  obj,
  rawObj,
  placement,
  offset,
  floorY,
  color,
  hoveredNodeId,
  onNodeHover,
}: {
  obj: ObjectNode;
  rawObj: RoomPlanRaw['objects'][number] | undefined;
  placement: Placement | null;
  offset: { x: number; y: number; z: number };
  floorY: number;
  color: string;
  hoveredNodeId: string | null;
  onNodeHover?: (id: string | null) => void;
}) {
  // Resolve world position. Raw detected objects bring their own transform
  // (raw RoomPlan world coords). Placements come from the agent's session in
  // floor-centered coords — convert via originOffset.
  let worldX: number;
  let worldZ: number;
  let yaw: number;
  if (rawObj) {
    const p = decomposeWall(rawObj.transform);
    worldX = p.x;
    worldZ = p.z;
    yaw = p.yaw;
  } else if (placement) {
    worldX = placement.position.x + offset.x;
    worldZ = placement.position.z + offset.z;
    yaw = placement.rotation_y;
  } else {
    return null;
  }

  const isHovered = hoveredNodeId === obj.id;
  const w = obj.dimensions.w;
  const d = obj.dimensions.d;
  const half = floorY + 0.03;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  // Footprint rectangle on the floor.
  const corners = useMemo(() => {
    const local = [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ];
    return local.map(([lx, lz]) => ({
      x: worldX + cosY * lx - sinY * lz,
      z: worldZ + sinY * lx + cosY * lz,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, d, worldX, worldZ, yaw]);

  const footprintArr = useMemo(() => {
    const arr: number[] = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      arr.push(a.x, half, a.z, b.x, half, b.z);
    }
    return new Float32Array(arr);
  }, [corners, half]);

  // Side-clearance arrow lines: from each side mid-point outward by free_space_around[side].
  const clearanceArr = useMemo(() => {
    const arr: number[] = [];
    const pushSeg = (lx: number, lz: number, dx: number, dz: number, m: number) => {
      const startX = worldX + cosY * lx - sinY * lz;
      const startZ = worldZ + sinY * lx + cosY * lz;
      // direction in world = rotate (dx, dz) by yaw
      const wx = cosY * dx - sinY * dz;
      const wz = sinY * dx + cosY * dz;
      const endX = startX + wx * Math.min(m, 2.5);
      const endZ = startZ + wz * Math.min(m, 2.5);
      arr.push(startX, half + 0.02, startZ, endX, half + 0.02, endZ);
    };
    pushSeg(0, d / 2, 0, 1, obj.free_space_around.front_m);
    pushSeg(0, -d / 2, 0, -1, obj.free_space_around.back_m);
    pushSeg(w / 2, 0, 1, 0, obj.free_space_around.right_m);
    pushSeg(-w / 2, 0, -1, 0, obj.free_space_around.left_m);
    return new Float32Array(arr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, d, worldX, worldZ, yaw, obj.free_space_around.front_m, obj.free_space_around.back_m, obj.free_space_around.left_m, obj.free_space_around.right_m]);

  return (
    <group
      onPointerOver={() => onNodeHover?.(obj.id)}
      onPointerOut={() => onNodeHover?.(null)}
    >
      {/* Footprint outline */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[footprintArr, 3]}
            count={footprintArr.length / 3}
            array={footprintArr}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={isHovered ? HOVER : color} transparent opacity={0.95} />
      </lineSegments>

      {/* Side-clearance arrows */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[clearanceArr, 3]}
            count={clearanceArr.length / 3}
            array={clearanceArr}
            itemSize={3}
          />
        </bufferGeometry>
        <lineBasicMaterial color={isHovered ? HOVER : '#fbbf24'} transparent opacity={0.85} />
      </lineSegments>

      <Html
        position={[worldX, half + 0.6, worldZ]}
        center
        occlude={false}
        zIndexRange={[30, 0]}
      >
        <div
          onMouseEnter={() => onNodeHover?.(obj.id)}
          onMouseLeave={() => onNodeHover?.(null)}
          className={`pointer-events-auto cursor-default whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-mono shadow ${
            isHovered ? 'bg-fuchsia-500 text-white' : 'bg-white/95 text-neutral-800'
          }`}
          style={{ borderLeft: `3px solid ${isHovered ? HOVER : color}` }}
        >
          {obj.id} · {obj.category}
        </div>
      </Html>
    </group>
  );
}
