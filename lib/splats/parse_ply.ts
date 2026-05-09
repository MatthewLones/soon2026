/**
 * Minimal PLY parser for 3D Gaussian Splatting files.
 *
 * Standard 3DGS PLY (INRIA / gsplat / Brush output) contains one element 'vertex'
 * with these float properties (in some order):
 *   x, y, z                    — position
 *   nx, ny, nz                 — normal (often zero, present for PLY validity)
 *   f_dc_0, f_dc_1, f_dc_2     — DC SH coefs (base color)
 *   f_rest_0..f_rest_44        — higher-order SH (optional, varies by SH degree)
 *   opacity                    — pre-sigmoid log-odds
 *   scale_0, scale_1, scale_2  — log-scales (post-exp = world meters)
 *   rot_0, rot_1, rot_2, rot_3 — quaternion (w, x, y, z order in INRIA convention)
 *
 * Format is binary_little_endian for any nontrivial scene; ascii is rare but supported.
 *
 * The parser keeps each vertex's raw bytes alongside parsed numerics so we can write
 * a filtered subset back without re-encoding the SH coefficients.
 */

export type PlyProperty = {
  name: string;
  type: 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
  byteSize: number;
};

export type PlyHeader = {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  vertexCount: number;
  properties: PlyProperty[];
  vertexByteSize: number;
  propertyOffsets: Map<string, number>;
  headerByteLength: number;
};

const TYPE_SIZES: Record<PlyProperty['type'], number> = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8,
};

function normalizeType(t: string): PlyProperty['type'] {
  const map: Record<string, PlyProperty['type']> = {
    char: 'char', int8: 'char',
    uchar: 'uchar', uint8: 'uchar',
    short: 'short', int16: 'short',
    ushort: 'ushort', uint16: 'ushort',
    int: 'int', int32: 'int',
    uint: 'uint', uint32: 'uint',
    float: 'float', float32: 'float',
    double: 'double', float64: 'double',
  };
  const norm = map[t];
  if (!norm) throw new Error(`Unsupported PLY property type: ${t}`);
  return norm;
}

export function parsePlyHeader(buffer: Uint8Array): PlyHeader {
  // Find "end_header\n"
  const decoder = new TextDecoder('ascii');
  const headerEndMarker = 'end_header\n';
  let headerEnd = -1;
  // Linear scan over up to first 64 KB — headers are tiny.
  const scanLimit = Math.min(buffer.byteLength, 65536);
  const headerSlice = decoder.decode(buffer.subarray(0, scanLimit));
  const idx = headerSlice.indexOf(headerEndMarker);
  if (idx < 0) throw new Error('PLY: end_header not found in first 64 KB');
  headerEnd = idx + headerEndMarker.length;

  const headerText = headerSlice.slice(0, headerEnd);
  const lines = headerText.split('\n').map((s) => s.trim()).filter(Boolean);

  if (lines[0] !== 'ply') throw new Error('PLY: missing "ply" magic');

  let format: PlyHeader['format'] = 'ascii';
  let vertexCount = 0;
  const properties: PlyProperty[] = [];
  let inVertexElement = false;

  for (const line of lines.slice(1)) {
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'format') {
      const f = tokens[1];
      if (f === 'ascii' || f === 'binary_little_endian' || f === 'binary_big_endian') {
        format = f;
      } else {
        throw new Error(`PLY: unknown format ${f}`);
      }
    } else if (tokens[0] === 'element') {
      inVertexElement = tokens[1] === 'vertex';
      if (inVertexElement) vertexCount = parseInt(tokens[2], 10);
    } else if (tokens[0] === 'property' && inVertexElement) {
      // We don't support list properties for the vertex element; 3DGS files don't use them.
      if (tokens[1] === 'list') throw new Error('PLY: list property on vertex unsupported');
      const type = normalizeType(tokens[1]);
      const name = tokens[2];
      properties.push({ name, type, byteSize: TYPE_SIZES[type] });
    }
  }

  let vertexByteSize = 0;
  const propertyOffsets = new Map<string, number>();
  for (const p of properties) {
    propertyOffsets.set(p.name, vertexByteSize);
    vertexByteSize += p.byteSize;
  }

  return {
    format,
    vertexCount,
    properties,
    vertexByteSize,
    propertyOffsets,
    headerByteLength: headerEnd,
  };
}

