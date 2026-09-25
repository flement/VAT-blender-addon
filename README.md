# Vertex Animation Toolkit — Blender → real-time engines

**Live demo: https://vat.residenceprincipale.net/**

Bake any Blender mesh animation (physics, modifiers, armatures, Alembic…) into files a real-time engine replays **in the vertex shader** — no armature, no per-frame CPU work. Supports two encodings: **Vertex Animation Texture** (images + GLSL, any engine) and **Vertex Animation Buffer** (compact `.bin` for WebGPU). Tested with three.js; Track A (VAT Texture) is engine-agnostic and ports to any engine with vertex texture fetch.

**The idea in 30 seconds:** for every frame, every vertex, store *where it moved*. At runtime the mesh is static; the shader adds the stored motion back.

## Pick your track

| | **Track A — VAT Texture** (the classic) | **Track B — Storage Buffer** |
|---|---|---|
| Files | `positions.exr`/`.png` + `normals.png` + `.glb` | `<name>_vat.bin` (gzipped) + `<name>_vat.json` + `.glb` |
| Shader input | `sampler2D` | `buffer<storage>` (TSL `storage()`) |
| three.js | WebGL2 **and** WebGPU | WebGPU only |
| Size control | wrap mode, PNG normalize | offsets/normals precision (u8/u16/f32, oct) |
| Best for | texture pipelines, hand-editable frames, max compatibility | smallest files, many instances, GPU blending |

Both tracks share the same Blender bake (one mesh in → motion out) and the same rules below. In the panel, **Export Mode** switches tracks and swaps the settings section.

---

# Track A — VAT Texture

## A1. Bake (Blender, 5 min)

1. Install: **Edit > Preferences > Add-ons > Install from Disk**, pick the `VAT` folder (or release zip), enable it. A **VAT Toolkit** tab appears in the 3D sidebar.
2. **Bake your dynamics first** (Cache > Bake All Dynamics). VAT reads the simulated result; unbaked cloth/particles abort with an error.
3. Select **one** mesh (several = combined into a single bake).
4. VAT tab → Export Mode = **VAT Texture**. Settings:
   - **Positions**: `OFFSETS` (motion relative to bind pose, smaller) or `ABSOLUTES` (world space).
   - **Flip Y**: leave on (matches glTF/three.js row order).
   - **Normalize**: on = PNG output (uses stored min/max to remap), off = OpenEXR Half (exact, bigger).
   - **Wrap**: `NONE` (one long strip), `WRAP` (near-square, GPU-friendly), `WRAP_CROP` (wrapped + empty space cut — smallest).
5. Set Folder + Name → **Quick Export** → `.glb` + `positions.exr`/`.png` + `normals.png`.

Dry run first with **Bake (manual)**: validates without writing files, creates `export_mesh` in-scene (bind pose + `vertex_anim` UVs — **never delete that UV set**, the shader reads block coords from it).

## A2. Play (three.js WebGL2, GLSL)

```glsl
// vertexShader.glsl
attribute vec2 uv1;                  // vertex_anim UV set
uniform sampler2D texturePosition;   // positions.exr or .png
uniform sampler2D textureNormal;     // normals.png
uniform float uTime, totalFrames, fps;
varying vec3 vNormal;

void main() {
  float frame = mod(uTime * fps, totalFrames) / totalFrames;
  vec4 tp = texture(texturePosition, vec2(uv1.x, uv1.y - frame));
  vec4 tn = texture(textureNormal, vec2(uv1.x, uv1.y - frame)) * 2.0 - 1.0;
  vNormal = tn.xzy;                              // Blender Z-up -> three Y-up
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + tp.xzy, 1.0);
}
```

Notes: with Normalize on, remap `tp.xyz * (maxOffset - minOffset) + minOffset` (values shown in the panel after bake). With Wrap modes, block coords come from the same `uv1` — see `demo-threejs/src/vat-material.js` for the full sampling (filtering + wrap math).

---

# Track B — Storage Buffer

## B1. Bake (Blender, 5 min)

Steps 1–3 identical to Track A. Then:

