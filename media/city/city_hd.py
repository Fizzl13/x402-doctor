# The x402 Trust Index as a night city, detailed version (made for a GPU render).
# One tower per seller (sellers.json: [site, [go, caution, no_go, unreachable]]), height by its number of paid
# endpoints (log scale), stacked by today's verdicts: go (mint), caution (amber), no_go (red), unreachable (grey).
# Detail: lit windows in the verdict colour, glowing crowns, plinths, rooftop units, antennas with white blinking
# tips, a pulsing red beacon on every tower with no_go endpoints, wet streets with light pulses running along them,
# a teal haze (mist pass) and bloom. The camera orbits 100 degrees in 10 seconds.
#
#   blender -b -P city_hd.py -- --out frames/f#### [--gpu] [--w 1920 --h 1080 --samples 96] [--still 120]
#   blender -b -P city_hd.py -- --encode frames trust-city-hd.mp4     (PNG frames -> H.264 mp4, no ffmpeg needed)
# A stopped render can be started again: frames that already exist are skipped.
import bpy, bmesh, json, math, sys, os, random

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default, cast=str):
    return cast(argv[argv.index(name) + 1]) if name in argv else default

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = arg("--fps", 24, int)

# ---------------------------------------------------------------- encode mode
if "--encode" in argv:
    src, dst = argv[argv.index("--encode") + 1], argv[argv.index("--encode") + 2]
    files = sorted(f for f in os.listdir(src) if f.lower().endswith(".png"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    img = bpy.data.images.load(os.path.join(src, files[0]))
    s.render.resolution_x, s.render.resolution_y = img.size
    s.render.resolution_percentage = 100
    s.sequence_editor_create()
    se = s.sequence_editor
    coll = se.strips if hasattr(se, "strips") else se.sequences
    st = coll.new_image("frames", os.path.join(src, files[0]), 1, 1)
    for f in files[1:]:
        st.elements.append(f)
    s.frame_start, s.frame_end = 1, len(files)
    s.render.fps = FPS
    s.view_settings.view_transform = "Standard"  # the frames are already graded
    r = s.render
    r.image_settings.file_format = "FFMPEG"
    r.ffmpeg.format = "MPEG4"
    r.ffmpeg.codec = "H264"
    r.ffmpeg.constant_rate_factor = "HIGH"
    r.ffmpeg.ffmpeg_preset = "GOOD"
    r.filepath = os.path.abspath(dst)
    r.use_file_extension = False
    bpy.ops.render.render(animation=True)
    print("wrote", dst, len(files), "frames")
    sys.exit(0)

# ---------------------------------------------------------------- scene
rows = json.load(open(os.path.join(HERE, "sellers.json")))
OUT = arg("--out", os.path.join(HERE, "frames_hd", "f####"))
W, H = arg("--w", 1920, int), arg("--h", 1080, int)
SAMPLES = arg("--samples", 64, int)
SECONDS = arg("--seconds", 10.0, float)
FRAMES = int(FPS * SECONDS)
rnd = random.Random(402)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)

n = len(rows)
side = math.ceil(math.sqrt(n)) + 2
cells = [(x - side / 2, y - side / 2) for x in range(side) for y in range(side)]
cells.sort(key=lambda c: (c[0] ** 2 + c[1] ** 2, c[0], c[1]))
FOOT = 0.6

def height(total):
    return 0.12 + 1.6 * math.log10(total + 1) ** 1.6

# ---------------------------------------------------------------- node helpers
class NT:
    def __init__(self, tree):
        self.t = tree
    def node(self, kind, **props):
        n = self.t.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        return n
    def link(self, a, b):
        self.t.links.new(a, b)
    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

def anim_time(socket_owner_node):
    """Keyframe a Value node from 0 to SECONDS over the shot, linear, so shaders can move."""
    v = socket_owner_node
    v.outputs[0].default_value = 0.0
    v.outputs[0].keyframe_insert("default_value", frame=1)
    v.outputs[0].default_value = SECONDS
    v.outputs[0].keyframe_insert("default_value", frame=FRAMES + 1)
    tree = v.id_data
    for fc in tree.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"

# ---------------------------------------------------------------- tower facade material
def facade(name, hexcol, lit_share, win_strength, glow=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    t = NT(m.node_tree)
    bsdf = m.node_tree.nodes["Principled BSDF"]
    col = srgb(hexcol)
    geo = t.node("ShaderNodeNewGeometry")
    sep_p = t.node("ShaderNodeSeparateXYZ"); t.link(geo.outputs["Position"], sep_p.inputs[0])
    sep_n = t.node("ShaderNodeSeparateXYZ"); t.link(geo.outputs["Normal"], sep_n.inputs[0])
    ax, ay, az = (t.math("ABSOLUTE", sep_n.outputs[i]) for i in range(3))
    # u runs along the facade: y on faces looking along x, x on faces looking along y.
    u = t.math("ADD", t.math("MULTIPLY", ax, sep_p.outputs[1]), t.math("MULTIPLY", ay, sep_p.outputs[0]))
    COLS, ROWS = 13.0, 9.0
    uc = t.math("MULTIPLY", u, COLS)
    zr = t.math("MULTIPLY", sep_p.outputs[2], ROWS)
    fu, fz = t.math("FRACT", uc), t.math("FRACT", zr)
    inside = t.math("MULTIPLY",
                    t.math("MULTIPLY", t.math("GREATER_THAN", fu, 0.16), t.math("LESS_THAN", fu, 0.84)),
                    t.math("MULTIPLY", t.math("GREATER_THAN", fz, 0.22), t.math("LESS_THAN", fz, 0.78)))
    side_face = t.math("SUBTRACT", 1.0, az)
    mask = t.math("MULTIPLY", inside, side_face)
    # One random number per window (and per facade, per tower).
    seed = t.node("ShaderNodeCombineXYZ")
    t.link(t.math("FLOOR", uc), seed.inputs[0])
    t.link(t.math("FLOOR", zr), seed.inputs[1])
    t.link(t.math("ADD", t.math("MULTIPLY", t.math("FLOOR", t.math("ADD", sep_p.outputs[0], 0.5)), 7.31),
                  t.math("ADD", t.math("MULTIPLY", t.math("FLOOR", t.math("ADD", sep_p.outputs[1], 0.5)), 3.17),
                         t.math("ADD", t.math("MULTIPLY", sep_n.outputs[0], 0.37), t.math("MULTIPLY", sep_n.outputs[1], 0.71)))),
           seed.inputs[2])
    wn = t.node("ShaderNodeTexWhiteNoise", noise_dimensions="3D")
    t.link(seed.outputs[0], wn.inputs["Vector"])
    r = wn.outputs["Value"]
    lit = t.math("GREATER_THAN", r, 1.0 - lit_share)
    bright = t.math("ADD", 0.35, t.math("MULTIPLY", r, 1.3))  # windows differ in brightness
    win = t.math("MULTIPLY", t.math("MULTIPLY", mask, lit), bright)
    # Thin floor bands catch a little light; the facade itself glows faintly for red/amber.
    band = t.math("MULTIPLY", t.math("LESS_THAN", fz, 0.07), side_face)
    emis = t.math("ADD", t.math("MULTIPLY", win, win_strength),
                  t.math("ADD", glow, t.math("MULTIPLY", band, 0.25 + glow)))
    t.link(emis, bsdf.inputs["Emission Strength"])
    bsdf.inputs["Emission Color"].default_value = (*[min(1, c * 1.0) for c in col], 1)
    # Dark tinted glass between the windows, glossy so the city reflects in itself.
    bsdf.inputs["Base Color"].default_value = (*[c * 0.06 + 0.004 for c in col], 1)
    bsdf.inputs["Metallic"].default_value = 0.55
    rough = t.math("ADD", t.math("ADD", 0.08, t.math("MULTIPLY", mask, 0.1)), t.math("MULTIPLY", az, 0.3))
    t.link(rough, bsdf.inputs["Roughness"])
    bsdf.inputs["Coat Weight"].default_value = 0.4
    bsdf.inputs["Coat Roughness"].default_value = 0.05
    return m

def emissive(name, hexcol, strength, pulse=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        if nd.type == "BSDF_PRINCIPLED":
            nt.nodes.remove(nd)
    out = nt.nodes["Material Output"]
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (*srgb(hexcol), 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    if pulse:  # (period seconds, low share, phase): strength follows a soft blink
        period, low, phase = pulse
        steps = int(SECONDS / period * 4) + 4
        for i in range(steps + 1):
            tsec = i * period / 4
            f = 1 + tsec * FPS
            on = (i + phase) % 4 in (0, 1)
            em.inputs["Strength"].default_value = strength if on else strength * low
            em.inputs["Strength"].keyframe_insert("default_value", frame=f)
    return m

def solid(name, hexcol, rough=0.5, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*srgb(hexcol), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

KINDS = [
    ("go", "#19c08f", 0.30, 2.6, 0.0),
    ("caution", "#ffb627", 0.55, 4.0, 0.05),
    ("no_go", "#ff3b30", 0.78, 5.5, 0.18),
    ("unreachable", "#5d6f6b", 0.06, 0.8, 0.0),
]
CROWN = {"go": "#61f5c3", "caution": "#ffc85a", "no_go": "#ff5a4f", "unreachable": "#8fa39e"}

# ---------------------------------------------------------------- geometry
meshes = {k: bmesh.new() for k, *_ in KINDS}
crowns = {k: bmesh.new() for k, *_ in KINDS}
plinth, roofs, masts, tips, beacons = (bmesh.new() for _ in range(5))

def box(bm, x, y, z0, z1, wx, wy=None, ring=False):
    wy = wx if wy is None else wy
    v = [bm.verts.new((x + dx * wx / 2, y + dy * wy / 2, z)) for z in (z0, z1) for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    faces = ((0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0))
    if not ring:  # a ring is only the four sides: a band of light around a roof edge
        faces += ((0, 1, 2, 3), (4, 7, 6, 5))
    for f in faces:
        bm.faces.new([v[i] for i in f])

def sphere(bm, x, y, z, r):
    bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=r,
                              matrix=__import__("mathutils").Matrix.Translation((x, y, z)))

tallest = sorted(range(n), key=lambda i: -sum(rows[i][1]))[:60]
tall_set = set(tallest)
for i, ((site, counts), (cx, cy)) in enumerate(zip(rows, cells)):
    total = sum(counts)
    h = height(total)
    # Big sellers get a wider, stepped tower: a base, then the stack set back a little.
    foot = FOOT if h < 4 else 0.66
    box(plinth, cx, cy, 0, 0.035, 0.86)
    z = 0.035
    top_kind = None
    for (kind, *_), c in zip(KINDS, counts):
        if not c:
            continue
        dz = (h - 0.035) * c / total
        box(meshes[kind], cx, cy, z, z + dz, foot)
        z += dz
        top_kind = kind
    if h > 1.5:  # a band of light around the roof edge of the taller towers
        box(crowns[top_kind], cx, cy, z - 0.01, z + 0.02, foot + 0.01, ring=True)
    if h > 1.2:  # rooftop units
        for _ in range(rnd.randint(1, 3)):
            ox, oy = rnd.uniform(-0.18, 0.18), rnd.uniform(-0.18, 0.18)
            box(roofs, cx + ox, cy + oy, z + 0.035, z + 0.035 + rnd.uniform(0.04, 0.1), rnd.uniform(0.06, 0.14), rnd.uniform(0.06, 0.14))
    if i in tall_set:  # antenna with a white blinking tip
        mh = rnd.uniform(0.5, 1.4) * (1 + h / 15)
        ox, oy = rnd.uniform(-0.12, 0.12), rnd.uniform(-0.12, 0.12)
        box(masts, cx + ox, cy + oy, z, z + mh, 0.025)
        sphere(tips, cx + ox, cy + oy, z + mh, 0.03)
    if counts[2] > 0:  # a red beacon for every seller a careful agent won't pay
        sphere(beacons, cx, cy, z + 0.12, 0.05 + 0.03 * min(1, counts[2] / max(1, total)))

def add(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    scene.collection.objects.link(ob)
    return ob

for kind, hexcol, share, strength, glow in KINDS:
    add(kind, meshes[kind], facade("facade_" + kind, hexcol, share, strength, glow))
    add("crown_" + kind, crowns[kind], emissive("crown_" + kind, CROWN[kind], 7.0 if kind != "unreachable" else 1.5))
add("plinths", plinth, solid("plinth", "#0b1412", 0.6))
add("roof_units", roofs, solid("roof", "#1a2321", 0.45, 0.6))
add("masts", masts, solid("mast", "#2c3633", 0.35, 0.9))
add("mast_tips", tips, emissive("tip", "#ffffff", 30.0, pulse=(1.2, 0.04, 0)))
beacon_ob = add("beacons", beacons, emissive("beacon", "#ff2a1f", 40.0, pulse=(1.6, 0.25, 2)))

# ---------------------------------------------------------------- wet street with light pulses
bpy.ops.mesh.primitive_plane_add(size=side * 4, location=(0, 0, 0))
ground = bpy.context.active_object
gm = bpy.data.materials.new("street")
gm.use_nodes = True
t = NT(gm.node_tree)
b = gm.node_tree.nodes["Principled BSDF"]
b.inputs["Base Color"].default_value = (*srgb("#030607"), 1)
b.inputs["Metallic"].default_value = 0.0
b.inputs["Specular IOR Level"].default_value = 0.7
geo = t.node("ShaderNodeNewGeometry")
sp = t.node("ShaderNodeSeparateXYZ"); t.link(geo.outputs["Position"], sp.inputs[0])
x, y = sp.outputs[0], sp.outputs[1]
# Puddles: smooth patches between rough asphalt.
noise = t.node("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 0.35
noise.inputs["Detail"].default_value = 6
t.link(geo.outputs["Position"], noise.inputs["Vector"])
ramp = t.node("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position, ramp.color_ramp.elements[1].position = 0.45, 0.58
ramp.color_ramp.elements[0].color = (0.02, 0.02, 0.02, 1)
ramp.color_ramp.elements[1].color = (0.42, 0.42, 0.42, 1)
t.link(noise.outputs["Fac"], ramp.inputs["Fac"])
t.link(ramp.outputs["Color"], b.inputs["Roughness"])
bump = t.node("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.08
fine = t.node("ShaderNodeTexNoise"); fine.inputs["Scale"].default_value = 40
t.link(geo.outputs["Position"], fine.inputs["Vector"])
t.link(fine.outputs["Fac"], bump.inputs["Height"])
t.link(bump.outputs["Normal"], b.inputs["Normal"])
# Lane lines midway between the blocks (x = k + 0.5 and y = k + 0.5).
def lane(coord):
    d = t.math("ABSOLUTE", t.math("SUBTRACT", t.math("FRACT", coord), 0.5))
    return t.math("LESS_THAN", d, 0.012)
lx, ly = lane(x), lane(y)
# Pulses: short bright streaks that run along each lane at their own speed and offset.
clock = t.node("ShaderNodeValue"); clock.label = "time"
anim_time(clock)
def pulses(lane_mask, along, across):
    lane_id = t.math("FLOOR", across)
    wn = t.node("ShaderNodeTexWhiteNoise", noise_dimensions="1D")
    t.link(lane_id, wn.inputs["W"])
    speed = t.math("ADD", 1.2, t.math("MULTIPLY", wn.outputs["Value"], 2.4))
    direction = t.math("SUBTRACT", t.math("MULTIPLY", t.math("GREATER_THAN", wn.outputs["Value"], 0.5), 2.0), 1.0)
    phase = t.math("ADD", t.math("MULTIPLY", along, 0.11),
                   t.math("ADD", t.math("MULTIPLY", wn.outputs["Value"], 9.0),
                          t.math("MULTIPLY", t.math("MULTIPLY", clock.outputs[0], speed), t.math("MULTIPLY", direction, 0.11))))
    streak = t.math("POWER", t.math("FRACT", phase), 40.0)
    return t.math("MULTIPLY", lane_mask, t.math("ADD", 0.05, t.math("MULTIPLY", streak, 6.0)))
glow = t.math("ADD", pulses(lx, y, x), pulses(ly, x, y))
# Fade the lanes out beyond the city edge.
dist = t.node("ShaderNodeVectorMath", operation="LENGTH"); t.link(geo.outputs["Position"], dist.inputs[0])
fade = t.math("SUBTRACT", 1.0, t.math("DIVIDE", dist.outputs["Value"], side * 0.75), clamp=True)
t.link(t.math("MULTIPLY", glow, fade), b.inputs["Emission Strength"])
b.inputs["Emission Color"].default_value = (*srgb("#61f5c3"), 1)
ground.data.materials.append(gm)

# ---------------------------------------------------------------- sky, light
world = bpy.data.worlds.new("night")
scene.world = world
world.use_nodes = True
wt = NT(world.node_tree)
bg = world.node_tree.nodes["Background"]
tc = wt.node("ShaderNodeTexCoord")
wsep = wt.node("ShaderNodeSeparateXYZ"); wt.link(tc.outputs["Generated"], wsep.inputs[0])
sky = wt.node("ShaderNodeValToRGB")
els = sky.color_ramp.elements
els[0].position, els[0].color = 0.0, (*srgb("#0d4a3d"), 1)
els[1].position, els[1].color = 0.35, (*srgb("#010607"), 1)
mid = els.new(0.08); mid.color = (*srgb("#062a24"), 1)
wt.link(wsep.outputs[2], sky.inputs["Fac"])
wt.link(sky.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.9

bpy.ops.object.light_add(type="SUN", location=(0, 0, 30))
moon = bpy.context.active_object
moon.data.energy = 0.35
moon.data.angle = math.radians(1.5)
moon.data.color = srgb("#bfe9ff")
moon.rotation_euler = (math.radians(58), 0, math.radians(140))
bpy.ops.object.light_add(type="AREA", location=(0, 0, side * 0.9))
fill = bpy.context.active_object
fill.data.energy = 1200
fill.data.size = side
fill.data.color = srgb("#3fd3a7")
fill.visible_glossy = False  # a lamp this big would show up as a white sheet in every roof

# ---------------------------------------------------------------- camera orbit
pivot = bpy.data.objects.new("pivot", None)
scene.collection.objects.link(pivot)
bpy.ops.object.camera_add(location=(-side * 0.33, -side * 0.43, side * 0.17))
cam = bpy.context.active_object
cam.parent = pivot
cam.data.lens = 27
cam.data.sensor_width = 36
target = bpy.data.objects.new("target", None)
target.location = (0, 0, 4.5)
scene.collection.objects.link(target)
cam.data.dof.use_dof = True
cam.data.dof.focus_object = target
cam.data.dof.aperture_fstop = 3.2
cam.data.dof.aperture_blades = 7
c = cam.constraints.new("TRACK_TO")
c.target = target
c.track_axis = "TRACK_NEGATIVE_Z"
c.up_axis = "UP_Y"
scene.camera = cam
scene.frame_start, scene.frame_end = 1, FRAMES
scene.render.fps = FPS
for f, rot, sc in ((1, 0.0, 1.0), (FRAMES, 100.0, 0.76)):
    pivot.rotation_euler = (0, 0, math.radians(rot))
    pivot.keyframe_insert("rotation_euler", frame=f)
    pivot.scale = (sc, sc, sc)
    pivot.keyframe_insert("scale", frame=f)
for fc in pivot.animation_data.action.fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = "BEZIER"
        kp.easing = "EASE_IN_OUT"

# ---------------------------------------------------------------- render settings
r = scene.render
r.engine = "CYCLES"
cy = scene.cycles
cy.device = "CPU"
if "--gpu" in argv:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = backend
        except TypeError:
            continue
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == backend]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == backend
            cy.device = "GPU"
            print("GPU render on", backend, [d.name for d in gpus])
            break
    else:
        print("no GPU found, rendering on the CPU")
cy.samples = SAMPLES
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.015
cy.use_denoising = True
cy.denoiser = "OPENIMAGEDENOISE"
cy.max_bounces = 6
cy.glossy_bounces = 4
cy.diffuse_bounces = 2
cy.transmission_bounces = 2
cy.caustics_reflective = False
cy.caustics_refractive = False
cy.light_sampling_threshold = 0.01
r.use_motion_blur = True
r.motion_blur_shutter = 0.5
r.use_persistent_data = True
r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
r.filepath = OUT
r.use_overwrite = False
r.use_placeholder = True
r.image_settings.file_format = "PNG"
r.image_settings.color_depth = "8"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Punchy"
scene.view_settings.exposure = 0.1

# Haze from the mist pass, then bloom, then a soft vignette.
vl = scene.view_layers[0]
vl.use_pass_mist = True
world.mist_settings.start = 6
world.mist_settings.depth = side * 1.6
world.mist_settings.falloff = "QUADRATIC"
scene.use_nodes = True
ct = scene.node_tree
for nd in list(ct.nodes):
    ct.nodes.remove(nd)
rl = ct.nodes.new("CompositorNodeRLayers")
haze_col = ct.nodes.new("CompositorNodeRGB")
haze_col.outputs[0].default_value = (*[c * 0.35 for c in srgb("#0f4f42")], 1)
mix = ct.nodes.new("CompositorNodeMixRGB")
mix.blend_type = "MIX"
mist_curve = ct.nodes.new("CompositorNodeMath")
mist_curve.operation = "MULTIPLY"
mist_curve.inputs[1].default_value = 0.5
ct.links.new(rl.outputs["Mist"], mist_curve.inputs[0])
ct.links.new(mist_curve.outputs[0], mix.inputs[0])
ct.links.new(rl.outputs["Image"], mix.inputs[1])
ct.links.new(haze_col.outputs[0], mix.inputs[2])
glare = ct.nodes.new("CompositorNodeGlare")
for gtype in ("BLOOM", "FOG_GLOW"):
    try:
        glare.glare_type = gtype
        break
    except TypeError:
        continue
for attr, val in (("quality", "HIGH"), ("threshold", 0.9), ("mix", 0.0), ("size", 8)):
    try:
        setattr(glare, attr, val)
    except (AttributeError, TypeError):
        pass
for sock, val in (("Threshold", 1.0), ("Strength", 0.6), ("Size", 0.6)):
    if sock in glare.inputs:
        glare.inputs[sock].default_value = val
ct.links.new(mix.outputs[0], glare.inputs[0])
lens = ct.nodes.new("CompositorNodeLensdist")
try:
    lens.use_fit = True
except AttributeError:
    pass
for sock, val in (("Distortion", -0.012), ("Dispersion", 0.012)):
    if sock in lens.inputs:
        lens.inputs[sock].default_value = val
ct.links.new(glare.outputs[0], lens.inputs[0])
# Vignette: an ellipse mask, blurred, darkens the corners.
ell = ct.nodes.new("CompositorNodeEllipseMask")
if "Size" in ell.inputs:
    ell.inputs["Size"].default_value = (0.95, 0.85)
else:
    ell.mask_width, ell.mask_height = 0.95, 0.85
blur = ct.nodes.new("CompositorNodeBlur")
blur.filter_type = "GAUSS"
if "Size" in blur.inputs:
    blur.inputs["Size"].default_value = (int(W * 0.18), int(H * 0.18))
else:
    blur.use_relative = True
    blur.factor_x = blur.factor_y = 18
ct.links.new(ell.outputs[0], blur.inputs[0])
vig = ct.nodes.new("CompositorNodeMixRGB")
vig.blend_type = "MULTIPLY"
dark = ct.nodes.new("CompositorNodeMath")
dark.operation = "MULTIPLY_ADD"
dark.inputs[1].default_value = 0.45
dark.inputs[2].default_value = 0.55
ct.links.new(blur.outputs[0], dark.inputs[0])
vig.inputs[0].default_value = 1.0
ct.links.new(lens.outputs[0], vig.inputs[1])
ct.links.new(dark.outputs[0], vig.inputs[2])
comp = ct.nodes.new("CompositorNodeComposite")
ct.links.new(vig.outputs[0], comp.inputs[0])

print("city:", n, "towers,", len(beacons.verts) // 52, "beacons approx,", FRAMES, "frames at", W, "x", H, "samples", SAMPLES)
if "--still" in argv:
    scene.frame_set(arg("--still", 1, int))
    r.filepath = OUT if OUT.endswith(".png") else OUT.replace("####", "still") + ".png"
    r.use_overwrite = True
    bpy.ops.render.render(write_still=True)
    print("wrote", r.filepath)
elif "--save" in argv:
    bpy.ops.wm.save_as_mainfile(filepath=arg("--save", "city_hd.blend"))
else:
    bpy.ops.render.render(animation=True)
    print("done")