export type ParsedSplats = {
  header: PlyHeader;
  /** raw vertex bytes — header.vertexByteSize per vertex, contiguous */
  vertexBytes: Uint8Array;
  /** position[i*3..i*3+2] = (x,y,z) in world meters */
  positions: Float32Array;
  /** opacity post-sigmoid in [0, 1] */
  opacities: Float32Array;
  /** maxScale[i] = exp(max(scale_0, scale_1, scale_2)) in world meters */
  maxScales: Float32Array;
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function parsePly(buffer: Uint8Array): ParsedSplats {
  const header = parsePlyHeader(buffer);

  if (header.format === 'binary_big_endian') {
    throw new Error('PLY: binary_big_endian not supported (very rare for 3DGS files)');
  }

  const xOff = header.propertyOffsets.get('x');
  const yOff = header.propertyOffsets.get('y');
  const zOff = header.propertyOffsets.get('z');
  const opacityOff = header.propertyOffsets.get('opacity');
  const s0Off = header.propertyOffsets.get('scale_0');
  const s1Off = header.propertyOffsets.get('scale_1');
  const s2Off = header.propertyOffsets.get('scale_2');

  if (xOff === undefined || yOff === undefined || zOff === undefined)
    throw new Error('PLY: missing x/y/z properties');
  if (opacityOff === undefined) throw new Error('PLY: missing opacity property');
  if (s0Off === undefined || s1Off === undefined || s2Off === undefined)
    throw new Error('PLY: missing scale_0/1/2 properties');

  const positions = new Float32Array(header.vertexCount * 3);
  const opacities = new Float32Array(header.vertexCount);
  const maxScales = new Float32Array(header.vertexCount);

  if (header.format === 'binary_little_endian') {
    const vertexBytes = buffer.subarray(
      header.headerByteLength,
      header.headerByteLength + header.vertexCount * header.vertexByteSize
    );
    // Use a DataView so unaligned float reads are safe.
    const dv = new DataView(
      vertexBytes.buffer,
      vertexBytes.byteOffset,
      vertexBytes.byteLength
    );
    for (let i = 0; i < header.vertexCount; i++) {
      const base = i * header.vertexByteSize;
      positions[i * 3 + 0] = dv.getFloat32(base + xOff, true);
      positions[i * 3 + 1] = dv.getFloat32(base + yOff, true);
      positions[i * 3 + 2] = dv.getFloat32(base + zOff, true);
      opacities[i] = sigmoid(dv.getFloat32(base + opacityOff, true));
      const s0 = dv.getFloat32(base + s0Off, true);
      const s1 = dv.getFloat32(base + s1Off, true);
      const s2 = dv.getFloat32(base + s2Off, true);
      maxScales[i] = Math.exp(Math.max(s0, s1, s2));
    }
    // Make a defensive copy so callers can mutate / slice without risking the source buffer.
    const ownedBytes = new Uint8Array(vertexBytes.byteLength);
    ownedBytes.set(vertexBytes);
    return { header, vertexBytes: ownedBytes, positions, opacities, maxScales };
  }

  // ASCII fallback — slow but correct.
  const decoder = new TextDecoder('ascii');
  const text = decoder.decode(buffer.subarray(header.headerByteLength));
  const lines = text.split('\n');
  // For ASCII we synthesize binary_little_endian bytes so the writer path is uniform.
  const synthetic = new Uint8Array(header.vertexCount * header.vertexByteSize);
  const dv = new DataView(synthetic.buffer);

  for (let i = 0; i < header.vertexCount; i++) {
    const tokens = lines[i].trim().split(/\s+/);
    let off = 0;
    for (let p = 0; p < header.properties.length; p++) {
      const prop = header.properties[p];
      const v = parseFloat(tokens[p]);
      writeNumber(dv, i * header.vertexByteSize + off, v, prop.type);
      off += prop.byteSize;
    }
    positions[i * 3 + 0] = parseFloat(tokens[header.propertyOffsets.has('x') ? indexOfProperty(header, 'x') : 0]);
    positions[i * 3 + 1] = parseFloat(tokens[indexOfProperty(header, 'y')]);
    positions[i * 3 + 2] = parseFloat(tokens[indexOfProperty(header, 'z')]);
    opacities[i] = sigmoid(parseFloat(tokens[indexOfProperty(header, 'opacity')]));
    const s0 = parseFloat(tokens[indexOfProperty(header, 'scale_0')]);
    const s1 = parseFloat(tokens[indexOfProperty(header, 'scale_1')]);
    const s2 = parseFloat(tokens[indexOfProperty(header, 'scale_2')]);
    maxScales[i] = Math.exp(Math.max(s0, s1, s2));
  }
  // Header rewrite: an ASCII-source file gets emitted as binary_little_endian.
  const synthHeader: PlyHeader = { ...header, format: 'binary_little_endian' };
  return { header: synthHeader, vertexBytes: synthetic, positions, opacities, maxScales };
}

function indexOfProperty(header: PlyHeader, name: string): number {
  return header.properties.findIndex((p) => p.name === name);
}

function writeNumber(dv: DataView, offset: number, v: number, type: PlyProperty['type']) {
  switch (type) {
    case 'char': dv.setInt8(offset, v); return;
    case 'uchar': dv.setUint8(offset, v); return;
    case 'short': dv.setInt16(offset, v, true); return;
    case 'ushort': dv.setUint16(offset, v, true); return;
    case 'int': dv.setInt32(offset, v, true); return;
    case 'uint': dv.setUint32(offset, v, true); return;
    case 'float': dv.setFloat32(offset, v, true); return;
    case 'double': dv.setFloat64(offset, v, true); return;
  }
}

/**
 * Write a binary_little_endian PLY containing the chosen subset of vertices,
 * optionally with overridden positions (used when projectToSurface is on).
 *
 * `keptIndices` is an array of indices into the original parsed splat array.
 * `overridePositions[i]` (if present) replaces vertex `keptIndices[i]`'s xyz.
 */
export function writePly(
  parsed: ParsedSplats,
  keptIndices: Uint32Array,
  overridePositions?: Float32Array | null
): Uint8Array {
  const header = parsed.header;
  const headerLines: string[] = [];
  headerLines.push('ply');
  headerLines.push('format binary_little_endian 1.0');
  headerLines.push(`element vertex ${keptIndices.length}`);
  for (const p of header.properties) headerLines.push(`property ${p.type} ${p.name}`);
  headerLines.push('end_header');
  const headerText = headerLines.join('\n') + '\n';
  const headerBytes = new TextEncoder().encode(headerText);

  const vsize = header.vertexByteSize;
  const out = new Uint8Array(headerBytes.byteLength + keptIndices.length * vsize);
  out.set(headerBytes, 0);

  const xOff = header.propertyOffsets.get('x')!;
  const yOff = header.propertyOffsets.get('y')!;
  const zOff = header.propertyOffsets.get('z')!;
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  for (let dst = 0; dst < keptIndices.length; dst++) {
    const src = keptIndices[dst];
    const dstOff = headerBytes.byteLength + dst * vsize;
    out.set(parsed.vertexBytes.subarray(src * vsize, src * vsize + vsize), dstOff);
    if (overridePositions) {
      outDv.setFloat32(dstOff + xOff, overridePositions[dst * 3 + 0], true);
      outDv.setFloat32(dstOff + yOff, overridePositions[dst * 3 + 1], true);
      outDv.setFloat32(dstOff + zOff, overridePositions[dst * 3 + 2], true);
    }
  }

  return out;
}
