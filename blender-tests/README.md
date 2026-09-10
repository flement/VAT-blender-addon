# Blender VAT test scene (`vat_test.blend`)

Open in Blender 4.2+ with the VAT addon enabled. Timeline: 1–31 (step 1).
Note plugin `frame_range()` excludes end frame → 30 baked frames.

| Object | Covers |
|---|---|
| `VAT_Wave` (plane 121v + WAVE animé) | Run 1 validé : OFFSETS, flip_y ON, wrap NONE → `positions`/`normals` 121×30 + `export_mesh` + UV `vertex_anim` |
| `VAT_Twist` (cube 8v + SIMPLE_DEFORM twist animé) | Run 2 validé : ABSOLUTES, normalize ON (`min_offset` −1.41 / `max_offset` 4.0), WRAP_CROP, step 2 → 8×15 |
| `VAT_Displace` (sphere 114v + DISPLACE animé) | Modificateur DISPLACE, à tester : sélectionner seul puis `Process Anim Meshes` |
| `VAT_Armature` (cylindre + `VAT_Rig` + SMOOTH) | ARMATURE + SMOOTH, keyframes pose 1→31 |
| Infos / Step | Panneau VAT : vertex count + frame count, `frame_step` (testé step 1 et 2) |

Recette : sélectionner UN objet de test (pas `export_mesh`), régler
`Position Mode` / `Flip Y` / `Normalize` / `Wrap Mode` dans l'onglet VAT,
lancer `Process Anim Meshes`. Ne pas sélectionner plusieurs objets avec un
modificateur CLOTH/PARTICLES non baké (l'opérateur annule dans ce cas).
Topologie constante requise (pas d'EXPLODE/PARTICLES changeant le vertex count).
