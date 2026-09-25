import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  float,
  floor,
  mix,
  mod,
  normalize,
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
 * File layout (gzipped, vertex-major [vertex][frame] so gzip sees temporal
 * coherence): offsets as 3 uint16 normalized over [minOffset, maxOffset]
 * (x, -y swizzled, no w), delta-coded per vertex (frame 0 absolute, then
 * diffs in the abs width — i8 for u8, i16 for u16; meta.delta flags a
 * fallback to absolute on spikes), then normals octahedral-encoded to 2 signed bytes
 * — 8 bytes/vertex/frame (vs 32 unpacked). F32 layouts are transposed but
 * never delta-coded. vat-storage/3 adds, per block, sparse static vertices
 * (frame 0 for all vertices, later frames for movers only; the mover set
 * rides in meta.sparse as a base64 bitmap) and varint diffs (zigzag
 * LEB128, meta.varint flags). Every combination is picked
 * gzipped-smallest at bake.
 * Layout "none" stores no normal bytes: decode returns
 * null normals and the material falls back to geometry normals.
 * Decoding reverses exactly (integer cumsum, no drift).
 * Frame rows run last-frame-first like the texture
 * path, so frame f lives at row (F-1-f). Vertex id comes from uv1.x
 * (u = (i+0.5)/V), which survives the vertex splits of the glTF export;
 * row = f*V + id. Everything is expanded back to vec4f StorageBuffer
 * attributes at load, so the shader below is layout-agnostic.
 */
export const VAT_STORAGE_FORMAT = 'vat-storage/3'

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
    normals: normals ? new StorageBufferAttribute(normals, 4) : null,
  }
}

/**
 * One call: fetch + decode + material. The `.glb` stays yours
 * (it carries the bind pose and the uv1 bake ids); point its mesh
 * at the returned material and drive `uniforms.frame` (see below).
 *
 *   const vat = await loadVatStorageMaterial('cloth_vat.bin', 'cloth_vat.json')
 *   mesh.material = vat.material
 *   vat.uniforms.frame.value = (t * vat.meta.fps) % vat.meta.frameCount
 */
export async function loadVatStorageMaterial(url, metaUrl, params = {}) {
  const { meta, offsets, normals } = await loadVatStorage(url, metaUrl)
  const { material, uniforms } = createVatStorageMaterial({ offsets, normals, meta, params })
  return { material, uniforms, meta }
}

export function decodeVatBuffer(buf, meta) {
  return decodeVatBufferV3(buf, meta)
}