4. VAT tab → Export Mode = **Storage Buffer**. Settings:
   - **Offsets** (per-axis motion): `u8 (3 B)` preview quality, `u16 (6 B)` default (sub-mm at meter scale), `f32 (12 B)` reference.
   - **Normals** (per-vertex direction): `oct (2 B)` default (~0.7° max error), `f32 (12 B)`, or `none` (÷2 weight, lighting stops following folds but motion stays).
   - The panel shows a live raw estimate **and VRAM after decode** — files on disk are packed ints, the viewer expands them to `vec4f` CPU-side at load (three.js uploads storage buffers as-is, so this decode is the price of small files, not a three.js requirement).
5. Set Folder + Name → **Quick Export** → `.glb` + `<name>_vat.bin` + `<name>_vat.json`.

Packing detail (`vat-storage/3`): per-vertex delta coding + sparse static vertices + varint diffs, gzipped-smallest combination wins. The `.json` sidecar (`format`, `vertexCount`, `frameCount`, `fps`, `min/maxOffset`, `layout`, `compression`) fully describes the `.bin`; the viewer refuses unknown formats instead of rendering garbage.

## B2. Play (three.js WebGPU, 3 lines)

```js
import { loadVatStorageMaterial } from './vat-storage.js'; // demo-threejs/src

const vat = await loadVatStorageMaterial('cloth_vat.bin', 'cloth_vat.json');
mesh.material = vat.material;   // mesh = the .glb from Quick Export (carries the uv1 bake ids)
vat.uniforms.frame.value = (t * vat.meta.fps) % vat.meta.frameCount; // each frame
```

That's it: one await, one material, one float per frame. Always use the Quick Export `.glb` — the vertex id is recovered from `uv1.x` (`u = (i+0.5)/V`, survives glTF vertex splits), and a `.bin` + `.glb` from different bakes warns `BIN/GLB mismatch`.

## B3. Weight guide

Raw = verts × frames × bytes (5/8/24 B per vertex per frame). Gzip ÷2–4 on top. VRAM after decode = **verts × frames × 32 B** (with normals) or **×16 B** (`none`).

| Config | VRAM | Verdict mobile |
|---|---|---|
| 5k × 30f | 5 MB | ✅ everywhere |
| 10k × 60f | 19 MB | ✅ everywhere |
| 20k × 60f | 38 MB | ✅ fine |
| 20k × 120f | 77 MB | ⚠️ mid-range only |
| 50k × 121f | ~190 MB | ❌ desktop only |

Levers, in order: **decimate** the source, **normals = none** (÷2), **frame step ×2** (viewer smooths), split the animation. Decode itself is ~20 ms for 5k×30f, ~0.3 s for 50k×121f on desktop (~3× on mobile) — the wall is VRAM and download size, never decode speed.

---

# Shared: modifiers, rules, dev

## Supported modifiers

Every mesh modifier bakes (evaluated via depsgraph, no allowlist) — but only these actually move vertices. The rest (collision, UV, weights, caches…) bake without effect. Live examples: click any link (each also ships a `_storage` variant, e.g. `?ex=wave_storage`).

