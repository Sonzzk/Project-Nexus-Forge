// The Python this app runs to describe a scene. It only reads: it never saves, exports or changes anything, and it is not run on the
// original file (see the service). Relative file paths in a .blend ("//textures/a.png") are resolved against the folder of the ORIGINAL
// file, which is passed after "--", because the copy lives somewhere else.
export const INSPECT_SCRIPT = String.raw`import bpy, json, os, sys

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
origin = args[args.index("--origin-dir") + 1] if "--origin-dir" in args else ""


def resolve(path):
    if path.startswith("//"):
        return os.path.normpath(os.path.join(origin, path[2:])) if origin else path
    return path


missing = []
for kind, collection in (("image", bpy.data.images), ("sound", bpy.data.sounds), ("font", bpy.data.fonts), ("movie clip", bpy.data.movieclips)):
    for item in collection:
        path = getattr(item, "filepath", "")
        if not path or getattr(item, "packed_file", None) is not None:
            continue
        if getattr(item, "source", "FILE") in ("GENERATED", "VIEWER"):
            continue
        if not os.path.exists(resolve(path)):
            missing.append({"kind": kind, "name": item.name[:200], "path": path[:400]})

types = {}
for obj in bpy.data.objects:
    types[obj.type] = types.get(obj.type, 0) + 1

triangles = 0
for mesh in bpy.data.meshes:
    for poly in mesh.polygons:
        triangles += max(len(poly.vertices) - 2, 0)

scene = bpy.data.scenes[0] if len(bpy.data.scenes) else None
result = {
    "blender": bpy.app.version_string,
    "scenes": [s.name[:120] for s in bpy.data.scenes][:50],
    "objects": len(bpy.data.objects),
    "objectTypes": types,
    "meshes": len(bpy.data.meshes),
    "triangles": triangles,
    "materials": len(bpy.data.materials),
    "images": len(bpy.data.images),
    "collections": len(bpy.data.collections),
    "actions": len(bpy.data.actions),
    "armatures": len(bpy.data.armatures),
    "libraries": [lib.filepath[:300] for lib in bpy.data.libraries][:50],
    "missingFiles": missing[:100],
    "unitSystem": scene.unit_settings.system if scene else "NONE",
    "unitScale": float(scene.unit_settings.scale_length) if scene else 1.0,
}
print("GDCC_INSPECT_RESULT " + json.dumps(result))
`;
