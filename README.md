# VAT Blender Addon

**Live demo: https://vat.residenceprincipale.net/**

This Blender plugin bakes animated meshes for real-time engines (Three.js and others) in two formats: Vertex Animation Textures (VAT, images) and Vertex Animation Buffers (VAB, compact `.bin` + `.json` for WebGPU `buffer<storage>`). It is designed to simplify the export of complex animations — physics simulations, modifiers, skeletal motion — without armatures or per-frame CPU work on the engine side.

https://github.com/user-attachments/assets/666ab17b-4e5b-4865-9454-8af4ba9a6aa2

## Concept
The Vertex Animation Texture (VAT) technique captures the movement of an animated mesh and encodes it into textures. Each pixel in the texture represents the position of a vertex at a specific frame of the animation.

In the generated texture, the vertical axis (top to bottom) corresponds to animation frames, and the horizontal axis (left to right) corresponds to the mesh vertices.

In a real-time engine (such as Three.js), the static mesh is imported along with its animation textures. A shader reads these textures frame by frame to move the vertices, thus reproducing the original animation without the need for an armature or complex calculations on the engine side. This method allows exporting complex animations, including those from physics simulations or modifiers, while optimizing rendering performance.

### VAT Texture vs VAB (Storage Buffer)
| | VAT Texture | VAB (Storage Buffer) |
|---|---|---|
| Files | `positions.exr`/`.png` + `normals.png` + `.glb` | `<name>_vat.bin` (gzipped) + `<name>_vat.json` + `.glb` |
| Shader input | `sampler2D` (+ UVs) | `buffer<storage>` (TSL `storage()`) |
| Vertex id | `uv1` block math | `uv1.x` (`u = (i+0.5)/V`, split-proof) |
| Size control | wrap mode, PNG normalize | Offsets/Normals precision (u8/u16/f32, oct) |
| Best for | WebGL2, texture pipelines | WebGPU, many instances, GPU blending/IK |

VAB frames are packed (offsets as 8/16/32-bit per axis over the baked range, normals octahedral 2-byte or float32 — 5/8/24 bytes per vertex per frame) and gzipped. The JSON sidecar (`format`, `vertexCount`, `frameCount`, `fps`, `min/maxOffset`, `layout`, `compression`) fully describes the `.bin`; the viewer refuses unknown formats instead of rendering garbage.

## Installation
1. Download this repo — or grab the `VAT-vX.Y.Z.zip` from [Releases](../../releases) (published automatically when a `v*` tag matches `VAT/blender_manifest.toml`). The zip must contain `VAT/__init__.py` + `VAT/blender_manifest.toml` (currently 1.0.10).
2. In Blender 4.2+, go to **Edit > Preferences > Add-ons**.
3. Click **Install from Disk...** and select the `VAT` folder (or zip).
4. Enable the addon in the list.

## Features

