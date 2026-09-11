import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  attribute,
  float,
  mod,
  positionLocal,
  select,
  texture,
  transformNormalToView,
  uniform,
  varying,
  vec2,
} from 'three/tsl'

/**
 * VAT material for NONE / WRAP / WRAP_CROP exports of VAT/__init__.py, built
 * on MeshStandardNodeMaterial so real three.js lights, env and tone mapping apply.
 * VAT displacement + baked normals are injected via TSL nodes (no GLSL strings).
 *
 * Layout (bake: OFFSETS, flip_y ON, normalize OFF, positions EXR written by
 * the export script as half-float planar ABGR — Blender's image.save() EXR
 * output misparses in third-party readers, so the script writes the file
 * directly from image pixels):
 * - K wrap blocks stacked vertically, each holding F frame rows
 *   (NONE: K=1, texture N x F; WRAP: texture W x Hopt, padded;
 *   WRAP_CROP: texture W x F*K). Bake rows run last-frame-first (reversed)
 *   + bake flip_y in memory; the file stores memory rows in order.
 * - three.js EXRLoader flips rows on decode AND the PNG uploads flipY=true,
 *   so both textures land as: GL row g = bake row g. For vertex block b and
 *   frame f (f = 0 is the first frame):
 *       row = b * F + (F - 1 - f)
 * - Blender bakes v so that, after the glTF exporter V-flip, the block is
 *   recovered universally as b = floor((uv1.y - 1/K) * Ht / F + 0.5)
 *   (Ht = texture height).
 * - Normals PNG rows land mirrored vs the EXR, hence the vatNormalUv mirror:
 *   without it normals sample the wrong block (K > 1) / reversed frames.
 */
export function createVatMaterial({ positionTexture, normalTexture, params }) {
  const uniforms = {
    posTexture: { value: positionTexture },
    normalTexture: { value: normalTexture },
    frameCount: uniform(params.frames),
    numWraps: uniform(params.numWraps),
    texHeight: uniform(params.texHeight),
    isOffsets: uniform(params.positionMode === 'offsets'),
    denormalize: uniform(params.normalize),
    minOffset: uniform(params.minOffset),
    maxOffset: uniform(params.maxOffset),
    frame: uniform(0),
  }
  const { frameCount, numWraps, texHeight, isOffsets, denormalize, minOffset, maxOffset, frame } =
    uniforms

  const uv1 = attribute('uv1')
  const vatBlock = uv1.y.sub(float(1).div(numWraps)).mul(texHeight).div(frameCount).add(0.5).floor()
  const vatRow = vatBlock.mul(frameCount).add(frameCount.sub(float(1)).sub(mod(frame, frameCount)))
  const vatUv = vec2(uv1.x, vatRow.add(0.5).div(texHeight))

  const rawOffset = texture(positionTexture, vatUv)
  const denormOffset = rawOffset.xyz.mul(maxOffset.sub(minOffset)).add(minOffset)
  const vatOffset = select(denormalize, denormOffset, rawOffset.xyz)

  const vatNormalUv = vec2(vatUv.x, float(1).sub(vatUv.y))
  const vatNormalObject = varying(texture(normalTexture, vatNormalUv).mul(2).sub(1).xzy)
  const vatNormal = transformNormalToView(vatNormalObject)

  const material = new MeshStandardNodeMaterial({
    color: 0x5588ff,
    roughness: 0.5,
    metalness: 0.0,
    side: 2,
  })
  material.positionNode = select(isOffsets, positionLocal.add(vatOffset.xzy), vatOffset.xzy)
  material.normalNode = vatNormal

  return { material, uniforms }
}

export function syncVatUniforms(uniforms, params) {
  uniforms.frameCount.value = params.frames
  uniforms.numWraps.value = params.numWraps
  uniforms.texHeight.value = params.texHeight
  uniforms.isOffsets.value = params.positionMode === 'offsets'
  uniforms.denormalize.value = params.normalize
  uniforms.minOffset.value = params.minOffset
  uniforms.maxOffset.value = params.maxOffset
}