function readVarint(view, p) {
  // Unsigned LEB128; returns [value, nextOffset].
  let u = 0
  let shift = 0
  for (;;) {
    const b = view.getUint8(p++)
    u |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return [u, p]
}

const zzDecode = (u) => (u >>> 1) ^ -(u & 1)

function moversFromBitmap(b64, V) {
  const raw = atob(b64)
  const movers = []
  for (let v = 0; v < V; v++) {
    if ((raw.charCodeAt(v >> 3) >> (v & 7)) & 1) movers.push(v)
  }
  return movers
}

export function decodeVatBufferV3(buf, meta) {
  const { vertexCount: V, frameCount: F } = meta
  const OFF = { u8x3: 1, u16x3: 2, f32x3: 4 }
  const NRM = { oct8x2: 2, f32x3: 12, none: 0 }
  const ob = OFF[meta.layout?.offsets]
  const nb = NRM[meta.layout?.normals]
  if (!ob || nb === undefined) {
    throw new Error(`Unsupported storage layout '${JSON.stringify(meta.layout)}': re-export with the current VAT addon`)
  }
  const n = V * F
  const view = new DataView(buf)
  const span = meta.maxOffset - meta.minOffset || 1
  const lo = meta.layout.offsets
  const qmax = lo === 'u8x3' ? 255 : 65535
  const readU = (v) => (v / qmax) * span + meta.minOffset
  const readFix = ob === 1 ? (p) => view.getUint8(p) : (p) => view.getUint16(p, true)
  const readDfix = ob === 1 ? (p) => view.getInt8(p) : (p) => view.getInt16(p, true)
  const offsets = new Float32Array(n * 4)
  const normals = new Float32Array(n * 4)
  const at = (f, v) => (f * V + v) * 4
  const movers = meta.sparse ? moversFromBitmap(meta.sparse.bitmap, V) : null
  const moverSet = movers ? new Set(movers) : null
  let p = 0
  // --- offsets (strict vertex-major: each vertex's frames contiguous) ---
  if (lo === 'f32x3') {
    const sparse = !!meta.sparse?.offsets
    for (let v = 0; v < V; v++) {
      let x = view.getFloat32(p, true)
      let y = view.getFloat32(p + 4, true)
      let z = view.getFloat32(p + 8, true)
      p += 12
      for (let f = 0; f < F; f++) {
        if (f > 0 && (!sparse || moverSet.has(v))) {
          x = view.getFloat32(p, true)
          y = view.getFloat32(p + 4, true)
          z = view.getFloat32(p + 8, true)
          p += 12
        }
        const i = at(f, v)
        offsets[i] = x
        offsets[i + 1] = y
        offsets[i + 2] = z
        offsets[i + 3] = 1
      }
    }
  } else if (!meta.delta?.offsets) {
    for (let v = 0; v < V; v++) {
      for (let f = 0; f < F; f++) {
        const qx = readFix(p)
        const qy = readFix(p + ob)
        const qz = readFix(p + 2 * ob)
        p += 3 * ob
        const i = at(f, v)
        offsets[i] = readU(qx)
        offsets[i + 1] = readU(qy)
        offsets[i + 2] = readU(qz)
        offsets[i + 3] = 1
      }
    }
  } else {
    const sparse = !!meta.sparse?.offsets
    const varint = !!meta.varint?.offsets
    for (let v = 0; v < V; v++) {
      let qx = readFix(p)
      let qy = readFix(p + ob)
      let qz = readFix(p + 2 * ob)
      p += 3 * ob
      for (let f = 0; f < F; f++) {
        if (f > 0 && (!sparse || moverSet.has(v))) {
          if (varint) {
            let u
            ;[u, p] = readVarint(view, p)
            qx += zzDecode(u)
            ;[u, p] = readVarint(view, p)
            qy += zzDecode(u)
            ;[u, p] = readVarint(view, p)
            qz += zzDecode(u)
          } else {
            qx += readDfix(p)
            qy += readDfix(p + ob)
            qz += readDfix(p + 2 * ob)
            p += 3 * ob
          }
        }
        const i = at(f, v)
        offsets[i] = readU(qx)
        offsets[i + 1] = readU(qy)
        offsets[i + 2] = readU(qz)
        offsets[i + 3] = 1
      }
    }
  }
  // --- normals ---
  if (nb === 0) return { offsets, normals: null }
  if (meta.layout.normals === 'f32x3') {
    const sparse = !!meta.sparse?.normals
    for (let v = 0; v < V; v++) {
      let x = view.getFloat32(p, true)
      let y = view.getFloat32(p + 4, true)
      let z = view.getFloat32(p + 8, true)
      p += 12
      for (let f = 0; f < F; f++) {
        if (f > 0 && (!sparse || moverSet.has(v))) {
          x = view.getFloat32(p, true)
          y = view.getFloat32(p + 4, true)
          z = view.getFloat32(p + 8, true)
          p += 12
        }
        const i = at(f, v)
        normals[i] = x
        normals[i + 1] = y
        normals[i + 2] = z
      }
    }
  } else if (!meta.delta?.normals) {
    for (let v = 0; v < V; v++) {
      for (let f = 0; f < F; f++) {
        const [x, y, z] = octDecode(view.getInt8(p), view.getInt8(p + 1))
        const i = at(f, v)
        normals[i] = x
        normals[i + 1] = y
        normals[i + 2] = z
        p += 2
      }
    }
  } else {
    const sparse = !!meta.sparse?.normals
    const varint = !!meta.varint?.normals
    for (let v = 0; v < V; v++) {
      let qx = view.getInt8(p)
      let qy = view.getInt8(p + 1)
      p += 2
      for (let f = 0; f < F; f++) {
        if (f > 0 && (!sparse || moverSet.has(v))) {
          if (varint) {
            let u
            ;[u, p] = readVarint(view, p)
            qx += zzDecode(u)
            ;[u, p] = readVarint(view, p)
            qy += zzDecode(u)
          } else {
            qx += view.getInt16(p, true)
            qy += view.getInt16(p + 2, true)
            p += 4
          }
        }
        const dec = octDecode(qx, qy)
        const i = at(f, v)
        normals[i] = dec[0]
        normals[i + 1] = dec[1]
        normals[i + 2] = dec[2]
      }
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

export function createVatStorageMaterial({ offsets, normals, meta, params = {} }) {  const { vertexCount: V, frameCount: F } = meta
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
    stepAmount: uniform(params.step ?? 1),
    smoothAmount: uniform(params.smooth ?? true ? 1 : 0),
  }
  const { frame, frameCount, vertexCount, isOffsets, denormalize, minOffset, maxOffset, stepAmount, smoothAmount } = uniforms

  // glTF export splits vertices on UV/normal seams, so vertexIndex does NOT
  // match bake rows. Recover the bake id from uv1.x instead: the bake writes
  // u = (i + 0.5) / V (NONE layout, forced in storage mode), shared by every
  // split copy of vertex i. Bake rows run last-frame-first.
  const vid = floor(attribute('uv1').x.mul(vertexCount))
  // Playback sampling: STEP subsamples baked rows onto a coarser grid,
  // SMOOTH lerps between grid points (sample-and-hold when off).
  const frameM = mod(frame, frameCount)
  const frameG = floor(frameM.div(stepAmount)).mul(stepAmount)
  const frameF = frameM.sub(frameG).div(stepAmount).mul(smoothAmount)
  // Next grid point, wrapping to 0 (exact loop seam, not mod arithmetic).
  const nextG = frameG.add(stepAmount)
  const frameJ = select(nextG.lessThan(frameCount), nextG, float(0))
  // Bake rows run last-frame-first: row = (F-1-f) * V + vid.
  const rowOf = (fi) => frameCount.sub(float(1)).sub(fi).mul(vertexCount).add(vid)
  const at = (attr, row) => storage(attr, 'vec4', V * F).element(row)
  const rawOffset = mix(at(offsets, rowOf(frameG)), at(offsets, rowOf(frameJ)), frameF)
  const vatOffset = select(
    denormalize,
    rawOffset.xyz.mul(maxOffset.sub(minOffset)).add(minOffset),
    rawOffset.xyz,
  )
  // Layout "none": no normals buffer, geometry normals apply (lighting
  // won't follow the deformation, but the mesh still animates).
  const vatNormal = normals
    ? transformNormalToView(varying(
        normalize(mix(at(normals, rowOf(frameG)).xyz, at(normals, rowOf(frameJ)).xyz, frameF).xzy),
      ))
    : null

  const basePosition = attribute('position')
  const material = new MeshStandardNodeMaterial({
    color: 0x5588ff,
    roughness: 0.5,
    metalness: 0.0,
    side: 2,
  })
  material.positionNode = select(isOffsets, basePosition.add(vatOffset.xzy), vatOffset.xzy)
  if (vatNormal) material.normalNode = vatNormal

  return { material, uniforms }
}

export function syncVatStorageUniforms(uniforms, params) {
  uniforms.isOffsets.value = params.positionMode === 'offsets'
  uniforms.denormalize.value = params.normalize
  uniforms.minOffset.value = params.minOffset
  uniforms.maxOffset.value = params.maxOffset
  uniforms.stepAmount.value = Math.max(1, Math.round(params.step))
  uniforms.smoothAmount.value = params.smooth ? 1 : 0
}
