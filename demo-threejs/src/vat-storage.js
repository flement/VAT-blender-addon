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
 * i16 frame-to-frame diffs; meta.delta flags a fallback to absolute when
 * a spike exceeds i16), then normals octahedral-encoded to 2 signed bytes
 * — 8 bytes/vertex/frame (vs 32 unpacked). F32 layouts are transposed but
 * never delta-coded. Decoding reverses exactly (integer cumsum, no drift).
 * Frame rows run last-frame-first like the texture
 * path, so frame f lives at row (F-1-f). Vertex id comes from uv1.x
 * (u = (i+0.5)/V), which survives the vertex splits of the glTF export;
 * row = f*V + id. Everything is expanded back to vec4f StorageBuffer
 * attributes at load, so the shader below is layout-agnostic.
 */
export const VAT_STORAGE_FORMAT = 'vat-storage/2'

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
  // Blocks stored vertex-major ([vertex][frame]). Integer offsets are
  // delta-coded per vertex when meta.delta.offsets is set (frame 0
  // absolute, then i16 diffs; integer cumsum, bit-exact). Output rows
  // are frame-major, last-frame-first.
  const span = meta.maxOffset - meta.minOffset || 1
  const lo = meta.layout.offsets
  const qmax = lo === 'u8x3' ? 255 : 65535
  const readU = (v) => (v / qmax) * span + meta.minOffset
  const offsets = new Float32Array(n * 4)
  const normals = new Float32Array(n * 4)
  const at = (f, v) => (f * V + v) * 4
  let p = 0
  if (lo === 'f32x3') {
    for (let v = 0; v < V; v++) {
      for (let f = 0; f < F; f++) {
        const i = at(f, v)
        offsets[i] = view.getFloat32(p, true)
        offsets[i + 1] = view.getFloat32(p + 4, true)
        offsets[i + 2] = view.getFloat32(p + 8, true)
        offsets[i + 3] = 1
        p += 12
      }
    }
  } else if (meta.delta?.offsets) {
    for (let v = 0; v < V; v++) {
      let qx = ob === 1 ? view.getUint8(p) : view.getUint16(p, true)
      let qy = ob === 1 ? view.getUint8(p + ob) : view.getUint16(p + 2, true)
      let qz = ob === 1 ? view.getUint8(p + 2 * ob) : view.getUint16(p + 4, true)
      p += 3 * ob
      let i = at(0, v)
      offsets[i] = readU(qx)
      offsets[i + 1] = readU(qy)
      offsets[i + 2] = readU(qz)
      offsets[i + 3] = 1
      for (let f = 1; f < F; f++) {
        qx += view.getInt16(p, true)
        qy += view.getInt16(p + 2, true)
        qz += view.getInt16(p + 4, true)
        p += 6
        i = at(f, v)
        offsets[i] = readU(qx)
        offsets[i + 1] = readU(qy)
        offsets[i + 2] = readU(qz)
        offsets[i + 3] = 1
      }
    }
  } else {
    for (let v = 0; v < V; v++) {
      for (let f = 0; f < F; f++) {
        const qx = ob === 1 ? view.getUint8(p) : view.getUint16(p, true)
        const qy = ob === 1 ? view.getUint8(p + ob) : view.getUint16(p + 2, true)
        const qz = ob === 1 ? view.getUint8(p + 2 * ob) : view.getUint16(p + 4, true)
        p += 3 * ob
        const i = at(f, v)
        offsets[i] = readU(qx)
        offsets[i + 1] = readU(qy)
        offsets[i + 2] = readU(qz)
        offsets[i + 3] = 1
      }
    }
  }
  if (meta.layout.normals === 'f32x3') {
    for (let v = 0; v < V; v++) {
      for (let f = 0; f < F; f++) {
        const i = at(f, v)
        normals[i] = view.getFloat32(p, true)
        normals[i + 1] = view.getFloat32(p + 4, true)
        normals[i + 2] = view.getFloat32(p + 8, true)
        p += 12
      }
    }
  } else if (meta.delta?.normals) {
    for (let v = 0; v < V; v++) {
      let qx = view.getInt8(p)
      let qy = view.getInt8(p + 1)
      p += 2
      let i = at(0, v)
      let dec = octDecode(qx, qy)
      normals[i] = dec[0]
      normals[i + 1] = dec[1]
      normals[i + 2] = dec[2]
      for (let f = 1; f < F; f++) {
        qx += view.getInt16(p, true)
        qy += view.getInt16(p + 2, true)
        p += 4
        i = at(f, v)
        dec = octDecode(qx, qy)
        normals[i] = dec[0]
        normals[i + 1] = dec[1]
        normals[i + 2] = dec[2]
      }
    }
  } else {
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

export function createVatStorageMaterial({ offsets, normals, meta, params = {} }) {
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
    stepAmount: uniform(params.step ?? 1),
    smoothAmount: uniform(params.smooth ?? true ? 1 : 0),
  }
  const { frame, frameCount, vertexCount, isOffsets, denormalize, minOffset, maxOffset, stepAmount, smoothAmount } = uniforms

  // glTF export splits vertices on UV/normal seams, so vertexIndex does NOT
  // match bake rows. Recover the bake id from uv1.x instead: the bake writes
  // u = (i + 0.5) / V (NONE layout, forced in storage mode), shared by every
  // split copy of vertex i. Bake rows run last-frame-first.
  const vid = floor(attribute('uv1').x.mul(vertexCount))
  // Playback sampling: STEP subsamples baked rows onto a coarser grid
  // (previews a Step bake without re-baking), SMOOTH lerps between grid
  // points (sample-and-hold when off). Next row wraps to 0, which also
  // smooths the loop seam.
  const frameM = mod(frame, frameCount)
  const frameG = floor(frameM.div(stepAmount)).mul(stepAmount)
  const frameF = frameM.sub(frameG).div(stepAmount).mul(smoothAmount)
  const frameI = frameG
  // Next grid point, wrapping to 0 (exact loop seam, not mod arithmetic).
  const nextG = frameG.add(stepAmount)
  const frameJ = select(nextG.lessThan(frameCount), nextG, float(0))
  const rowI = frameCount.sub(float(1)).sub(frameI).mul(vertexCount).add(vid)
  const rowJ = frameCount.sub(float(1)).sub(frameJ).mul(vertexCount).add(vid)
  const rawOffset = mix(
    storage(offsets, 'vec4', V * F).element(rowI),
    storage(offsets, 'vec4', V * F).element(rowJ),
    frameF,
  )
  const vatOffset = select(
    denormalize,
    rawOffset.xyz.mul(maxOffset.sub(minOffset)).add(minOffset),
    rawOffset.xyz,
  )
  const vatNormalObject = varying(
    normalize(mix(
      storage(normals, 'vec4', V * F).element(rowI).xyz,
      storage(normals, 'vec4', V * F).element(rowJ).xyz,
      frameF,
    ).xzy),
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

export function syncVatStorageUniforms(uniforms, params) {
  uniforms.isOffsets.value = params.positionMode === 'offsets'
  uniforms.denormalize.value = params.normalize
  uniforms.minOffset.value = params.minOffset
  uniforms.maxOffset.value = params.maxOffset
  uniforms.stepAmount.value = Math.max(1, Math.round(params.step))
  uniforms.smoothAmount.value = params.smooth ? 1 : 0
}
