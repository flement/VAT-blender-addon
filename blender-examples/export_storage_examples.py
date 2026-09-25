# Re-bake the demo-threejs examples from vat_test.blend in STORAGE BUFFER mode.
#
# Run inside Blender with the VAT addon enabled and vat_test.blend open
# (Blender Text Editor > Run Script, or via Blender MCP execute_code).
# Mirrors export_examples.py, but bakes with Export Mode = Storage Buffer
# (OFFSETS) and writes <repo>/demo-threejs/public/examples/<id>_storage/
# {<id>_storage.glb, <id>_storage_vat.bin, <id>_storage_vat.json}.
# Each export mesh is recentered on the origin (bbox center); OFFSETS are
# translation-invariant, so recentering changes only the .glb bind pose.
#
# Batching: set ONLY = ["Wave", ...] (ids, i.e. VAT_-stripped lower names)
# to export a subset; manifest entries accumulate in
# /tmp/vat_storage_manifest.json across runs. Merge them into
# public/examples.json afterwards (see merge note at the bottom).
#
# NOTE: topology may vary across frames (BOOLEAN, EXPLODE, ...): rows are
# sized to the largest frame, short frames repeat their last vertex.

import bpy
import json
import mathutils
import os

import VAT
from VAT import frame_range

try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:  # exec'd (Blender MCP): fall back to the repo checkout
    HERE = "/Users/9p/Documents/Github/VAT-blender-plugin/blender-examples"
BASE = os.path.normpath(os.path.join(HERE, "..", "demo-threejs", "public", "examples"))
MANIFEST_TMP = "/tmp/vat_storage_manifest.json"

# Same skips as export_examples.py (topology-breaking modifiers).
SKIP = {"decimate", "mask", "screw"}

# None = all VAT_* objects; otherwise only these ids.
ONLY = None
# Storage precision for every example (offsets / normals).
OFFSET_PRECISION = 'U16'
NORMAL_PRECISION = 'OCT'
if os.path.exists("/tmp/vat_batch.json"):
    _batch = json.load(open("/tmp/vat_batch.json"))
    ONLY = _batch.get("objects")
    OFFSET_PRECISION = _batch.get("offset_precision", OFFSET_PRECISION)
    NORMAL_PRECISION = _batch.get("normal_precision", NORMAL_PRECISION)


def main():
    scene = bpy.context.scene
    vat = scene.vat_settings
    vat.export_mode = 'STORAGE_BUFFER'
    vat.position_mode = 'OFFSETS'
    vat.normalize = False
    vat.offset_precision = OFFSET_PRECISION
    vat.normal_precision = NORMAL_PRECISION

    if os.path.exists(MANIFEST_TMP):
        with open(MANIFEST_TMP) as f:
            manifest = json.load(f)
    else:
        manifest = {"examples": []}
    done = {e["id"] for e in manifest["examples"]}

    sources = [ob for ob in bpy.data.objects
               if ob.type == 'MESH' and ob.name.startswith("VAT_") and ob.name != "export_mesh"
               and ob.name[len("VAT_"):].lower() not in SKIP]
    for ob in sorted(sources, key=lambda o: o.name):
        ex_id = ob.name[len("VAT_"):].lower() + "_storage"
        if ONLY is not None and ex_id not in ONLY and ex_id[:-len("_storage")] not in ONLY:
            continue
        if ex_id in done:
            print(f"skip {ob.name}: already in manifest")
            continue
        out = os.path.join(BASE, ex_id)
        os.makedirs(out, exist_ok=True)
        old = bpy.data.objects.get("export_mesh")
        if old:
            bpy.data.objects.remove(old, do_unlink=True)
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        scene.view_layers[0].objects.active = ob
        res = bpy.ops.object.process_anim_meshes()
        if res != {'FINISHED'}:
            print(f"SKIP {ob.name}: bake {res}")
            continue
        exp = bpy.data.objects.get("export_mesh")
        if not exp:
            print(f"SKIP {ob.name}: no export_mesh")
            continue
        # Center on origin (translation-invariant OFFSETS; .glb bind only).
        center = sum((mathutils.Vector(c) for c in exp.bound_box),
                     mathutils.Vector()) / 8
        for v in exp.data.vertices:
            v.co -= center
        c = VAT._storage_cache
        if not c.get('offsets'):
            print(f"SKIP {ob.name}: empty storage cache")
            continue
        # Range (min/max) and layout/compression are filled in by
        # VAT.write_storage_buffer, which range-quantizes unconditionally.
        meta = {"format": "vat-storage/1",
                "basename": ex_id,
                "positionMode": vat.position_mode.lower(),
                "fps": scene.render.fps,
                "vertexCount": c['vertex_count'],
                "frameCount": c['frame_count'],
                "layout": {
                    "offsets": VAT.OFFSET_FORMATS[OFFSET_PRECISION]["layout"],
                    "normals": VAT.NORMAL_FORMATS[NORMAL_PRECISION]["layout"]}}
        VAT.write_storage_buffer(os.path.join(out, ex_id + "_vat.bin"),
                                 os.path.join(out, ex_id + "_vat.json"),
                                 c['offsets'], c['normals'], meta)
        bpy.ops.object.select_all(action='DESELECT')
        exp.select_set(True)
        scene.view_layers[0].objects.active = exp
        bpy.ops.export_scene.gltf(filepath=os.path.join(out, f"{ex_id}.glb"),
                                  export_format='GLB', use_selection=True)
        manifest["examples"].append({
            "id": ex_id, "label": f"{ob.name} — {c['vertex_count']}v (storage)",
            "mesh": f"/examples/{ex_id}/{ex_id}.glb",
            "storage": f"/examples/{ex_id}/{ex_id}_vat.bin",
            "storageMeta": f"/examples/{ex_id}/{ex_id}_vat.json",
            "frames": c['frame_count'], "numWraps": 1,
            "positionMode": "offsets",
            "normalize": False, "minOffset": 0, "maxOffset": 1,
            "fps": scene.render.fps})
        with open(MANIFEST_TMP, "w") as f:
            json.dump(manifest, f, indent=2)
        print(f"baked {ob.name}: {c['vertex_count']}v x {c['frame_count']}f -> {out}")
    old = bpy.data.objects.get("export_mesh")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    print("storage examples so far:", [e["id"] for e in manifest["examples"]])


if __name__ == "__main__":
    main()


# Merge into the viewer manifest (run in a shell after all batches):
#   python3 -c "
#   import json
#   base = 'demo-threejs/public/examples.json'
#   d = json.load(open(base))
#   extra = json.load(open('/tmp/vat_storage_manifest.json'))['examples']
#   have = {e['id'] for e in d['examples']}
#   d['examples'] += [e for e in extra if e['id'] not in have]
#   json.dump(d, open(base, 'w'), indent=2)
#   print('total:', len(d['examples']))"
