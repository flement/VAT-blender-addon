# ##### BEGIN GPL LICENSE BLOCK #####
#
#  This program is free software; you can redistribute it and/or
#  modify it under the terms of the GNU General Public License
#  as published by the Free Software Foundation; either version 2
#  of the License, or (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program; if not, write to the Free Software Foundation,
#  Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
#
# ##### END GPL LICENSE BLOCK #####

# <pep8 compliant>


bl_info = {
    "name": "Vertex Animation Toolkit",
    "author": "Joshua Bogart and Clément Renou",
    "version": (1, 0, 12),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > VAT Tab",
    "description": "A tool for storing per frame vertex data for use in a vertex shader.",
    "warning": "",
    "doc_url": "",
    "category": "VAT",
}


import bpy
import bmesh
import base64
import math
import gzip
import json
import os
import struct

def get_per_frame_mesh_data(context, data, objects):
    """Return a list of combined mesh data per frame"""
    meshes = []
    for i in frame_range(context.scene):
        context.scene.frame_set(i)
        depsgraph = context.evaluated_depsgraph_get()
        bm = bmesh.new()
        for ob in objects:
            eval_object = ob.evaluated_get(depsgraph)
            me = data.meshes.new_from_object(eval_object)
            me.transform(ob.matrix_world)
            bm.from_mesh(me)
            data.meshes.remove(me)
        me = data.meshes.new("mesh")
        bm.normal_update()
        bm.to_mesh(me)
        bm.free()
        me.update()
        meshes.append(me)
    return meshes

def calculate_optimal_vat_resolution(num_vertices, num_frames):
    total_pixels = num_vertices * num_frames
    approx_side = max(math.sqrt(total_pixels), 1)

    def closest_power_of_2(n):
        return 2 ** math.floor(math.log2(n))

    width = closest_power_of_2(approx_side)
    height = closest_power_of_2(approx_side)

    while width * height < total_pixels:
        if width < height:
            width *= 2
        else:
            height *= 2

    num_wraps = max(math.ceil(max(num_vertices, 1) / width), 1)

    return width, height, num_wraps