![image](https://github.com/user-attachments/assets/e87f4660-a24a-4736-93cc-e8a24769317e)

| Feature            | Description                                                                                                                                                                                                                                                                                                                                                 | Image                                                                                     |
|--------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| Infos              | Displays information about the export: the name of the object to be encoded, the number of vertices (which determines the width), and the number of frames (which determines the height). In the example shown, the texture will be 144x30.                                                                                                                 | ![image](https://github.com/user-attachments/assets/230818ee-c749-4b1d-9b6d-404f8d302aae) |
| Step               | Choose the frame step for baking (e.g., every frame, every 2 frames, etc.). This allows you to reduce the number of frames and thus obtain a smaller texture. Since positions are encoded in a texture, linear filter can be used to smooth the pixels (and therefore the positions).                                                                       |                                                                                           |
| Position mode      | Export positions as offsets or absolute values. If set to "offset", the positions are stored relative to the object's initial position. If set to "absolute", the positions are stored in world space, starting from the world origin (0,0,0).                                                                                                              |                                                                                           |
| Y-flip             | Flip the Y axis in the exported textures if needed. (VAT Texture only — hidden in Storage mode.)                                                                                                                                                                                                                                                                                                         |                                                                                           |
| Normalize position | Normalize vertex positions to fit within a 0-1 range. This option is required if you want to export the animation texture as PNG, since PNG cannot encode negative values. At the end of the export, a "Min Offset" and a "Max Offset" are displayed to map values: 0 = Min Offset and 1 = Max Offset. (VAT Texture only — Storage quantizes its own range.)                                                      | ![image](https://github.com/user-attachments/assets/0763a6b2-0844-4098-a157-808a1842ecfa) |
| Wrap mode          | Controls the layout of the animation texture. **None**: the texture is a single long strip (not optimal for GPUs). **Wrap**: positions are wrapped to new rows, making the texture more GPU-friendly (closer to a square or rectangle). **Wrap and crop**: like Wrap, but the texture is cropped to remove any empty space, resulting in a compact texture. (VAT Texture only.) | ![image](https://github.com/user-attachments/assets/6732e957-c689-455b-8aa1-8b24274ec93d) |
| Export Mode        | **VAT Texture** (current behavior, images) or **Storage Buffer** (flat `.bin` + `.json` for WebGPU `buffer<storage>`). Switching modes swaps the panel section: texture controls hide in Storage mode and vice versa. |  |
| Offsets / Normals  | (Storage mode, with live weight estimate.) Two independent precisions. **Offsets** = per-axis motion: `u8 (3 B)` (~0.4% range steps, preview), `u16 (6 B)` (~0.0015% steps, sub-mm at meter scale, default), `f32 (12 B)` (unquantized). **Normals** = per-vertex direction: `oct (2 B)` (unit direction folded to 2 bytes, ~0.7 deg max error, default) or `f32 (12 B)`. Any combination works; the JSON `layout` records it. |  |

## Supported Modifiers

Every mesh modifier bakes (no allowlist), but only these actually move
vertices — the rest (collision, UV, weights, normals-only, caches…) bake
without effect:

| | | |
|---|---|---|
| [ARMATURE](https://vat.residenceprincipale.net/?ex=armature) | ARRAY | [BEVEL](https://vat.residenceprincipale.net/?ex=bevel) |
| | BUILD | [CAST](https://vat.residenceprincipale.net/?ex=cast) |
| [CLOTH](https://vat.residenceprincipale.net/?ex=cloth) | [CURVE](https://vat.residenceprincipale.net/?ex=curve) | DECIMATE |
| [DISPLACE](https://vat.residenceprincipale.net/?ex=displace) | [EXPLODE](https://vat.residenceprincipale.net/?ex=explode) | [HOOK](https://vat.residenceprincipale.net/?ex=hook) |
| [LAPLACIANDEFORM](https://vat.residenceprincipale.net/?ex=laplaciandeform) | [LAPLACIANSMOOTH](https://vat.residenceprincipale.net/?ex=laplaciansmooth) | [LATTICE](https://vat.residenceprincipale.net/?ex=lattice) |
| MASK | [MESH_DEFORM](https://vat.residenceprincipale.net/?ex=meshdeform) | MIRROR |
| [NODES](https://vat.residenceprincipale.net/?ex=nodes) | [OCEAN](https://vat.residenceprincipale.net/?ex=ocean) | PARTICLE_SYSTEM |
| REMESH | SCREW | [SHRINKWRAP](https://vat.residenceprincipale.net/?ex=shrinkwrap) |
| [SIMPLE_DEFORM](https://vat.residenceprincipale.net/?ex=twist) | [SMOOTH](https://vat.residenceprincipale.net/?ex=smooth) | [CORRECTIVE_SMOOTH](https://vat.residenceprincipale.net/?ex=correctivesmooth) |
| [SOFT_BODY](https://vat.residenceprincipale.net/?ex=softbody) | [SOLIDIFY](https://vat.residenceprincipale.net/?ex=solidify) | [SUBSURF](https://vat.residenceprincipale.net/?ex=subsurf) |
| [SURFACE_DEFORM](https://vat.residenceprincipale.net/?ex=surfacedeform) | [WARP](https://vat.residenceprincipale.net/?ex=warp) | [WAVE](https://vat.residenceprincipale.net/?ex=wave) |
| [WIREFRAME](https://vat.residenceprincipale.net/?ex=wireframe) | | |

Names without a link have no bundled example yet (`demo-threejs/public/examples.json`). Every linked example also ships a storage variant selectable in the viewer (same id + `_storage`, e.g. `?ex=wave_storage`).

Two rules:
1. Bake simulations first (Cache > Bake All Dynamics) — unbaked `CLOTH` / `PARTICLE_SYSTEM` aborts with an error.
2. Vertex count changes mid-animation (e.g. animated `BOOLEAN`) bake best-effort: rows pad to the largest frame, a warning lists per-frame counts, motion may pop.
3. Modifiers that rebuild the mesh every frame (`VOLUME_TO_MESH` on an animated field) cannot bake as animation: unlike `EXPLODE` — which moves existing vertices, so pre-splitting faces keeps their identity — remeshing recreates vertices from scratch each frame with no stable identity, so offsets are meaningless and the result tears. No pre-split equivalent exists. Only a static volume (object-level motion) bakes cleanly.

### EXPLODE tutorial

The shader replays bind-pose faces, so chunks must already be separate:
1. Select the mesh → VAT tab → **Prepare Explode Mesh** (splits every face; flat shading is normal; re-runnable).
2. Add Particle System + `EXPLODE`.
3. Cache > Bake All Dynamics.
4. Select the mesh → **Process Anim Meshes**.

`PARTICLE_SYSTEM` tip: Emission Start = End = 1 keeps the vertex count constant.

## Usage
1. Select an animated object in your Blender scene.
2. Bake the animation:
   - Go to the **Cache** section in the modifier panel.
   - Click **Bake All Dynamics** to bake the animation.
3. Access the addon panel (On the right near "Item" or "Tool" tab).
4. Pick **Export Mode** (VAT Texture or Storage Buffer) and configure its section (texture controls hide in Storage mode and vice versa).
5. **Bake (manual)** (optional dry run): validates the bake and creates `export_mesh` (bind pose + `vertex_anim` UVs). In VAT Texture mode it also creates the `positions`/`normals` images inside Blender; in Storage mode it stages the frames in memory and reports the raw weight — **no files are written**.
6. **Quick Export** (bake + files): set Folder + Name, run it. It re-bakes with the panel settings and writes everything to disk (see Outputs).


| Output        | Description                                                             | Export Format & Settings                                                                                       |  Image                                                                                    |
|---------------|-------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `export_mesh` | Mesh with new UV set `vertex_anim`. Can be exported for use in engines. **Keep the `vertex_anim` UVs on export**: VAT reads block coordinates from them, VAB reads the vertex id (`uv1.x`) — deleting the set breaks both. | .glb or other mesh formats                                                                                     | ![image](https://github.com/user-attachments/assets/aa5efc2a-5393-4b7b-86cd-af817c323b1e) |
| `positions`   | Vertex position animation texture.                                      | If `Normalize` is **false**: export as **OpenEXR**, `Color` `RGB`, `Color Depth` `Half` or `Full`, `Non-Color` | ![image](https://github.com/user-attachments/assets/5a60ca57-4aa7-43bd-addd-6b18c0931432) |
|               |                                                                         | If `Normalize` is **true**: export as **PNG**, same settings as above                                          | ![image](https://github.com/user-attachments/assets/d2aa6067-f177-4387-acf0-9af945ceaf3f) |
| `normals`     | Vertex normal animation texture.                                        | **PNG** or other supported formats
| `*_vat.bin`   | Packed animation frames (offsets then normals, gzipped).                | Chosen Offsets/Normals precision (5/8/24 B per vertex per frame raw)                           |                                                                                           |
| `*_vat.json`  | Sidecar describing the `.bin` (`format`, `vertexCount`, `frameCount`, `fps`, `min/maxOffset`, `layout`, `compression`). | JSON                                                                                           |                                                                                           |                                                                             | ![image](https://github.com/user-attachments/assets/d2aa6067-f177-4387-acf0-9af945ceaf3f) |

## Test scene (`blender-examples/`)
- `blender-examples/vat_test.blend`: timeline 1–61 (step 1). Note `frame_range()` excludes the end frame → 60 baked frames.
- Covers one `VAT_*` object per modifier family (ARMATURE, CAST, CLOTH draped on a collider, CURVE, DISPLACE, HOOK, LATTICE, MESH_DEFORM, SHRINKWRAP, SMOOTH family on hook spikes, SURFACE_DEFORM, SIMPLE_DEFORM twist, WARP, WAVE, SUBSURF, pre-split EXPLODE…).
- Recipe: open in Blender 4.2+ with VAT enabled, select ONE test object (not `export_mesh`), set options in the VAT tab, run `Process Anim Meshes`. Re-bake all texture examples with `blender-examples/export_examples.py`, all storage examples with `blender-examples/export_storage_examples.py` (see their headers; the storage script supports batches via `/tmp/vat_batch.json`).

## Three.js viewer (`demo-threejs/`)
- Vite + three 0.186.0 viewer for VAT Texture (`NONE` / `WRAP` / `WRAP_CROP`) and VAB storage exports. `src/vat-material.js` holds the VAT sampling (`MeshStandardNodeMaterial` + TSL nodes, normals decoded `*2-1` + `.xzy` swizzle, `vatNormalUv` mirror kept); `src/vat-storage.js` holds the VAB path (`.bin` + `.json` → `StorageBufferAttribute` via `decodeVatBuffer`, vertex id from `uv1.x`, integer frame quantization).
- Run: `cd demo-threejs && bun install && bun run dev` (http://localhost:5173, live: https://vat.residenceprincipale.net/). Ships 25 texture + 25 storage-buffer `VAT_*` examples (each mesh recentered on origin) with an EXAMPLE select and a SOURCE toggle (vat texture / storage buffer). Texture mode: drop in Mesh `.glb` + Positions `.exr`/`.png` + Normals `.png`. Storage mode: drop in Mesh `.glb` + VAT BIN `.bin` + VAT META `.json`; the viewer checks the bake ids (`⚠ BIN/GLB mismatch` if `.bin` and `.glb` come from different bakes) and takes `fps` from the JSON. See `demo-threejs/README.md`.
- Deep links: `?ex=<id>` (example id from `demo-threejs/public/examples.json`, e.g. `/?ex=twist` for the Simple Deform modifier) + `?frame=N` (paused 0-based frame, e.g. `/?ex=explode&frame=10`).

## Usage for threejs
Blender uses Z as the up axis, while in Three.js the up axis is Y. Therefore, when sampling the position texture in GLSL, you should use `texturePos.xzy` to correctly map the axes.
```glsl
// vertexShader.glsl
attribute vec2 uv1; // define uv1 attribute for vertex_anim uv set
uniform sampler2D posTexture; // positions.exr or positions.png
uniform sampler2D normalTexture; // normals.png

uniform float uTime; // time in seconds
uniform float totalFrames;
uniform float fps; 

varying vec3 vNormal;

void main() {
	// calculate uv coordinates
	float frame = mod(uTime * fps, totalFrames) / totalFrames;

	// get the position from the texture
	vec4 texturePos = texture(posTexture, vec2(uv1.x, uv1.y - frame));
   
    // get the normal from the texture
	vec4 textureNormal = texture(normalTexture, vec2(uv1.x, uv1.y - frame)) * 2.0 - 1.0;
	vNormal = textureNormal.xzy;

	// translate the position
	vec4 translated = vec4(position + texturePos.xzy, 1.0);
	gl_Position = projectionMatrix * modelViewMatrix * translated;
}
```

### Storage buffer (VAB) in three.js WebGPU (TSL)
Same idea, no textures: the `.bin` (gunzipped + decoded by `decodeVatStorage`
in `demo-threejs/src/vat-storage.js`) becomes two `StorageBufferAttribute`s
(offsets, normals as `vec4`), and the vertex id comes from `uv1.x`
(`u = (i + 0.5) / V`, shared by every glTF-split copy of vertex `i`).
```js
import { attribute, float, floor, mod, storage } from 'three/tsl'

const vid = floor(attribute('uv1').x.mul(vertexCount)) // bake vertex id
const frameI = floor(mod(frame, frameCount))           // integer row: no filtering
const row = frameCount.sub(1).sub(frameI).mul(vertexCount).add(vid)
const offset = storage(offsets, 'vec4', ...).element(row) // (x, -y, z), Blender space
material.positionNode = positionLocal.add(offset.xzy)     // xzy: Blender Z-up -> three Y-up
```
See `demo-threejs/src/vat-storage.js` (`loadVatStorage`, `createVatStorageMaterial`) for the full material including normals (`.xzy` like positions) and normalize support.
