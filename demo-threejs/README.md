# VAT lab (three 0.186.0 + vite 8.3.0, no UI dependency)

Viewer for NONE / WRAP / WRAP_CROP plugin exports. Ships with bundled examples
(`public/examples.json` + `public/examples/<id>/<mode>/`, baked OFFSETS,
flip_Y ON, 30 frames) switchable from the EXAMPLE + WRAP selects (`?ex=<id>`,
`?wrap=<mode>` and `?frame=N` deep-link example / mode / paused frame).
Section 04 shows a realtime preview of both textures in bake-row order with
the sampled rows as playhead lines (`frame · mem rows […]`). Drop a bake in,
tune the params live.

Re-bake after scene changes: open `blender-tests/vat_test.blend` in Blender
4.2+ with the VAT addon enabled and run `blender-tests/export_examples.py`
(every `VAT_*` mesh → `<id>.glb` + `positions.exr` + `normals.png`).
`positions.exr` is written half-float planar-ABGR by the script itself:
Blender's `image.save()` EXR output misparses in third-party readers
(three.js, OIIO) while Blender roundtrips it fine, so the script serializes
from image pixels directly (verified texel-exact vs `image.pixels`).

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
