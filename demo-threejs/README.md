# VAT lab (three 0.186.0 + vite 8.3.0, no UI dependency)

Viewer for `wrap NONE` plugin exports. Drop a bake in, tune the params live.

```sh
cd demo-threejs
bun install
bun run dev   # http://localhost:5173
```

Left panel, top to bottom: asset drop slots (Mesh `.glb`, Positions
`.exr`/`.png`, Normals `.png` optional), texture status, Bake params
mirroring the Blender VAT tab (`frames`, `positionMode`, `flip_y`,
`normalize` + `min`/`max` offsets copied from the Blender panel), Playback
(play / time scrub / fps / reverse / frame readout).

`src/vat-material.js` holds the VAT sampling for wrap NONE (see its header
for the row derivation from `VAT/__init__.py`). It builds on
`MeshStandardMaterial` via `onBeforeCompile`, so real three.js lights apply:
a directional sun, a hemisphere fill, and a room environment. Normals are
decoded (`*2-1`, `.xzy` swizzle like positions) into `objectNormal`, letting
three's standard lighting pipeline do the rest.
