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
    "name": "VAT",
    "author": "Joshua Bogart and Clément Renou",
    "version": (1, 0, 6),
    "blender": (4, 2, 0),
    "location": "View3D > Sidebar > VAT Tab",
    "description": "A tool for storing per frame vertex data for use in a vertex shader.",
    "warning": "",
    "doc_url": "",
    "category": "VAT",
}


import bpy
import bmesh
import math

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
    if vat.wrap_mode != 'NONE':
        width, height, num_wraps = calculate_optimal_vat_resolution(size[0], size[1])

    while len(me.uv_layers) < 2:
        me.uv_layers.new()
    uv_layer = me.uv_layers[1]
    uv_layer.name = "vertex_anim"
    if vat.wrap_mode != 'NONE':
        for loop in me.loops:
            u = (loop.vertex_index % width + 0.5) / width
            if vat.wrap_mode == 'WRAP_CROP':
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


class VIEW3D_PT_VertexAnimation(bpy.types.Panel):
    """Creates a Panel in 3D Viewport"""
    bl_label = "Vertex Animation"
    bl_idname = "VIEW3D_PT_vertex_animation"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "VAT"

    def draw(self, context):
        layout = self.layout
        obj = context.active_object
        layout.use_property_split = True
        layout.use_property_decorate = False
        scene = context.scene

        if obj is None or obj.type != 'MESH':
            layout.label(text="Select a mesh object")
            return

        layout.label(text=f"Object To Encode: {obj.name}", icon='MOD_DATA_TRANSFER')
        layout.label(text=f"Vertex Count: {len(obj.data.vertices)}, Frame Count: {len(frame_range(scene))}")

        col = layout.column(align=True)

        col.prop(scene, "frame_start", text="Frame Start")
        col.prop(scene, "frame_end", text="End")
        col.prop(scene, "frame_step", text="Step")
        col.prop(scene.vat_settings, "position_mode", text="Position Mode")
        col.prop(scene.vat_settings, "flip_y", text="Flip Y")
        col.prop(scene.vat_settings, "normalize", text="Normalize (useful for png)")
        if scene.vat_settings.normalize:
            col.label(text=f"Min Offset: {scene.vat_settings.min_offset:.4f}")
            col.label(text=f"Max Offset: {scene.vat_settings.max_offset:.4f}")
        col.prop(scene.vat_settings, "wrap_mode", text="Wrap Mode")
        if scene.vat_settings.wrap_mode != 'NONE':
            optimal_width, optimal_height, num_wraps = calculate_optimal_vat_resolution(len(obj.data.vertices), len(frame_range(scene)))
            y_percent_used = len(frame_range(scene)) * num_wraps / optimal_height
            if scene.vat_settings.wrap_mode == 'WRAP':
                col.label(text=f"Output Size: {optimal_width} x {optimal_height}")
                col.label(text=f"Y Used: {y_percent_used}")
            else:
                col.label(text=f"Output Size: {optimal_width} x {len(frame_range(scene)) * num_wraps}")
            col.label(text=f"Num Wraps: {num_wraps}")
        row = layout.row()
        row.operator("object.process_anim_meshes")
        row = layout.row()
        row.operator("object.prepare_explode_mesh")


class VATSettings(bpy.types.PropertyGroup):
    position_mode: bpy.props.EnumProperty(
        name="Position Mode",
        description="Choose between offsets positions or absolutes positions",
        items=[
            ('OFFSETS', "Offsets", "Use offsets"),
            ('ABSOLUTES', "Absolutes", "Use absolutes")
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


def register():
    bpy.utils.register_class(VATSettings)
    bpy.utils.register_class(OBJECT_OT_ProcessAnimMeshes)
    bpy.utils.register_class(OBJECT_OT_PrepareExplodeMesh)
    bpy.utils.register_class(VIEW3D_PT_VertexAnimation)
    bpy.types.Scene.vat_settings = bpy.props.PointerProperty(type=VATSettings)


def unregister():
    del bpy.types.Scene.vat_settings
    bpy.utils.unregister_class(VIEW3D_PT_VertexAnimation)
    bpy.utils.unregister_class(OBJECT_OT_PrepareExplodeMesh)
    bpy.utils.unregister_class(OBJECT_OT_ProcessAnimMeshes)
    bpy.utils.unregister_class(VATSettings)


if __name__ == "__main__":
    register()
