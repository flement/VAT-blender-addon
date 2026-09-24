import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  float,
  floor,
  mod,
  select,
  storage,
  transformNormalToView,
  uniform,
  varying,
} from 'three/tsl'
import { StorageBufferAttribute } from 'three/webgpu'

/**
 * Storage-buffer VAT material for `<basename>_vat.bin` + `<basename>_vat.json`
 * exports of VAT/__init__.py (Export Mode = Storage Buffer).
 *
 * File layout (gzipped): per [frame][vertex], offsets as 3 uint16
 * normalized over [minOffset, maxOffset] (x, -y swizzled, no w), then
 * normals octahedral-encoded to 2 signed bytes — 8 bytes/vertex/frame
 * (vs 32 unpacked). Frame rows run last-frame-first like the texture
 * path, so frame f lives at row (F-1-f). Vertex id comes from uv1.x
 * (u = (i+0.5)/V), which survives the vertex splits of the glTF export;
 * row = f*V + id. Everything is expanded back to vec4f StorageBuffer
 * attributes at load, so the shader below is layout-agnostic.
 */
export const VAT_STORAGE_FORMAT = 'vat-storage/1'

export async function loadVatStorage(url, metaUrl) {
  const meta = await (await fetch(metaUrl)).json()
  if (meta.format !== VAT_STORAGE_FORMAT) {
    throw new Error(
      `Unsupported storage format '${meta.format ?? 'legacy'}': re-bake + re-export with the current VAT addon (want ${VAT_STORAGE_FORMAT})`,
    )
  }
  let buf = await (await fetch(url)).arrayBuffer()
  if (meta.compression === 'gzip') {
    buf = await new Response(
      new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer()
  }
  const { offsets, normals } = decodeVatBuffer(buf, meta)
  return {
    meta,
    offsets: new StorageBufferAttribute(offsets, 4),
    normals: new StorageBufferAttribute(normals, 4),
  }
}

export function decodeVatBuffer(buf, meta) {
  const { vertexCount: V, frameCount: F } = meta
  const OFF = { u8x3: 1, u16x3: 2, f32x3: 4 }
  const NRM = { oct8x2: 2, f32x3: 12 }
  const ob = OFF[meta.layout?.offsets]
  const nb = NRM[meta.layout?.normals]
  if (!ob || !nb) {
    throw new Error(`Unsupported storage layout '${JSON.stringify(meta.layout)}': re-export with the current VAT addon`)
  }
  const bpv = ob * 3 + nb
  const n = V * F
  const view = new DataView(buf)
  if (view.byteLength < n * bpv) throw new Error(`Truncated storage buffer: ${view.byteLength} bytes for ${n} verts`)
  const span = meta.maxOffset - meta.minOffset || 1
  const lo = meta.layout.offsets
  const readU = (q, v) => (v / q) * span + meta.minOffset
  const offsets = new Float32Array(n * 4)
  const normals = new Float32Array(n * 4)
  let p = 0
  for (let v = 0; v < n; v++) {
    for (let j = 0; j < 3; j++, p += ob) {
      offsets[v * 4 + j] = lo === 'f32x3' ? view.getFloat32(p, true)
        : readU(lo === 'u8x3' ? 255 : 65535, ob === 1 ? view.getUint8(p) : view.getUint16(p, true))
    }
    offsets[v * 4 + 3] = 1
  }
  for (let v = 0; v < n; v++) {
    if (meta.layout.normals === 'f32x3') {
      normals[v * 4] = view.getFloat32(p, true)
      normals[v * 4 + 1] = view.getFloat32(p + 4, true)
      normals[v * 4 + 2] = view.getFloat32(p + 8, true)
      p += 12
    } else {
      const [x, y, z] = octDecode(view.getInt8(p), view.getInt8(p + 1))
      normals[v * 4] = x
      normals[v * 4 + 1] = y
      normals[v * 4 + 2] = z
      p += 2
    }
  }
  return { offsets, normals }
}

function octDecode(x, y) {
  x /= 127
  y /= 127
  let nx = x
  let ny = y
  let nz = 1 - Math.abs(x) - Math.abs(y)
  if (nz < 0) {
    nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1)
    ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)
  }
  const l = Math.hypot(nx, ny, nz) || 1
  return [nx / l, ny / l, nz / l]
}

export function createVatStorageMaterial({ offsets, normals, meta }) {
  const { vertexCount: V, frameCount: F } = meta
  const uniforms = {
    offsets: { value: offsets },
    normals: { value: normals },
    frame: uniform(0),
    frameCount: uniform(F),
    vertexCount: uniform(V),
    isOffsets: uniform(meta.positionMode !== 'absolutes'),
    denormalize: uniform(meta.normalize),
    minOffset: uniform(meta.minOffset ?? 0),
    maxOffset: uniform(meta.maxOffset ?? 1),
  }
  const { frame, frameCount, vertexCount, isOffsets, denormalize, minOffset, maxOffset } = uniforms

  // glTF export splits vertices on UV/normal seams, so vertexIndex does NOT
  // match bake rows. Recover the bake id from uv1.x instead: the bake writes
  // u = (i + 0.5) / V (NONE layout, forced in storage mode), shared by every
  // split copy of vertex i. Bake rows run last-frame-first.
  const vid = floor(attribute('uv1').x.mul(vertexCount))
  // Quantize: storage has no filtering, so a fractional frame must resolve
  // to an integer row (same floor() the readout uses), never to float index.
  const frameI = floor(mod(frame, frameCount))
  const row = frameCount.sub(float(1)).sub(frameI).mul(vertexCount).add(vid)
  const rawOffset = storage(offsets, 'vec4', V * F).element(row)
  const vatOffset = select(
    denormalize,
    rawOffset.xyz.mul(maxOffset.sub(minOffset)).add(minOffset),
    rawOffset.xyz,
  )
  const vatNormalObject = varying(
    storage(normals, 'vec4', V * F).element(row).xyz.xzy,
  )
  const vatNormal = transformNormalToView(vatNormalObject)

  const basePosition = attribute('position')
  const material = new MeshStandardNodeMaterial({
    color: 0x5588ff,
    roughness: 0.5,
    metalness: 0.0,
    side: 2,
  })
  material.positionNode = select(isOffsets, basePosition.add(vatOffset.xzy), vatOffset.xzy)
  material.normalNode = vatNormal

  return { material, uniforms }
}
