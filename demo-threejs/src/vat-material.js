import { DoubleSide, MeshStandardMaterial } from 'three'

/**
 * VAT material for `wrap_mode = NONE` exports of VAT/__init__.py, built on
 * MeshStandardMaterial so real three.js lights, env and tone mapping apply.
 * VAT displacement + baked normals are injected via onBeforeCompile.
 *
 * Sampling follows README.md: frame fraction over totalFrames, sampled as
 * vec2(uv1.x, uv1.y - frame). The normal sample mirrors V in-shader
 * (1.0 - vatUv.y) so the PNG keeps the default TextureLoader flipY = true
 * while sampling the same row as the EXR positions (which ignore flipY).
 */
export function createVatMaterial({ positionTexture, normalTexture, params }) {
  const uniforms = {
    posTexture: { value: positionTexture },
    normalTexture: { value: normalTexture },
    frameCount: { value: params.frames },
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
  })

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader =
      `
      attribute vec2 uv1;
      uniform sampler2D posTexture;
      uniform sampler2D normalTexture;
      uniform float frameCount;
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
          float vatFrame = mod(frame, frameCount) / frameCount;
          vec2 vatUv = vec2(uv1.x, uv1.y - vatFrame);
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
  material.customProgramCacheKey = () => 'vat-none'

  return { material, uniforms }
}

export function syncVatUniforms(uniforms, params) {
  uniforms.frameCount.value = params.frames
  uniforms.isOffsets.value = params.positionMode === 'offsets'
  uniforms.denormalize.value = params.normalize
  uniforms.minOffset.value = params.minOffset
  uniforms.maxOffset.value = params.maxOffset
}
