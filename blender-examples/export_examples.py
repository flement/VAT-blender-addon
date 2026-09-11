# Re-bake the demo-threejs examples from this test scene.
#
# Run inside Blender 4.2+ with the VAT addon enabled and vat_test.blend open
# (Blender Text Editor > Run Script, or via Blender MCP execute_code).
# Bakes every MESH object named VAT_* in WRAP_CROP mode (OFFSETS / flip_y ON)
# and writes <repo>/demo-threejs/public/examples/<id>/{.glb,positions.exr,normals.png}
# plus public/examples.json consumed by the viewer.
#
# NOTE: positions.exr is written by write_exr_half() below, NOT by
# image.save(): Blender's EXR serializer output misparses in third-party
# readers (three.js EXRLoader, OIIO) while Blender itself roundtrips it fine.
# The custom writer emits plain uncompressed half-float planar ABGR, which
# three.js parses exactly (verified texel-for-texel against image pixels).

import bpy
import json
import os
import struct

from VAT import calculate_optimal_vat_resolution, frame_range

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:  # exec'd (Blender MCP): fall back to the repo checkout
    HERE = "/Users/9p/Documents/Github/VAT-blender-plugin/blender-tests"
BASE = os.path.normpath(os.path.join(HERE, "..", "demo-threejs", "public", "examples"))


def write_exr_half(path, w, h, pixels, nch):
    """Write uncompressed half-float planar-ABGR EXR from flat RGBA pixels."""
    order = [(b'A', 3), (b'B', 2), (b'G', 1), (b'R', 0)]

    def get(i, si):
        return pixels[i * nch + si] if si < nch else 1.0

    ch = b''.join(n + b'\x00' + struct.pack('<iB3xii', 1, 0, 1, 1) for n, _ in order) + b'\x00'

    def attr(n, t, v):
        return n + b'\x00' + t + b'\x00' + struct.pack('<i', len(v)) + v

    hdr = struct.pack('<2i', 20000630, 2)
    hdr += attr(b'channels', b'chlist', ch)
    hdr += attr(b'compression', b'compression', b'\x00')
    hdr += attr(b'dataWindow', b'box2i', struct.pack('<4i', 0, 0, w - 1, h - 1))
    hdr += attr(b'displayWindow', b'box2i', struct.pack('<4i', 0, 0, w - 1, h - 1))
    hdr += attr(b'lineOrder', b'lineOrder', b'\x00')
    hdr += attr(b'pixelAspectRatio', b'float', struct.pack('<f', 1.0))
    hdr += b'\x00'
    blocks = []
    for y in range(h):
        px = bytearray()
        for _, si in order:
            for x in range(w):
                v = get(y * w + x, si)
                px += struct.pack('<e', min(max(v, -65500.0), 65500.0))
        blocks.append(struct.pack('<II', y, len(px)) + bytes(px))
    off = len(hdr) + 8 * h
    tbl = b''
    for b in blocks:
        tbl += struct.pack('<Q', off)
        off += len(b)
    with open(path, 'wb') as f:
        f.write(hdr + tbl + b''.join(blocks))


def expected_size(wrap_mode, nv, nf):
    if wrap_mode == 'NONE':
        return nv, nf, 1
    width, height, num_wraps = calculate_optimal_vat_resolution(nv, nf)
    if wrap_mode == 'WRAP':
        return width, height, num_wraps
    return width, nf * num_wraps, num_wraps


def main():
    scene = bpy.context.scene
    vat = scene.vat_settings
    vat.position_mode = 'OFFSETS'
    vat.flip_y = True
    vat.normalize = False
    vat.wrap_mode = 'WRAP_CROP'

    manifest = {"examples": []}
    sources = [ob for ob in bpy.data.objects
               if ob.type == 'MESH' and ob.name.startswith("VAT_") and ob.name != "export_mesh"]
    for ob in sorted(sources, key=lambda o: o.name):
        ex_id = ob.name[len("VAT_"):].lower()
        out = os.path.join(BASE, ex_id)
        os.makedirs(out, exist_ok=True)
        old = bpy.data.objects.get("export_mesh")
        if old:
            bpy.data.objects.remove(old, do_unlink=True)
        for name in ("positions", "normals"):
            img = bpy.data.images.get(name)
            if img:
                bpy.data.images.remove(img)
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        scene.view_layers[0].objects.active = ob
        bpy.ops.object.process_anim_meshes()
        exp = bpy.data.objects.get("export_mesh")
        pos = bpy.data.images.get("positions")
        nrm = bpy.data.images.get("normals")
        nv, nf = len(exp.data.vertices), len(frame_range(scene))
        exp_w, exp_h, num_wraps = expected_size('WRAP_CROP', nv, nf)
        assert tuple(pos.size[:]) == (exp_w, exp_h), (pos.size, exp_w, exp_h)
        write_exr_half(os.path.join(out, "positions.exr"), *pos.size[:],
                       list(pos.pixels), pos.channels)
        nrm.file_format = 'PNG'
        nrm.filepath_raw = os.path.join(out, "normals.png")
        nrm.save()
        bpy.ops.object.select_all(action='DESELECT')
        exp.select_set(True)
        scene.view_layers[0].objects.active = exp
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, f"{ex_id}.glb"),
                                  export_format='GLB', use_selection=True)
        manifest["examples"].append({
            "id": ex_id, "label": f"{ob.name} — {nv}v",
            "mesh": f"/examples/{ex_id}/{ex_id}.glb",
            "positions": f"/examples/{ex_id}/positions.exr",
            "normals": f"/examples/{ex_id}/normals.png",
            "frames": nf, "numWraps": num_wraps,
            "positionMode": "offsets", "flipY": True,
            "normalize": False, "minOffset": 0, "maxOffset": 1, "fps": 24})
        print(f"baked {ob.name}: {nv}v x {nf}f -> {exp_w}x{exp_h}")
    with open(os.path.join(BASE, "..", "examples.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    old = bpy.data.objects.get("export_mesh")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    for name in ("positions", "normals"):
        img = bpy.data.images.get(name)
        if img:
            bpy.data.images.remove(img)
    print("examples:", [e["id"] for e in manifest["examples"]])


if __name__ == "__main__":
    main()
