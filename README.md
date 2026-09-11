# VAT Blender Addon

This Blender plugin generates Vertex Animation Textures (VAT) from animated meshes. It is designed to simplify the export of complex animations to Three.js or other, using textures to store vertex movements.

https://github.com/user-attachments/assets/666ab17b-4e5b-4865-9454-8af4ba9a6aa2

## Concept
The Vertex Animation Texture (VAT) technique captures the movement of an animated mesh and encodes it into textures. Each pixel in the texture represents the position of a vertex at a specific frame of the animation.

In the generated texture, the vertical axis (top to bottom) corresponds to animation frames, and the horizontal axis (left to right) corresponds to the mesh vertices.

In a real-time engine (such as Three.js), the static mesh is imported along with its animation textures. A shader reads these textures frame by frame to move the vertices, thus reproducing the original animation without the need for an armature or complex calculations on the engine side. This method allows exporting complex animations, including those from physics simulations or modifiers, while optimizing rendering performance.

## Installation
1. Download this repo (or zip containing the `VAT` folder, with `VAT/__init__.py` + `VAT/blender_manifest.toml`, version 1.0.1).
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
| Y-flip             | Flip the Y axis in the exported textures if needed.                                                                                                                                                                                                                                                                                                         |                                                                                           |
| Normalize position | Normalize vertex positions to fit within a 0-1 range. This option is required if you want to export the animation texture as PNG, since PNG cannot encode negative values. At the end of the export, a "Min Offset" and a "Max Offset" are displayed to map values: 0 = Min Offset and 1 = Max Offset.                                                      | ![image](https://github.com/user-attachments/assets/0763a6b2-0844-4098-a157-808a1842ecfa) |
| Wrap mode          | Controls the layout of the animation texture. **None**: the texture is a single long strip (not optimal for GPUs). **Wrap**: positions are wrapped to new rows, making the texture more GPU-friendly (closer to a square or rectangle). **Wrap and crop**: like Wrap, but the texture is cropped to remove any empty space, resulting in a compact texture. | ![image](https://github.com/user-attachments/assets/6732e957-c689-455b-8aa1-8b24274ec93d) |

## Supported Modifiers

The following Blender modifiers are supported by the VAT addon:

| Modifier Name     |
|-------------------|
| ARMATURE          |
| CAST              |
| CLOTH             |
| CURVE             |
| DISPLACE          |
| HOOK              |
| LAPLACIANDEFORM   |
| LATTICE           |
| MESH_DEFORM       |
| SHRINKWRAP        |
| SIMPLE_DEFORM     |
| SMOOTH            |
| CORRECTIVE_SMOOTH |
| LAPLACIANSMOOTH   |
| SURFACE_DEFORM    |
| WARP              |
| WAVE              |
| PARTICLE_SYSTEM   |
| EXPLODE           |

**Warning:** If a modifier changes the number of vertices during the animation (such as `PARTICLE_SYSTEM` or `EXPLODE`), the plugin will not work correctly.

For `PARTICLE_SYSTEM`, it is recommended to set both the Emission Frame Start and End to 1 in the panel, and to start the animation at frame 1. This ensures the vertex count remains constant throughout the animation.

## Usage
1. Select an animated object in your Blender scene.
2. Bake the animation:
   - Go to the **Cache** section in the modifier panel.
   - Click **Bake All Dynamics** to bake the animation.
3. Access the addon panel (On the right near "Item" or "Tool" tab).
4. Configure the desired options (wrap mode, Y-flip, etc.).
5. Start the VAT texture generation.
6. The plugin will generate a new mesh `export_mesh` with a new uv set `vertex_anim`, and textures `positions` and `normals`.


| Output        | Description                                                             | Export Format & Settings                                                                                       |  Image                                                                                    |
|---------------|-------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `export_mesh` | Mesh with new UV set `vertex_anim`. Can be exported for use in engines. | .glb or other mesh formats                                                                                     | ![image](https://github.com/user-attachments/assets/aa5efc2a-5393-4b7b-86cd-af817c323b1e) |
| `positions`   | Vertex position animation texture.                                      | If `Normalize` is **false**: export as **OpenEXR**, `Color` `RGB`, `Color Depth` `Half` or `Full`, `Non-Color` | ![image](https://github.com/user-attachments/assets/5a60ca57-4aa7-43bd-addd-6b18c0931432) |
|               |                                                                         | If `Normalize` is **true**: export as **PNG**, same settings as above                                          | ![image](https://github.com/user-attachments/assets/d2aa6067-f177-4387-acf0-9af945ceaf3f) |
| `normals`     | Vertex normal animation texture.                                        | **PNG** or other supported formats                                                                             | ![image](https://github.com/user-attachments/assets/d2aa6067-f177-4387-acf0-9af945ceaf3f) |

## Test scene (`blender-tests/`)
- `blender-tests/vat_test.blend`: timeline 1–31 (step 1). Note `frame_range()` excludes the end frame → 30 baked frames.
- Covers `WAVE` (OFFSETS / wrap NONE), `SIMPLE_DEFORM` twist (ABSOLUTES + normalize + WRAP_CROP, step 2), `DISPLACE`, `ARMATURE` + `SMOOTH`.
- Recipe: open in Blender 4.2+ with VAT enabled, select ONE test object (not `export_mesh`), set options in the VAT tab, run `Process Anim Meshes`. See `blender-tests/README.md`.

## Three.js viewer (`demo-threejs/`)
- Vite + three 0.186.0 viewer for `NONE` / `WRAP` / `WRAP_CROP` exports. `src/vat-material.js` holds the VAT sampling (`MeshStandardMaterial` + `onBeforeCompile`, normals decoded `*2-1` + `.xzy` swizzle, `vatNormalUv` mirror kept).
- Run: `cd demo-threejs && bun install && bun run dev` (http://localhost:5173). Ships 4 bundled `VAT_*` examples with an EXAMPLE select; drop in Mesh `.glb` + Positions `.exr`/`.png` + Normals `.png`, tune bake params mirroring the Blender tab. See `demo-threejs/README.md`.

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