| | | |
|---|---|---|
| [ARMATURE](https://vat.residenceprincipale.net/?ex=armature) | ARRAY | [BEVEL](https://vat.residenceprincipale.net/?ex=bevel) |
| BUILD | [CAST](https://vat.residenceprincipale.net/?ex=cast) | [CLOTH](https://vat.residenceprincipale.net/?ex=cloth) |
| [CURVE](https://vat.residenceprincipale.net/?ex=curve) | DECIMATE | [DISPLACE](https://vat.residenceprincipale.net/?ex=displace) |
| [EXPLODE](https://vat.residenceprincipale.net/?ex=explode) (+ tutorial below) | [HOOK](https://vat.residenceprincipale.net/?ex=hook) | [LAPLACIANDEFORM](https://vat.residenceprincipale.net/?ex=laplaciandeform) |
| [LAPLACIANSMOOTH](https://vat.residenceprincipale.net/?ex=laplaciansmooth) | [LATTICE](https://vat.residenceprincipale.net/?ex=lattice) | MASK |
| [MESH_DEFORM](https://vat.residenceprincipale.net/?ex=meshdeform) | MIRROR | [NODES](https://vat.residenceprincipale.net/?ex=nodes) (geometry nodes) |
| [OCEAN](https://vat.residenceprincipale.net/?ex=ocean) | PARTICLE_SYSTEM | REMESH |
| SCREW | [SHRINKWRAP](https://vat.residenceprincipale.net/?ex=shrinkwrap) | [SIMPLE_DEFORM](https://vat.residenceprincipale.net/?ex=twist) |
| [SMOOTH](https://vat.residenceprincipale.net/?ex=smooth) | [CORRECTIVE_SMOOTH](https://vat.residenceprincipale.net/?ex=correctivesmooth) | [SOFT_BODY](https://vat.residenceprincipale.net/?ex=softbody) |
| [SOLIDIFY](https://vat.residenceprincipale.net/?ex=solidify) | [SUBSURF](https://vat.residenceprincipale.net/?ex=subsurf) | [SURFACE_DEFORM](https://vat.residenceprincipale.net/?ex=surfacedeform) |
| [WARP](https://vat.residenceprincipale.net/?ex=warp) | [WAVE](https://vat.residenceprincipale.net/?ex=wave) | [WIREFRAME](https://vat.residenceprincipale.net/?ex=wireframe) |

Rules (both tracks):

1. **Bake simulations first.** Unbaked `CLOTH` / `PARTICLE_SYSTEM` aborts the bake with an error — on purpose, so you never export a static mesh thinking it's animated.
2. **Vertex count must be stable.** If topology changes mid-animation (animated `BOOLEAN`…), rows pad to the largest frame, motion may pop, a warning lists per-frame counts. Alembic (`MeshSequenceCache`) is fine as long as its own topology is constant — but put nothing *before* it in the stack, it overwrites everything; decimate via a proxy (decimated copy + Surface Deform) instead of a live Decimate.
3. **Remeshing every frame can't bake** (`VOLUME_TO_MESH` on an animated field…): vertices are recreated from scratch with no stable identity, offsets are meaningless. Only static volumes (object-level motion) bake cleanly.
4. **End frame is excluded**: the bake covers `range(start, end, step)`.

### EXPLODE in 4 clicks

The shader replays bind-pose faces, so chunks must be separate *before* simulating: select mesh → VAT tab → **Pre-split faces** (sharp-split every face; flat shading is normal) → add Particle System + `EXPLODE` → Cache > Bake All Dynamics → bake. Tip: Emission Start = End = 1 keeps the vertex count constant.

## Outputs reference

| Output | Track | Notes |
|---|---|---|
| `export_mesh` | both | Baked bind pose + `vertex_anim` UV layer (in-scene after Bake). Never delete the UV set |
| `positions` / `normals` | A | EXR half by default; PNG if Normalize (uses stored min/max) |
| `*_vat.bin` + `*_vat.json` | B | Packed frames + sidecar |
| `*.glb` | both | Always from Quick Export, **re-baked together** with the data |

## Test scene & viewer dev

- `blender-examples/vat_test.blend`: 25 `VAT_*` objects (timeline 1–61 → 60 baked frames), one per modifier family. Re-bake textures with `blender-examples/export_examples.py`, storage with `blender-examples/export_storage_examples.py` (batchable via `/tmp/vat_batch.json`, manifest accumulates in `/tmp/vat_storage_manifest.json` — merge into `demo-threejs/public/examples.json`, see the script footer).
- `demo-threejs/`: `bun install && bun run dev` (http://localhost:5173). 25 texture + 25 storage examples, EXAMPLE select + SOURCE toggle, drag & drop your own files, `?ex=<id>` + `?frame=N` deep links. `src/vat-material.js` = Track A sampling, `src/vat-storage.js` = Track B (`loadVatStorage` / `createVatStorageMaterial` / one-call `loadVatStorageMaterial`).
- No automated tests, no CI: verify in Blender 4.2+ (bake one `VAT_*` object) and in the viewer.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Cloth/Particle simulation is not baked!` | Cache > Bake All Dynamics first |
| Baked mesh doesn't move | Modifier *before* an Alembic cache (it overwrites all) — or unbaked sim |
| Motion pops / stretches | Topology changed across frames — stabilize topology first |
| `BIN/GLB mismatch` in viewer [B] | `.bin` and `.glb` from different bakes — re-run Quick Export |
| `Mesh has no second UV set` [B] | Source mesh exported by hand — use the Quick Export `.glb` |
| Banding in close-up [A] | Normalize+PNG quantizes — switch to EXR or Track B u16 |
| Huge `.bin` / mobile OOM [B] | Weight guide: decimate, normals none, frame step |
| `Select a mesh object` in panel | Active object isn't a mesh in Object mode |
