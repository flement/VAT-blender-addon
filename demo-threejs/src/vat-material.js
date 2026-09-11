import { MeshStandardMaterial } from 'three'

/**
 * VAT material for NONE / WRAP / WRAP_CROP exports of VAT/__init__.py, built
 * on MeshStandardMaterial so real three.js lights, env and tone mapping apply.
 * VAT displacement + baked normals are injected via onBeforeCompile.
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
    frameCount: { value: params.frames },
    numWraps: { value: params.numWraps },
    texHeight: { value: params.texHeight },
    isOffsets: { value: params.positionMode === 'offsets' },
    denormalize: { value: params.normalize },
    minOffset: { value: params.minOffset },
    maxOffset: { value: params.maxOffset },
    frame: { value: 0 },
  }

  const material = new MeshStandardMaterial({
    color: 0x5588ff,
    roughness: 0.5,
    metalness: 0.0,
    side: 2
  })

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader =
      `
      attribute vec2 uv1;
      uniform sampler2D posTexture;
      uniform sampler2D normalTexture;
      uniform float frameCount;
      uniform float numWraps;
      uniform float texHeight;
      uniform bool isOffsets;
      uniform bool denormalize;
      uniform float minOffset;
      uniform float maxOffset;
      uniform float frame;
      ` + shader.vertexShader
        .replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          #include <beginnormal_vertex>
          float vatBlock = floor((uv1.y - 1.0 / numWraps) * texHeight / frameCount + 0.5);
          float vatRow = vatBlock * frameCount + (frameCount - 1.0 - mod(frame, frameCount));
          vec2 vatUv = vec2(uv1.x, (vatRow + 0.5) / texHeight);
          vec4 vatOffset = texture2D(posTexture, vatUv);
          if (denormalize) vatOffset.xyz = vatOffset.xyz * (maxOffset - minOffset) + minOffset;
          vec2 vatNormalUv = vec2(vatUv.x, 1.0 - vatUv.y);
          objectNormal = (texture2D(normalTexture, vatNormalUv) * 2.0 - 1.0).xzy;
          `,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          vec3 transformed = isOffsets ? position + vatOffset.xzy : vatOffset.xzy;
          `,
        )
  }
  // Injected code is static; a constant key avoids clashes with plain materials.
  material.customProgramCacheKey = () => 'vat-wrap-all'

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