def create_export_mesh_object(context, data, me, size):
    """Return a mesh object with correct UVs"""
    vat = context.scene.vat_settings
    # STORAGE_BUFFER indexes frames by vertex id recovered from uv.x in the
    # shader (glTF export splits vertices on UV/normal seams, so vertexIndex
    # is unreliable): force the NONE layout where u == (i + 0.5) / N.
    wrap = 'NONE' if vat.export_mode == 'STORAGE_BUFFER' else vat.wrap_mode
    if wrap != 'NONE':
        width, height, num_wraps = calculate_optimal_vat_resolution(size[0], size[1])

    while len(me.uv_layers) < 2:
        me.uv_layers.new()
    uv_layer = me.uv_layers[1]
    uv_layer.name = "vertex_anim"
    if wrap != 'NONE':
        for loop in me.loops:
            u = (loop.vertex_index % width + 0.5) / width
            if wrap == 'WRAP_CROP':
                v = (loop.vertex_index // width) / num_wraps
            else:
                v = (loop.vertex_index // width) / height * size[1]
            if vat.flip_y:
                v = 1.0 - v - 1.0 / num_wraps
            uv_layer.data[loop.index].uv = (u, v)
    else:
        for loop in me.loops:
            uv_layer.data[loop.index].uv = (
                (loop.vertex_index + 0.5)/len(me.vertices),0.0)
    ob = data.objects.new("export_mesh", me)
    context.scene.collection.objects.link(ob)
    return ob


def get_vertex_data(context, data, meshes):
    """Return lists of vertex offsets and normals from a list of mesh data.

    Frames may hold different vertex counts (EXPLODE, BOOLEAN, ...): rows are
    sized to the largest frame; short frames repeat their last vertex
    (degenerate) and verts missing from the bind pose fall back to absolutes
    (their texels stay unsampled: export_mesh keeps bind-pose topology).
    """
    vat = context.scene.vat_settings
    original = meshes[0].vertices
    max_count = max(len(me.vertices) for me in meshes)
    offsets = []
    normals = []
    for me in reversed(meshes):
        verts = me.vertices
        last = verts[-1] if len(verts) else None
        for i in range(max_count):
            v = verts[i] if i < len(verts) else last
            if v is None:
                offsets.extend((0, 0, 0, 1))
                normals.extend((0.5, 0.5, 0.5, 1))
                continue
            if vat.position_mode == 'OFFSETS' and i < len(original):
                offset = v.co - original[i].co
            else:
                offset = v.co
            x, y, z = offset
            offsets.extend((x, -y, z, 1))
            x, y, z = v.normal
            normals.extend(((x + 1) * 0.5, (-y + 1) * 0.5, (z + 1) * 0.5, 1))
        if not me.users:
            data.meshes.remove(me)
    return offsets, normals


def frame_range(scene):
    """Return a range object with with scene's frame start, end, and step"""
    return range(scene.frame_start, scene.frame_end, scene.frame_step)

def normalize(value, min_value, max_value):
    """Normalize a value to the range [0, 1]"""
    return (value - min_value) / (max_value - min_value)


def bake_vertex_data(context, self, data, offsets, normals, size):
    """Stores vertex offsets and normals in separate image textures"""
    vat = context.scene.vat_settings
    width, height = size
    if vat.wrap_mode != 'NONE':
        optimal_width, optimal_height, num_wraps = calculate_optimal_vat_resolution(width, height)
        texture_width = optimal_width
    else:
        texture_width = max(width, 1)

    if vat.wrap_mode == 'WRAP':
        texture_height = optimal_height
    elif vat.wrap_mode == 'WRAP_CROP':
        texture_height = height * num_wraps
    else:
        texture_height = height

    offset_texture = data.images.new(
        name="positions",
        width=texture_width,
        height=texture_height,
        alpha=False,
        float_buffer=True,
    )
    normal_texture = data.images.new(
        name="normals",
        width=texture_width,
        height=texture_height,
        alpha=False
    )

    if vat.normalize:
        xyz = [v for i, v in enumerate(offsets) if i % 4 != 3]
        min_offset = min(xyz)
        max_offset = max(xyz)
        span = (max_offset - min_offset) or 1.0
        vat.min_offset = min_offset
        vat.max_offset = max_offset
        for i in range(0, len(offsets), 4):
            offsets[i] = (offsets[i] - min_offset) / span
            offsets[i + 1] = (offsets[i + 1] - min_offset) / span
            offsets[i + 2] = (offsets[i + 2] - min_offset) / span
        zero = (0.0 - min_offset) / span
    else:
        zero = 0.0

    if vat.wrap_mode != 'NONE':
        new_offsets = []
        new_normals = []
        optimal_width_pixels = optimal_width * 4
        width_pixels = width * 4
        for i in range(num_wraps):
            if i == num_wraps - 1:
                last_pixels_number = (len(offsets) - len(new_offsets)) / 4
                new_width = int(last_pixels_number / height)
                new_width_pixels = new_width * 4
                for j in range(height):
                    lineSample = j * width_pixels + i * optimal_width_pixels
                    new_offsets.extend(offsets[lineSample:lineSample+new_width_pixels])
                    new_offsets.extend([zero, zero, zero, 1] * (optimal_width - new_width))
                    new_normals.extend(normals[lineSample:lineSample+new_width_pixels])
                    new_normals.extend([0,0,0,1] * (optimal_width - new_width))
                break
            for j in range(height):
                lineSample = j * width_pixels + i * optimal_width_pixels
                new_offsets.extend(offsets[lineSample:lineSample+optimal_width_pixels])
                new_normals.extend(normals[lineSample:lineSample+optimal_width_pixels])

        if vat.wrap_mode == 'WRAP':
            new_offsets.extend([zero, zero, zero, 1] * int(optimal_width * optimal_height - len(new_offsets)/4))
            new_normals.extend([0,0,0,1] * int(optimal_width * optimal_height - len(new_normals)/4))
        else:
            new_offsets.extend([zero, zero, zero, 0] * int(optimal_width * height * num_wraps - len(new_offsets)/4))
            new_normals.extend([0,0,0,0] * int(optimal_width * height * num_wraps - len(new_normals)/4))

        offsets = new_offsets
        normals = new_normals

    offsets.extend([zero, zero, zero, 0] * (texture_width * texture_height - len(offsets) // 4))
    normals.extend([0,0,0,0] * (texture_width * texture_height - len(normals) // 4))

    # Flip Y textures
    def flip_y(texture, width, height):
        flipped = [0] * len(texture)
        row_size = width * 4
        for y in range(height):
            for x in range(row_size):
                flipped[(height - y - 1) * row_size + x] = texture[y * row_size + x]
        return flipped

    if vat.flip_y:
        offset_texture.pixels = flip_y(offsets, texture_width, texture_height)
        normal_texture.pixels = flip_y(normals, texture_width, texture_height)
    else:
        offset_texture.pixels = offsets
        normal_texture.pixels = normals
def write_exr_half(path, w, h, pixels, nch):
    """Write uncompressed half-float planar-ABGR EXR (see export_examples.py)."""
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


# Session cache for STORAGE_BUFFER mode: manual bake has no output folder,
# so raw frames are stashed here for Quick Export to write to disk.
_storage_cache = {}


# Storage precision presets: offsets layout + normals layout +
# bytes per vertex per frame. Normals stay octahedral except EXACT.
# Offsets = per-axis motion, quantized on 8/16/32 bits over the baked
# range (u8/u16/f32). Normals = per-vertex direction: octahedral ("oct",
# a unit direction folded to 2 bytes, ~0.7 deg max error) or raw float32.
# "bytes" is per vertex per frame for that part, before gzip.
OFFSET_FORMATS = {
    'U8': {"layout": "u8x3", "bytes": 3, "label": "u8 (3 B)",
           "about": "Motion on 8 bits per axis (~0.4% range steps, banding "
                    "possible close-up). Smallest."},
    'U16': {"layout": "u16x3", "bytes": 6, "label": "u16 (6 B)",
            "about": "Motion on 16 bits (~0.0015% steps, sub-mm at meter "
                     "scale). Default."},
    'F32': {"layout": "f32x3", "bytes": 12, "label": "f32 (12 B)",
            "about": "Motion unquantized (raw float32). Reference quality."},
}
NORMAL_FORMATS = {
    'OCT': {"layout": "oct8x2", "bytes": 2, "label": "oct (2 B)",
            "about": "Unit direction folded to 2 bytes (~0.7 deg max "
                     "error). Default."},
    'F32': {"layout": "f32x3", "bytes": 12, "label": "f32 (12 B)",
            "about": "Direction unquantized (raw float32). Reference."},
    'NONE': {"layout": "none", "bytes": 0, "label": "none (0 B)",
             "about": "Skip normals: lighting uses geometry normals. "
                      "Smallest."},
}


def format_bytes(n):
    """Human size for panel estimates (decimal MB, matches file browsers)."""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1000 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000


def count_selected_eval_verts(context):
    """Best-effort vertex count for the storage estimate.

    Bake combines every selected mesh after depsgraph eval, so the base
    mesh count lies whenever modifiers/caches add verts (Subdiv,
    MeshSequenceCache, ...). Probe the depsgraph once at the current
    frame; fall back to base counts if eval fails. Topology may still
    vary across frames (bake pads rows to the largest frame), so callers
    must label this a rough estimate.
    """
    objects = [ob for ob in context.selected_objects if ob.type == 'MESH']
    if not objects:
        return 0
    try:
        depsgraph = context.evaluated_depsgraph_get()
        total = 0
        for ob in objects:
            eval_ob = ob.evaluated_get(depsgraph)
            mesh = eval_ob.to_mesh()
            try:
                total += len(mesh.vertices)
            finally:
                eval_ob.to_mesh_clear()
        if total > 0:
            return total
    except Exception:
        pass
    return sum(len(ob.data.vertices) for ob in objects if ob.data)


def _oct_encode(nx, ny, nz):
    """Octahedral-encode a unit normal to 2 signed bytes (see vat-storage.js)."""
    l = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    nx, ny, nz = nx / l, ny / l, nz / l
    inv = 1.0 / ((abs(nx) + abs(ny) + abs(nz)) or 1.0)
    x, y = nx * inv, ny * inv
    if nz < 0.0:
        ox, oy = x, y
        x = (1.0 - abs(oy)) * (1.0 if ox >= 0.0 else -1.0)
        y = (1.0 - abs(ox)) * (1.0 if oy >= 0.0 else -1.0)
    return (max(-127, min(127, round(x * 127))),
            max(-127, min(127, round(y * 127))))


def _zz_encode(d):
    """Zigzag-encode a signed int to unsigned (see vat-storage.js)."""
    return ((d << 1) ^ (d >> 31)) & 0xFFFFFFFF


def _leb128_encode(u):
    """Unsigned LEB128 encode (varint, little-endian base-128)."""
    out = bytearray()
    while True:
        b = u & 0x7F
        u >>= 7
        if u:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _pack_bitmap(moving, v_count):
    """Pack a moving-vertex boolean list to bytes (bit i = vertex i moves)."""
    raw = bytearray((v_count + 7) // 8)
    for v, m in enumerate(moving):
        if m:
            raw[v // 8] |= 1 << (v % 8)
    return bytes(raw)


def write_storage_buffer(path, meta_path, offsets, normals, meta):
    """Write animation frames as a packed, gzipped buffer (vat-storage/3).

    Vertex-major order ([vertex][frame]): one vertex's consecutive frames
    sit next to each other, so gzip's 32 KB window sees temporal
    coherence (frame-major strided same-vertex samples ~400 KB apart on
    dense meshes, invisible to gzip).
    On top of the vat-storage/2 baseline (per-vertex delta coding +
    gzip, bit-exact on decode), /3 adds two file-level squeezes, both
    decoded CPU-side at load (the GPU buffer keeps its fixed stride):
    sparse static vertices (frame 0 stored for all vertices, later
    frames only for vertices that move; a base64 bitmap in the JSON
    sidecar lists them) and varint diffs (zigzag LEB128: small
    frame-to-frame diffs shrink to 1 byte instead of a fixed i16).
    Every combination is tried and the gzipped-smallest wins, so
    incompressible data transparently falls back to the /2 layout.
    F32 layouts are transposed (sparsely when it wins) but never
    delta-coded (float cumsum would drift). Layout "none" for normals
    stores no normal bytes at all (the viewer falls back to geometry
    normals).
    """
    # Offsets are always range-quantized (uniform 1/65535 steps over the
    # baked range: ~0.15mm on a 10m range). This replaces the Normalize
    # toggle for storage: meta carries its own range, the loader inverts it.
    n = meta["vertexCount"] * meta["frameCount"]
    layout = meta["layout"]
    skip_normals = layout["normals"] == "none"
    assert len(offsets) == n * 4
    assert len(normals) == (0 if skip_normals else n * 4)
    V, F = meta["vertexCount"], meta["frameCount"]
    xyz = [offsets[v * 4 + j] for v in range(n) for j in range(3)]
    min_o, max_o = min(xyz), max(xyz)
    span = (max_o - min_o) or 1.0
    meta["format"] = "vat-storage/3"
    meta["order"] = "vertex-major"
    meta["minOffset"] = min_o
    meta["maxOffset"] = max_o
    meta["normalize"] = False

    if layout["offsets"] in ("u8x3", "u16x3"):
        qmax = 255 if layout["offsets"] == "u8x3" else 65535
        atag = 'B' if layout["offsets"] == "u8x3" else 'H'
    elif layout["offsets"] == "f32x3":
        qmax = atag = None
    else:
        raise ValueError(f"Unknown offsets layout {layout['offsets']!r}")
    if layout["normals"] not in ("oct8x2", "f32x3", "none"):
        raise ValueError(f"Unknown normals layout {layout['normals']!r}")
    q = ([round((v - min_o) / span * qmax) for v in xyz]
         if qmax is not None else None)

    # Per-vertex quantized frames: qv[f][v] / octv[f][v].
    qv = None
    if q is not None:
        qv = [[tuple(q[(f * V + v) * 3 + j] for j in range(3))
               for v in range(V)] for f in range(F)]
    octv = None
    if layout["normals"] == "oct8x2":
        octv = [[_oct_encode(*normals[(f * V + v) * 4:(f * V + v) * 4 + 3])
                 for v in range(V)] for f in range(F)]

    # A vertex moves when any stored sample differs across frames
    # (quantized ints / exact floats: replication stays bit-exact).
    moving = [False] * V
    if qv is not None:
        for v in range(V):
            if any(qv[f][v] != qv[0][v] for f in range(1, F)):
                moving[v] = True
    else:
        for v in range(V):
            if any(xyz[(f * V + v) * 3 + j] != xyz[v * 3 + j]
                   for f in range(1, F) for j in range(3)):
                moving[v] = True
    if octv is not None:
        for v in range(V):
            if any(octv[f][v] != octv[0][v] for f in range(1, F)):
                moving[v] = True
    elif layout["normals"] == "f32x3":
        for v in range(V):
            if any(normals[(f * V + v) * 4 + j] != normals[v * 4 + j]
                   for f in range(1, F) for j in range(3)):
                moving[v] = True
    movers = [v for v, m in enumerate(moving) if m]

    # SPARSE[0] toggles sparse packing inside the closures below.
    # Layout stays strictly vertex-major ([vertex][frame], each vertex's
    # frames contiguous: gzip's 32 KB window sees temporal coherence).
    # Sparse only drops the later frames of static vertices; frame 0 is
    # always stored for every vertex.
    SPARSE = [False]

    def pack_offsets(encoding):
        # encoding: 'abs' | 'delta-fixed' | 'delta-varint' ('abs' also
        # covers the f32 transpose, which is never delta-coded).
        out = bytearray()
        if q is None:
            for v in range(V):
                framelist = range(F) if (not SPARSE[0] or moving[v]) else (0,)
                for f in framelist:
                    out += struct.pack('<3f', *[xyz[(f * V + v) * 3 + j] for j in range(3)])
            return out
        if encoding == 'abs':
            for v in range(V):
                for f in range(F):
                    out += struct.pack(f'<3{atag}', *qv[f][v])
            return out
        varint = encoding == 'delta-varint'
        dtag = 'b' if atag == 'B' else 'h'
        for v in range(V):
            out += struct.pack(f'<3{atag}', *qv[0][v])
            if SPARSE[0] and not moving[v]:
                continue
            for f in range(1, F):
                for j in range(3):
                    d = qv[f][v][j] - qv[f - 1][v][j]
                    out += _leb128_encode(_zz_encode(d)) if varint \
                        else struct.pack(f'<{dtag}', d)
        return out

    def pack_normals(encoding):
        out = bytearray()
        if layout["normals"] == "none":
            return out
        if layout["normals"] == "f32x3":
            for v in range(V):
                framelist = range(F) if (not SPARSE[0] or moving[v]) else (0,)
                for f in framelist:
                    i = (f * V + v) * 4
                    out += struct.pack('<3f', *normals[i:i + 3])
            return out
        if encoding == 'abs':
            for v in range(V):
                for f in range(F):
                    out += struct.pack('<2b', *octv[f][v])
            return out
        varint = encoding == 'delta-varint'
        for v in range(V):
            out += struct.pack('<2b', *octv[0][v])
            if SPARSE[0] and not moving[v]:
                continue
            for f in range(1, F):
                for j in range(2):
                    d = octv[f][v][j] - octv[f - 1][v][j]
                    out += _leb128_encode(_zz_encode(d)) if varint \
                        else struct.pack('<h', d)
        return out

    # Fixed-width deltas need diffs that fit (u8 -> i8, u16 -> i16);
    # varint fits everything. Oct diffs always fit i16 (+-127 range).
    maxd = 0
    if q is not None:
        for v in range(V):
            for f in range(1, F):
                for j in range(3):
                    d = abs(qv[f][v][j] - qv[f - 1][v][j])
                    if d > maxd:
                        maxd = d
    fixed_ok = q is None or maxd <= (127 if atag == 'B' else 32767)

    def zgz(b):
        return len(gzip.compress(bytes(b), compresslevel=9))

    def off_keys(sparse):
        suffix = '-sparse' if sparse else ''
        if q is None:
            return ['abs-f32' + suffix]
        keys = ['abs', 'delta-varint' + suffix]
        if fixed_ok:
            keys.append('delta-fixed' + suffix)
        return keys

    def nrm_keys(sparse):
        suffix = '-sparse' if sparse else ''
        if layout["normals"] == "none":
            return ['none']
        if layout["normals"] == "f32x3":
            return ['abs-f32' + suffix]
        return ['abs', 'delta-varint' + suffix, 'delta-fixed' + suffix]

    def pack_off_key(key):
        SPARSE[0] = key.endswith('-sparse')
        return pack_offsets('abs' if key.startswith('abs') else key.replace('-sparse', ''))

    def pack_nrm_key(key):
        if key == 'none':
            return bytearray()
        SPARSE[0] = key.endswith('-sparse')
        return pack_normals('abs' if key.startswith('abs') else key.replace('-sparse', ''))

    # Joint tournament over every (offsets, normals) pair, dense plus
    # sparse when something is static. The legacy /2 pairs are a subset
    # of the candidates, so /3 provably never loses to /2. Packed
    # lazily: only the winning bytes are retained.
    has_static = bool(movers) and len(movers) < V
    best = None
    for sparse in ([False, True] if has_static else [False]):
        for o in off_keys(sparse):
            ob = pack_off_key(o)
            for n in nrm_keys(sparse):
                if sparse and o == 'abs' and n in ('abs', 'none'):
                    continue  # already scored in the dense round
                nb = pack_nrm_key(n)
                size = zgz(bytes(ob) + bytes(nb))
                if best is None or size < best[0]:
                    best = (size, o, n, bytes(ob), bytes(nb))
    _, off_enc, nrm_enc, off_buf, nrm_buf = best
    buf = off_buf + nrm_buf
    SPARSE[0] = False
    off_sparse = off_enc.endswith('-sparse')
    nrm_sparse = nrm_enc.endswith('-sparse')
    use_delta = off_enc.startswith('delta')
    use_ndelta = nrm_enc.startswith('delta')
    use_varint = off_enc == 'delta-varint' or off_enc == 'delta-varint-sparse'
    use_nvarint = nrm_enc == 'delta-varint' or nrm_enc == 'delta-varint-sparse'
    sparse_on = off_sparse or nrm_sparse
    if sparse_on:
        meta["sparse"] = {"bitmap": base64.b64encode(
            _pack_bitmap(moving, V)).decode('ascii'),
            "staticCount": V - len(movers),
            "offsets": off_sparse, "normals": nrm_sparse}
    else:
        meta["sparse"] = None
    meta["delta"] = {"offsets": use_delta, "normals": use_ndelta}
    meta["varint"] = {"offsets": use_varint, "normals": use_nvarint}
    meta["compression"] = "gzip"
    with open(path, 'wb') as f:
        f.write(gzip.compress(buf))
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)


def is_simulation_baked(ob, mod_type):
    for mod in ob.modifiers:
        if mod.type != mod_type:
            continue
        if mod_type == 'PARTICLE_SYSTEM':
            psys = mod.particle_system
            cache = getattr(psys, 'point_cache', None) if psys else None
            if not getattr(cache, 'is_baked', False):
                return False
        elif not mod.point_cache.is_baked:
            return False
    return True

class OBJECT_OT_ProcessAnimMeshes(bpy.types.Operator):
    """Store combined per frame vertex offsets and normals for all
    selected mesh objects into seperate image textures"""
    bl_idname = "object.process_anim_meshes"
    bl_label = "Process Anim Meshes"

    @classmethod
    def poll(cls, context):
        ob = context.active_object
        return ob and ob.type == 'MESH' and ob.mode == 'OBJECT'

    def execute(self, context):
        units = context.scene.unit_settings
        data = bpy.data
        # Clean previous bake outputs: images.new() would otherwise create
        # positions.001 / normals.001 while images.get("positions") keeps
        # returning the stale imageless original (quick export then saves
        # an empty image and fails).
        old = data.objects.get("export_mesh")
        if old:
            data.objects.remove(old, do_unlink=True)
        for name in ("positions", "normals"):
            img = data.images.get(name)
            if img:
                data.images.remove(img)
        objects = [ob for ob in context.selected_objects if ob.type == 'MESH']
        vertex_count = sum([len(ob.data.vertices) for ob in objects])
        frame_count = len(frame_range(context.scene))
        if vertex_count > 8192:
            self.report(
                {'WARNING'},
                f"Vertex count of {vertex_count :,}, execedes limit of 8,192!, consider using wrap option"
            )
            # return {'CANCELLED'}
        if frame_count > 8192:
            self.report(
                {'WARNING'},
                f"Frame count of {frame_count :,}, execedes limit of 8,192! consider using frame step"
            )
            return {'CANCELLED'}
        for ob in objects:
            for mod in ob.modifiers:
                if mod.type == 'CLOTH' and not is_simulation_baked(ob, 'CLOTH'):
                    self.report(
                        {'ERROR'},
                        f"Cloth simulation for object {ob.name} is not baked!"
                    )
                    return {'CANCELLED'}
                if mod.type == 'PARTICLE_SYSTEM' and not is_simulation_baked(ob, 'PARTICLE_SYSTEM'):
                    self.report(
                        {'ERROR'},
                        f"Particle system for object {ob.name} is not baked!"
                    )
                    return {'CANCELLED'}

        meshes = get_per_frame_mesh_data(context, data, objects)
        export_mesh_data = meshes[0].copy()
        frame_counts = [len(me.vertices) for me in meshes]
        max_count = max(frame_counts)
        self.report(
            {'WARNING'},
            f"Original vertices: {len(meshes[0].vertices)}, Frames: {len(frame_range(context.scene))}"
        )
        if len(set(frame_counts)) > 1:
            self.report(
                {'WARNING'},
                f"Vertex count varies across frames {frame_counts}: rows padded to {max_count}, motion may pop"
            )
        texture_size = max_count, len(frame_range(context.scene))
        create_export_mesh_object(context, data, export_mesh_data, texture_size)
        offsets, normals = get_vertex_data(context, data, meshes)
        vat = context.scene.vat_settings
        if vat.export_mode == 'STORAGE_BUFFER':
            # No Normalize rescale here (PNG-only): write_storage_buffer
            # derives its own range and stores it in the JSON sidecar.
            _storage_cache['offsets'] = list(offsets)
            if NORMAL_FORMATS[vat.normal_precision]["layout"] == "none":
                _storage_cache['normals'] = []
            else:
                _storage_cache['normals'] = [n * 2.0 - 1.0 if i % 4 != 3 else n
                                             for i, n in enumerate(normals)]
            _storage_cache['vertex_count'] = max_count
            _storage_cache['frame_count'] = len(frame_range(context.scene))
            bpv = (OFFSET_FORMATS[vat.offset_precision]["bytes"]
                   + NORMAL_FORMATS[vat.normal_precision]["bytes"])
            nframes = len(frame_range(context.scene))
            self.report({'INFO'}, f"Storage buffer ready: {max_count} verts x "
                        f"{nframes} frames "
                        f"(~{format_bytes(max_count * nframes * bpv)} raw, "
                        f"use Quick Export to write files)")
        else:
            bake_vertex_data(context, self, data, offsets, normals, texture_size)

        return {'FINISHED'}


class OBJECT_OT_PrepareExplodeMesh(bpy.types.Operator):
    """Split all faces of selected meshes so EXPLODE keeps constant topology.

    Marks every edge sharp and applies a sharp-only Edge Split: each face
    becomes independent. Run once BEFORE adding particles / baking.
    Idempotent: re-running on an already split mesh changes nothing.
    """
    bl_idname = "object.prepare_explode_mesh"
    bl_label = "Prepare Explode Mesh"

    @classmethod
    def poll(cls, context):
        ob = context.active_object
        return ob and ob.type == 'MESH' and ob.mode == 'OBJECT'

    def execute(self, context):
        for ob in [o for o in context.selected_objects if o.type == 'MESH']:
            for e in ob.data.edges:
                e.use_edge_sharp = True
            mod = ob.modifiers.new('VAT_PreSplit', 'EDGE_SPLIT')
            mod.use_edge_angle = False
            mod.use_edge_sharp = True
            context.view_layer.objects.active = ob
            bpy.ops.object.modifier_apply(modifier=mod.name)
            self.report({'INFO'}, f"{ob.name}: {len(ob.data.vertices)} verts")
        return {'FINISHED'}


class OBJECT_OT_VATQuickExport(bpy.types.Operator):
    """Bake VAT with current panel settings and write .glb + textures to folder"""
    bl_idname = "object.vat_quick_export"
    bl_label = "Quick Export"

    @classmethod
    def poll(cls, context):
        ob = context.active_object
        vat = context.scene.vat_settings
        return ob and ob.type == 'MESH' and ob.mode == 'OBJECT' and bool(vat.export_directory)

    def execute(self, context):
        vat = context.scene.vat_settings
        directory = bpy.path.abspath(vat.export_directory)
        basename = vat.export_basename.strip() or "vat_export"
        os.makedirs(directory, exist_ok=True)
        # Snapshot selection: bake consumes it, export retargets it.
        src_objects = [ob for ob in context.selected_objects if ob.type == 'MESH']
        src_active = context.view_layer.objects.active
        # Reuse manual bake so panel choices stay authoritative.
        # (Bake cleans its previous outputs, no stale images.)
        res = bpy.ops.object.process_anim_meshes()
        if res != {'FINISHED'}:
            return res
        exp = bpy.data.objects.get("export_mesh")
        if not exp:
            self.report({'ERROR'}, "Bake produced no export_mesh")
            return {'CANCELLED'}
        if vat.export_mode == 'STORAGE_BUFFER':
            c = _storage_cache
            if not c.get('offsets'):
                self.report({'ERROR'}, "Storage bake produced no data")
                return {'CANCELLED'}
            # format id: bump when the .bin layout changes so old files
            # fail loudly in the viewer instead of rendering garbage.
            # (write_storage_buffer owns meta["format"]; sidecar fields
            # here just seed positionMode/fps.)
            meta = {"basename": basename, "positionMode": vat.position_mode.lower(),
                    # fps stays the render rate; frameStep tells the viewer
                    # the export stride so it plays at fps/step (same
                    # duration) and samples the matching grid.
                    "fps": context.scene.render.fps,
                    "frameStep": max(context.scene.frame_step, 1),
                    "normalize": vat.normalize,
                    "minOffset": vat.min_offset, "maxOffset": vat.max_offset}
            meta["vertexCount"] = c['vertex_count']
            meta["frameCount"] = c['frame_count']
            meta["layout"] = {
                "offsets": OFFSET_FORMATS[vat.offset_precision]["layout"],
                "normals": NORMAL_FORMATS[vat.normal_precision]["layout"]}
            write_storage_buffer(os.path.join(directory, basename + "_vat.bin"),
                                 os.path.join(directory, basename + "_vat.json"),
                                 c['offsets'], c['normals'], meta)
            bin_path = os.path.join(directory, basename + "_vat.bin")
        pos = bpy.data.images.get("positions")
        nrm = bpy.data.images.get("normals")
        if vat.export_mode != 'STORAGE_BUFFER' and (not pos or not nrm):
            self.report({'ERROR'}, "Bake produced no positions/normals")
            return {'CANCELLED'}
        if vat.export_mode != 'STORAGE_BUFFER':
            if vat.normalize:
                pos.file_format = 'PNG'
                pos.filepath_raw = os.path.join(directory, basename + "_positions.png")
                pos.save()
            else:
                write_exr_half(os.path.join(directory, basename + "_positions.exr"),
                               *pos.size[:], list(pos.pixels), pos.channels)
            nrm.file_format = 'PNG'
            nrm.filepath_raw = os.path.join(directory, basename + "_normals.png")
            nrm.save()
        bpy.ops.object.select_all(action='DESELECT')
        exp.select_set(True)
        context.view_layer.objects.active = exp
        bpy.ops.export_scene.gltf(filepath=os.path.join(directory, basename + ".glb"),
                                  export_format='GLB', use_selection=True)
        bpy.ops.object.select_all(action='DESELECT')
        for ob in src_objects:
            ob.select_set(True)
        context.view_layer.objects.active = src_active
        if vat.export_mode == 'STORAGE_BUFFER':
            parts = [f"Quick Export -> {directory} {basename}_vat.bin"]
            try:
                parts.append(f".bin {format_bytes(os.path.getsize(bin_path))}")
            except OSError:
                pass
            try:
                parts.append(f".glb {format_bytes(os.path.getsize(os.path.join(directory, basename + '.glb')))}")
            except OSError:
                pass
            self.report({'INFO'}, " / ".join(parts))
        else:
            self.report({'INFO'}, f"Quick Export -> {directory} {basename}.glb")
        return {'FINISHED'}


class VIEW3D_PT_VertexAnimation(bpy.types.Panel):
    """Creates a Panel in 3D Viewport"""
    bl_label = "Vertex Animation"
    bl_idname = "VIEW3D_PT_vertex_animation"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "VAT Toolkit"

    def draw(self, context):
        layout = self.layout
        layout.use_property_split = True
        layout.use_property_decorate = False
        scene = context.scene
        vat = scene.vat_settings
        obj = context.active_object
        meshes = [o for o in context.selected_objects if o.type == 'MESH']

        if obj is None or obj.type != 'MESH':
            layout.label(text="Select a mesh in Object mode", icon='ERROR')
            return

        # ---- 0 · What will bake (live validation) ----
        status = layout.box()
        status.label(text=f"{obj.name}", icon='MESH_DATA')
        nframes = len(frame_range(scene))
        eval_verts = count_selected_eval_verts(context)
        base_verts = sum(len(o.data.vertices) for o in meshes if o.data)
        status.label(text=f"{eval_verts:,} verts (evaluated) x {nframes} frames")
        if len(meshes) > 1:
            status.label(text=f"{len(meshes)} meshes combined into one bake", icon='INFO')
        if meshes and eval_verts != base_verts:
            status.label(text="Modifiers change the count: bake uses evaluated", icon='INFO')
        unbaked = [o.name for o in meshes for mod in o.modifiers
                   if (mod.type == 'CLOTH' and not is_simulation_baked(o, 'CLOTH'))
                   or (mod.type == 'PARTICLE_SYSTEM'
                       and not is_simulation_baked(o, 'PARTICLE_SYSTEM'))]
        for name in dict.fromkeys(unbaked):
            status.label(text=f"{name}: simulation NOT baked", icon='ERROR')
        if unbaked:
            status.label(text="Cache > Bake All Dynamics first")

        # ---- 1 · Animation range ----
        box = layout.box()
        box.label(text="1 · Range", icon='TIME')
        col = box.column(align=True)
        col.prop(scene, "frame_start", text="Start")
        col.prop(scene, "frame_end", text="End (excluded)")
        col.prop(scene, "frame_step", text="Step")
        if scene.frame_step > 1:
            box.label(text=f"Plays at {scene.render.fps / scene.frame_step:g} fps")

        # ---- 2 · Format (Track A = texture, Track B = storage) ----
        box = layout.box()
        if vat.export_mode == 'STORAGE_BUFFER':
            box.label(text="2 · Format — Track B: Storage", icon='FILE_IMAGE')
        else:
            box.label(text="2 · Format — Track A: Texture", icon='FILE_IMAGE')
        col = box.column(align=True)
        col.prop(vat, "position_mode", text="Positions")
        col.prop(vat, "export_mode", text="Backend")
        if vat.export_mode == 'STORAGE_BUFFER':
            col.prop(vat, "offset_precision", text="Offsets")
            col.prop(vat, "normal_precision", text="Normals")
            box.label(text="Packed on disk, expanded to f32 at load.")
            bpv = (OFFSET_FORMATS[vat.offset_precision]["bytes"]
                   + NORMAL_FORMATS[vat.normal_precision]["bytes"])
            # Rough pre-bake estimate: evaluated (not base) verts at the
            # current frame x UI frame range. The bake may exceed it when
            # topology grows across frames (rows pad to the largest frame).
            box.label(text=f"Est: ~{format_bytes(bpv * eval_verts * nframes)} raw "
                           f"({eval_verts:,} verts x {nframes} frames)")
            vram_bpv = 16 + (0 if vat.normal_precision == 'NONE' else 16)
            box.label(text=f"VRAM after decode: ~{format_bytes(vram_bpv * eval_verts * nframes)}")
        else:
            # Texture-only controls: no image is baked in Storage mode,
            # so flip/normalize/wrap have no effect there.
            col.prop(vat, "flip_y", text="Flip Y")
            col.prop(vat, "normalize", text="Normalize (for PNG)")
            if vat.normalize:
                box.label(text=f"Min: {vat.min_offset:.4f}  Max: {vat.max_offset:.4f}")
            col.prop(vat, "wrap_mode", text="Wrap")
            if vat.wrap_mode != 'NONE':
                optimal_width, optimal_height, num_wraps = calculate_optimal_vat_resolution(
                    len(obj.data.vertices), nframes)
                if vat.wrap_mode == 'WRAP':
                    box.label(text=f"Output: {optimal_width} x {optimal_height} "
                                   f"({nframes * num_wraps / optimal_height:.0%} used)")
                else:
                    box.label(text=f"Output: {optimal_width} x {nframes * num_wraps} "
                                   f"({num_wraps} wraps)")

        # ---- 3 · Bake & export ----
        box = layout.box()
        box.label(text="3 · Bake & export", icon='EXPORT')
        box.operator("object.process_anim_meshes", text="Bake (dry run, no files)")
        row = box.row()
        row.label(text="Particle EXPLODE only:")
        row.operator("object.prepare_explode_mesh", text="Pre-split faces")
        box.separator()
        box.prop(vat, "export_directory", text="Folder")
        box.prop(vat, "export_basename", text="Name")
        if vat.export_mode == 'STORAGE_BUFFER':
            box.label(text="Writes: .glb + _vat.bin + _vat.json")
        elif vat.normalize:
            box.label(text="Writes: .glb + _positions.png + _normals.png")
        else:
            box.label(text="Writes: .glb + _positions.exr + _normals.png")
        if not vat.export_directory:
            box.label(text="Set a folder to enable export", icon='INFO')
        box.operator("object.vat_quick_export", text="Quick Export (bake + files)")


class VATSettings(bpy.types.PropertyGroup):
    position_mode: bpy.props.EnumProperty(
        name="Position Mode",
        description="OFFSETS = motion relative to bind pose (smaller files); ABSOLUTES = world positions",
        items=[
            ('OFFSETS', "Offsets", "Motion relative to the bind pose"),
            ('ABSOLUTES', "Absolutes", "World-space positions")
        ],
        default='OFFSETS'
    )
    flip_y: bpy.props.BoolProperty(
        name="Flip Y",
        description="Flip Y",
        default=True
    )
    normalize: bpy.props.BoolProperty(
        name="Normalize",
        description="Normalize vertex normals",
        default=False
    )
    min_offset: bpy.props.FloatProperty(
        name="Min Offset",
        description="Min offset value",
        default=0
    )
    max_offset: bpy.props.FloatProperty(
        name="Max Offset",
        description="Max offset value",
        default=0
    )
    export_mode: bpy.props.EnumProperty(
        name="Export Mode",
        description="VAT Texture bakes images; Storage Buffer exports a flat .bin for WebGPU storage buffers",
        items=[
            ('VAT_TEXTURE', "VAT Texture", "Bake positions/normals images (current behavior)"),
            ('STORAGE_BUFFER', "Storage Buffer", "Export flat .bin + .json for WebGPU buffer<storage>"),
        ],
        default='VAT_TEXTURE'
    )
    wrap_mode: bpy.props.EnumProperty(
        name="Wrap Mode",
        description="Wrap texture mode",
        items=[
            ('NONE', "None", "Do not wrap texture"),
            ('WRAP', "Wrap", "Wrap texture to get closer to a square"),
            ('WRAP_CROP', "Wrap and Crop", "Wrap texture and crop to optimal size")
        ],
        default='NONE'
    )
    offset_precision: bpy.props.EnumProperty(
        name="Offset Precision",
        description="Motion packed as ints on disk, expanded to float32 at load (weight vs fidelity)",
        items=[(k, p["label"], p["about"])
               for k, p in OFFSET_FORMATS.items()],
        default='U16'
    )
    normal_precision: bpy.props.EnumProperty(
        name="Normal Precision",
        description="Direction packed (oct) or raw on disk, expanded at load (weight vs fidelity)",
        items=[(k, p["label"], p["about"])
               for k, p in NORMAL_FORMATS.items()],
        default='OCT'
    )
    export_directory: bpy.props.StringProperty(
        name="Export Folder",
        description="Quick Export output folder (.glb + textures)",
        subtype='DIR_PATH',
        default="",
    )
    export_basename: bpy.props.StringProperty(
        name="Export Name",
        description="Quick Export base file name",
        default="vat_export",
    )


def register():
    bpy.utils.register_class(VATSettings)
    bpy.utils.register_class(OBJECT_OT_ProcessAnimMeshes)
    bpy.utils.register_class(OBJECT_OT_PrepareExplodeMesh)
    bpy.utils.register_class(OBJECT_OT_VATQuickExport)
    bpy.utils.register_class(VIEW3D_PT_VertexAnimation)
    bpy.types.Scene.vat_settings = bpy.props.PointerProperty(type=VATSettings)


def unregister():
    # Tolerant: disable/reinstall cycles may run this with only part of
    # the addon registered; never leave Blender in a half-removed state.
    for cls in (VIEW3D_PT_VertexAnimation, OBJECT_OT_VATQuickExport,
                OBJECT_OT_PrepareExplodeMesh, OBJECT_OT_ProcessAnimMeshes,
                VATSettings):
        try:
            bpy.utils.unregister_class(cls)
        except (RuntimeError, ValueError):
            pass
    if hasattr(bpy.types.Scene, "vat_settings"):
        del bpy.types.Scene.vat_settings


if __name__ == "__main__":
    register()
