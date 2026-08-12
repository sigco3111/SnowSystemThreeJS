import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { createSnow } from './snow.js';
import { createSnowAudio } from './snowAudio.js';
import { createLake } from './lake.js';
import { createModelSystem } from './model.js';
import { createPostFX } from './postfx.js';
import { t, setLanguage } from './i18n.js';

/* -------------------------------------------------------------------------- */
/*  Renderer                                                                   */
/* -------------------------------------------------------------------------- */
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;

/* -------------------------------------------------------------------------- */
/*  Scene & Camera                                                             */
/* -------------------------------------------------------------------------- */
const scene = new THREE.Scene();
// Cool, hazy winter night — slightly lifted from black so falling snow reads.
// NOTE: fog blends each fragment toward the background by its distance FROM THE
// CAMERA, so a heavy density visibly dims the scene as you zoom out. Kept light
// here (and exposed in the GUI) so zooming doesn't read as a lighting change.
scene.background = new THREE.Color(0x0a0e16);
scene.fog = new THREE.FogExp2(0x0a0e16, 0.007);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);
camera.position.set(6, 20, 32);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI * 0.495; // don't go below the ground
controls.minDistance = 2;
controls.maxDistance = 300;
controls.target.set(0, 0, 0);

/* -------------------------------------------------------------------------- */
/*  Image-based lighting (soft, neutral reflections)                          */
/* -------------------------------------------------------------------------- */
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

/* -------------------------------------------------------------------------- */
/*  Cinematic lighting rig (identical to the rain studio)                      */
/* -------------------------------------------------------------------------- */
// Key light — warm, hard, casts the shadows.
const keyLight = new THREE.DirectionalLight(0xfff1dd, 3.0);
keyLight.position.set(8, 12, 6);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 60;
keyLight.shadow.camera.left = -15;
keyLight.shadow.camera.right = 15;
keyLight.shadow.camera.top = 15;
keyLight.shadow.camera.bottom = -15;
keyLight.shadow.bias = -0.0002;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);

// Fill light — cool, soft, lifts the shadows from the opposite side.
const fillLight = new THREE.DirectionalLight(0x4a6cff, 0.6);
fillLight.position.set(-9, 5, -4);
scene.add(fillLight);

// Rim / back light — separates the surface from the background.
const rimLight = new THREE.SpotLight(0xffd9a0, 120, 50, Math.PI * 0.25, 0.4, 1.2);
rimLight.position.set(-6, 8, -10);
rimLight.target.position.set(0, 0, 0);
scene.add(rimLight);
scene.add(rimLight.target);

// Gentle ambient so nothing reads as pure black.
const ambient = new THREE.AmbientLight(0x223044, 0.4);
scene.add(ambient);

/* -------------------------------------------------------------------------- */
/*  Asphalt material (swappable) — the snow settles on top of this            */
/* -------------------------------------------------------------------------- */
// Each entry only differs by folder + filename prefix; the map suffixes match.
const MATERIALS = {
  'Asphalt 025C': { dir: `${import.meta.env.BASE_URL}Material_1/`, prefix: 'Asphalt025C_1K-JPG_' },
  'Asphalt 024A': { dir: `${import.meta.env.BASE_URL}Material_2/`, prefix: 'Asphalt024A_1K-JPG_' },
};

const loader = new THREE.TextureLoader();
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

// Rebuilt on every material swap; `applyTextureScale` reads this by reference.
let allMaps = [];

const material = new THREE.MeshStandardMaterial({
  normalMapType: THREE.TangentSpaceNormalMap, // textures are OpenGL (GL) normals
  roughness: 1.0,
  metalness: 0.0,
  aoMapIntensity: 1.0,
  normalScale: new THREE.Vector2(1, 1),
  displacementScale: 0.0, // off by default — turn it up in the GUI
  displacementBias: 0.0,
  envMapIntensity: 1.0,
});

const matSettings = { active: 'Asphalt 025C' };

// Loads a material set, disposes the previous textures, and rewires the maps.
function loadMaterial(key) {
  const { dir, prefix } = MATERIALS[key];
  const make = (suffix, srgb = false) => {
    const tex = loader.load(dir + prefix + suffix + '.jpg');
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = maxAnisotropy;
    return tex;
  };

  for (const m of allMaps) m.dispose(); // free the old GPU textures

  material.map = make('Color', true); // sRGB; the rest are linear data maps
  material.aoMap = make('AmbientOcclusion');
  material.roughnessMap = make('Roughness');
  material.normalMap = make('NormalGL');
  material.displacementMap = make('Displacement');
  material.needsUpdate = true;

  allMaps = [
    material.map,
    material.aoMap,
    material.roughnessMap,
    material.normalMap,
    material.displacementMap,
  ];
  applyTextureScale(params.textureScale); // re-apply current tiling
}

/* -------------------------------------------------------------------------- */
/*  Shared uniforms (snow & ground accumulation stay in lockstep)              */
/* -------------------------------------------------------------------------- */
const shared = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector3(1.2, 0, 0.5) }, // gentle horizontal wind
};

/* -------------------------------------------------------------------------- */
/*  Snow accumulation system (noise-driven snow mask on the asphalt)           */
/* -------------------------------------------------------------------------- */
//  A procedural FBM noise mask in world space decides where snow has settled.
//  Inside the snow we override the asphalt: brighten the albedo to snow-white,
//  push roughness toward matte, scatter tiny sparkles, and replace the normal
//  with soft drift bumps — so the same surface blends from bare asphalt to a
//  smooth, glinting blanket of snow.
const snowUniforms = {
  uSnowScale: { value: 0.16 }, // noise frequency (smaller = bigger drifts)
  uSnowSeed: { value: new THREE.Vector2(8.3, 2.1) }, // pan the noise field
  uSnowCoverage: { value: 0.7 }, // 0 = bare road, 1 = fully blanketed
  uSnowEdge: { value: 0.12 }, // melt-line softness
  uSnowColor: { value: new THREE.Color(0xeaf1ff) }, // cool snow white
  uSnowRoughness: { value: 0.82 }, // snow is matte but not flat
  uSnowDepth: { value: 0.9 }, // thickness of the settled layer (world units)
  uSnowBumpScale: { value: 0.7 }, // drift surface relief frequency
  uSnowBumpStrength: { value: 0.6 }, // how lumpy the snow surface is
  uSparkle: { value: 0.5 }, // glint amount (0 = no sparkle)
  uSparkleScale: { value: 90.0 }, // glint density (bigger = finer specks)
  uTime: shared.uTime,
  uWind: shared.uWind,
};

/* -------------------------------------------------------------------------- */
/*  Frozen lake — shared shape (ground basin + ice sheet read the same field)  */
/* -------------------------------------------------------------------------- */
//  These uniforms define ONE irregular blob in world space. The ground shader
//  uses them to carve a basin (and clear the snow) and the ice mesh uses the
//  exact same field to draw its outline + depth, so the two always line up.
const lakeUniforms = {
  uLakeEnabled: { value: 0 }, // 0/1 master toggle — off by default
  uLakeCenter: { value: new THREE.Vector2(0, 0) }, // resize/grow from here
  uLakeRadius: { value: 3.2 }, // base radius (world units)
  uLakeEdge: { value: 0.25 }, // shoreline softness (fraction of radius)
  uLakeShapeAmp: { value: 0.08 }, // 0 = perfect circle, higher = more lobed
  uLakeShapeFreq: { value: 3.0 }, // number of primary lobes
  uLakeSeed: { value: 0.0 }, // rotate/vary the outline
  uLakeDepth: { value: 0.42 }, // how far the basin sinks below ground
  uLakeBedColor: { value: new THREE.Color(0x33b1ff) }, // water bed tint
};

// Pure noise helpers (no uniforms) — reused by the ground AND the ice shader.
const NOISE_FUNCTIONS = /* glsl */ `
// --- Ashima 2D simplex noise -------------------------------------------------
vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Fractal Brownian motion for organic, blotchy shapes.
float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amp * snoise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return value;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}
`;

// Snow uniforms + masks + the snow height field (depends on NOISE_FUNCTIONS).
const SNOW_FUNCTIONS = /* glsl */ `
uniform float uSnowScale;
uniform vec2  uSnowSeed;
uniform float uSnowCoverage;
uniform float uSnowEdge;
uniform vec3  uSnowColor;
uniform float uSnowRoughness;
uniform float uSnowDepth;
uniform float uSnowBumpScale;
uniform float uSnowBumpStrength;
uniform float uSparkle;
uniform float uSparkleScale;
uniform float uTime;
uniform vec3  uWind;

// Returns 0 (bare asphalt) .. 1 (deep snow) for a world-space XZ position.
float snowMaskAt(vec2 worldXZ) {
  vec2 p = worldXZ * uSnowScale + uSnowSeed;
  float n = fbm(p) * 0.5 + 0.5;               // -> 0..1
  float threshold = 1.0 - uSnowCoverage;      // more coverage = lower bar
  return smoothstep(threshold - uSnowEdge, threshold + uSnowEdge, n);
}

// Height of the snow surface above the bare asphalt, in world units. A base
// layer scaled by coverage, plus lumpy drift detail. This is the single source
// of truth: the vertex stage pushes the geometry up by it, and the fragment
// stage differentiates it for shading normals — so silhouette and lighting agree.
float snowHeightAt(vec2 worldXZ) {
  float mask = snowMaskAt(worldXZ);
  float drift = fbm(worldXZ * uSnowBumpScale) * 0.5 + 0.5;  // 0..1 lumps
  float h = mask * (1.0 - 0.4 * uSnowBumpStrength + 0.4 * uSnowBumpStrength * drift);
  // Taper to zero near the plane rim (half-extent 10) so the raised layer never
  // leaves a floating cliff at the border.
  vec2 edge = smoothstep(10.0, 8.0, abs(worldXZ));
  return uSnowDepth * h * edge.x * edge.y;
}

`;

// --- Frozen-lake field, shared verbatim by the ground shader and the ice mesh.
// Defines an irregular blob (angular harmonics) plus a smooth basin profile.
const LAKE_FUNCTIONS = /* glsl */ `
uniform float uLakeEnabled;
uniform vec2  uLakeCenter;
uniform float uLakeRadius;
uniform float uLakeEdge;
uniform float uLakeShapeAmp;
uniform float uLakeShapeFreq;
uniform float uLakeSeed;
uniform float uLakeDepth;
uniform vec3  uLakeBedColor;

// Irregular shoreline radius for a given angle (a few harmonics -> organic blob).
float lakeRadiusAt(float ang) {
  float w  = 1.00 * sin(ang * uLakeShapeFreq + uLakeSeed);
  w       += 0.50 * sin(ang * (uLakeShapeFreq * 2.0 + 1.0) - uLakeSeed * 1.3);
  w       += 0.25 * sin(ang * (uLakeShapeFreq * 3.0 + 2.0) + uLakeSeed * 2.1);
  w /= 1.75; // -> roughly [-1, 1]
  return uLakeRadius * (1.0 + uLakeShapeAmp * w);
}

// 0 outside .. 1 inside, with a soft, irregular shoreline.
float lakeInsideAt(vec2 worldXZ) {
  if (uLakeEnabled < 0.5) return 0.0;
  vec2  d = worldXZ - uLakeCenter;
  float r = length(d);
  float R = lakeRadiusAt(atan(d.y, d.x));
  float edge = R * uLakeEdge + 0.001;
  return 1.0 - smoothstep(R - edge, R + edge, r);
}

// 0 at the shore .. 1 at the deepest water — a flat-bottomed bowl.
float lakeDepth01(vec2 worldXZ) {
  return smoothstep(0.0, 0.82, lakeInsideAt(worldXZ));
}
`;

// --- Combined ground height: snow MINUS the carved lake basin, plus normals.
const GROUND_FUNCTIONS = /* glsl */ `
// Master height field: snow blanket (cleared over the lake) minus the basin.
float groundHeightAt(vec2 worldXZ) {
  float inside = lakeInsideAt(worldXZ);
  float snow = snowHeightAt(worldXZ) * (1.0 - inside);   // no snow on the ice
  float basin = uLakeDepth * lakeDepth01(worldXZ);        // sink the lakebed
  return snow - basin;
}

vec3 groundSurfaceNormal(vec2 worldXZ) {
  float e = 0.08;
  float h0 = groundHeightAt(worldXZ);
  float hx = groundHeightAt(worldXZ + vec2(e, 0.0));
  float hz = groundHeightAt(worldXZ + vec2(0.0, e));
  vec2 grad = vec2(hx - h0, hz - h0) / e;
  return normalize(vec3(-grad.x, 1.0, -grad.y));
}
`;

// Everything the ground material injects, in dependency order.
const GROUND_INJECT =
  NOISE_FUNCTIONS + SNOW_FUNCTIONS + LAKE_FUNCTIONS + GROUND_FUNCTIONS;

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, snowUniforms, lakeUniforms);

  // Vertex: inject the height field, then displace the plane by it — snow rises,
  // the lake basin sinks. World XZ is read from the un-displaced position
  // (displacement is purely vertical, so XZ is unaffected).
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + GROUND_INJECT
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec2 groundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
      transformed += normalize(objectNormal) * groundHeightAt(groundXZ);
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    // Inject noise helpers + uniforms (keeps the original <common> include).
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + GROUND_INJECT
    )
    // Snow albedo where it has settled, then the dark lakebed inside the basin.
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float lakeIn = lakeInsideAt(vWorldPosition.xz);
      float snowMask = snowMaskAt(vWorldPosition.xz) * (1.0 - lakeIn);
      // Subtle brightness variation across the blanket so it isn't a flat fill.
      float snowShade = 0.85 + 0.15 * (fbm(vWorldPosition.xz * uSnowBumpScale * 2.0) * 0.5 + 0.5);
      vec3 snowAlbedo = uSnowColor * snowShade;
      // Sparkle: rare bright specks that catch the light like ice crystals.
      float sp = hash21(floor(vWorldPosition.xz * uSparkleScale));
      float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + sp * 30.0);
      float sparkle = step(0.985, sp) * twinkle * uSparkle;
      snowAlbedo += sparkle;
      diffuseColor.rgb = mix(diffuseColor.rgb, snowAlbedo, snowMask);
      // Lakebed: darken toward the deep centre so the depth reads through the ice.
      vec3 bed = uLakeBedColor * (1.0 - 0.6 * lakeDepth01(vWorldPosition.xz));
      diffuseColor.rgb = mix(diffuseColor.rgb, bed, lakeIn);`
    )
    // Snow is matte; sparkle specks glint; the wet lakebed sits in between.
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, uSnowRoughness, snowMask);
      roughnessFactor = mix(roughnessFactor, 0.08, sparkle * snowMask);
      roughnessFactor = mix(roughnessFactor, 0.55, lakeIn);`
    )
    // Shade with the normal of the displaced surface (drift slopes, banked
    // shorelines, basin walls), blended in wherever the ground deviates from flat.
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      vec3 gN = groundSurfaceNormal(vWorldPosition.xz);
      vec3 gView = normalize((viewMatrix * vec4(gN, 0.0)).xyz);
      float surfaceBlend = clamp(snowMask + lakeIn, 0.0, 1.0);
      normal = normalize(mix(normal, gView, surfaceBlend));`
    );
};
// Distinct cache key so this program isn't shared with a plain StandardMaterial.
material.customProgramCacheKey = () => 'asphalt-snow-v1';

/* -------------------------------------------------------------------------- */
/*  Plane                                                                      */
/* -------------------------------------------------------------------------- */
// Segments give the displacement map something to push around.
const geometry = new THREE.PlaneGeometry(20, 20, 256, 256);
// aoMap reads from the 2nd UV set — reuse the existing UVs.
geometry.setAttribute('uv1', geometry.attributes.uv);

const plane = new THREE.Mesh(geometry, material);
plane.rotation.x = -Math.PI / 2;
plane.receiveShadow = true;
plane.castShadow = true;
scene.add(plane);

/* -------------------------------------------------------------------------- */
/*  Snow                                                                       */
/* -------------------------------------------------------------------------- */
const snow = createSnow({ camera, sharedUniforms: shared });
scene.add(snow.mesh);

/* -------------------------------------------------------------------------- */
/*  Frozen lake (ice sheet over the carved basin)                              */
/* -------------------------------------------------------------------------- */
const lake = createLake({
  lakeUniforms,
  sharedUniforms: shared,
  noiseGLSL: NOISE_FUNCTIONS,
  lakeGLSL: LAKE_FUNCTIONS,
  sunDir: keyLight.position, // direction toward the key light, for the glint
  sunColor: keyLight.color,
});
scene.add(lake.mesh);

/* -------------------------------------------------------------------------- */
/*  Model (default GLB + user import) — snow accumulates on its upward faces    */
/* -------------------------------------------------------------------------- */
const MODELS = {
  'Rusty Car': `${import.meta.env.BASE_URL}old_rusty_car_2.glb`,
  'Porsche 911': `${import.meta.env.BASE_URL}porsche_911.glb`,
};
const model = createModelSystem({
  scene,
  sharedUniforms: shared,
  defaultUrl: MODELS['Rusty Car'],
});

/* -------------------------------------------------------------------------- */
/*  Wind                                                                       */
/* -------------------------------------------------------------------------- */
const wind = {
  strength: 1.3, // horizontal speed (world units / s)
  direction: 20, // degrees around Y
};
function applyWind() {
  const a = THREE.MathUtils.degToRad(wind.direction);
  shared.uWind.value.set(
    Math.cos(a) * wind.strength,
    0,
    Math.sin(a) * wind.strength
  );
}
applyWind();

/* -------------------------------------------------------------------------- */
/*  Cinematic post-processing & camera                                         */
/* -------------------------------------------------------------------------- */
const fx = createPostFX({ renderer, scene, camera });

const cine = {
  autoOrbit: true,
  orbitSpeed: 1.1,
  fov: 18,
  letterbox: true,
};
controls.autoRotate = cine.autoOrbit;
controls.autoRotateSpeed = cine.orbitSpeed;
camera.fov = cine.fov;
camera.updateProjectionMatrix();

// Letterbox bars (CSS overlay).
const barTop = document.getElementById('bar-top');
const barBottom = document.getElementById('bar-bottom');
function applyLetterbox() {
  const h = cine.letterbox ? '8vh' : '0';
  barTop.style.height = h;
  barBottom.style.height = h;
}
applyLetterbox();

// --- Focus-plane visualizer (Unreal-style) ---------------------------------
// A translucent grid plane shown at the DoF focus distance while the user drags
// the Focus Distance slider, then it fades out on its own.
const focusPlaneMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uOpacity: { value: 0 },
    uColor: { value: new THREE.Color(0x8fcfff) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uOpacity;
    uniform vec3  uColor;
    varying vec2  vUv;
    void main() {
      vec2 grid = abs(fract(vUv * 12.0) - 0.5);
      vec2 d = grid / fwidth(vUv * 12.0);
      float line = 1.0 - clamp(min(d.x, d.y), 0.0, 1.0);
      vec2 c = abs(vUv - 0.5);
      float cross = step(c.x, 0.0015) + step(c.y, 0.0015); // center crosshair
      float a = (line * 0.55 + 0.05 + cross * 0.9) * uOpacity;
      if (a <= 0.001) discard;
      gl_FragColor = vec4(uColor, a);
    }
  `,
});
const focusPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), focusPlaneMat);
focusPlane.frustumCulled = false;
focusPlane.visible = false;
scene.add(focusPlane);

let focusTimer = 0;
const _focusDir = new THREE.Vector3();
function showFocusPlane() {
  focusTimer = 1.2; // seconds visible after the last change
  focusPlane.visible = true;
}
function updateFocusPlane(dt) {
  if (focusTimer <= 0) {
    if (focusPlane.visible) focusPlane.visible = false;
    return;
  }
  focusTimer -= dt;
  const dist = fx.bokeh.uniforms.focus.value;
  camera.getWorldDirection(_focusDir);
  focusPlane.position.copy(camera.position).addScaledVector(_focusDir, dist);
  focusPlane.quaternion.copy(camera.quaternion); // face the camera
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
  const halfW = halfH * camera.aspect;
  focusPlane.scale.set(halfW * 2 * 0.92, halfH * 2 * 0.92, 1);
  focusPlaneMat.uniforms.uOpacity.value = 0.9 * Math.min(1, focusTimer / 0.4);
}

/* -------------------------------------------------------------------------- */
/*  GUI controls                                                               */
/* -------------------------------------------------------------------------- */
const params = {
  textureScale: 4, // tiles across the plane
  normalIntensity: 1.0,
  aoIntensity: 1.0,
  roughnessIntensity: 1.0,
  displacementScale: 0.0,
};

function applyTextureScale(scale) {
  for (const map of allMaps) {
    map.repeat.set(scale, scale);
  }
}

// Initial load — builds the textures and applies the current tiling.
loadMaterial(matSettings.active);

const gui = new GUI({ title: t('guiTitle') });

const fMat = gui.addFolder(t('folderMaterial'));
fMat
  .add(matSettings, 'active', Object.keys(MATERIALS))
  .name(t('material'))
  .onChange(loadMaterial);
fMat
  .add(params, 'textureScale', 0.5, 20, 0.1)
  .name(t('textureScale'))
  .onChange(applyTextureScale);
fMat
  .add(params, 'normalIntensity', 0, 3, 0.01)
  .name(t('normalIntensity'))
  .onChange((v) => material.normalScale.set(v, v));
fMat
  .add(params, 'aoIntensity', 0, 3, 0.01)
  .name(t('aoIntensity'))
  .onChange((v) => (material.aoMapIntensity = v));
fMat
  .add(params, 'roughnessIntensity', 0, 2, 0.01)
  .name(t('roughnessIntensity'))
  .onChange((v) => (material.roughness = v));
fMat
  .add(params, 'displacementScale', 0, 1, 0.001)
  .name(t('displacement'))
  .onChange((v) => (material.displacementScale = v));
fMat.close();

const fSnowGround = gui.addFolder(t('folderSnowGround'));
fSnowGround
  .add(snowUniforms.uSnowScale, 'value', 0.02, 0.8, 0.001)
  .name(t('snowDriftScale'));
fSnowGround
  .add(snowUniforms.uSnowSeed.value, 'x', -50, 50, 0.1)
  .name(t('snowSeedX'))
  .listen();
fSnowGround
  .add(snowUniforms.uSnowSeed.value, 'y', -50, 50, 0.1)
  .name(t('snowSeedY'))
  .listen();
fSnowGround
  .add(
    {
      randomize: () =>
        snowUniforms.uSnowSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name(t('snowRandomize'));
fSnowGround
  .add(snowUniforms.uSnowCoverage, 'value', 0, 1, 0.01)
  .name(t('snowCoverage'));
fSnowGround
  .add(snowUniforms.uSnowEdge, 'value', 0.001, 0.4, 0.001)
  .name(t('snowMeltLineSoftness'));
fSnowGround
  .addColor({ c: '#eaf1ff' }, 'c')
  .name(t('snowColor'))
  .onChange((v) => snowUniforms.uSnowColor.value.set(v));
fSnowGround
  .add(snowUniforms.uSnowRoughness, 'value', 0.3, 1, 0.01)
  .name(t('snowRoughness'));
fSnowGround
  .add(snowUniforms.uSnowDepth, 'value', 0, 3, 0.01)
  .name(t('snowDepth'));
fSnowGround
  .add(snowUniforms.uSnowBumpScale, 'value', 0.1, 3, 0.01)
  .name(t('snowDriftBumpScale'));
fSnowGround
  .add(snowUniforms.uSnowBumpStrength, 'value', 0, 2, 0.01)
  .name(t('snowDriftBumpStrength'));
fSnowGround
  .add(snowUniforms.uSparkle, 'value', 0, 1, 0.01)
  .name(t('snowSparkle'));
fSnowGround
  .add(snowUniforms.uSparkleScale, 'value', 20, 300, 1)
  .name(t('snowSparkleDensity'));
fSnowGround.close();

/* --- Lake / model mutual exclusion ----------------------------------------- */
// The frozen lake and the model can't share the scene: enabling one disables the
// other. Both setters guard against recursion (they only disable on enable).
const lakeState = { enabled: false };
const appState = { showModel: false };
let lakeEnabledCtrl = null; // assigned when the toggles are built
let modelShownCtrl = null;
function syncToggleDisplays() {
  if (lakeEnabledCtrl) lakeEnabledCtrl.updateDisplay();
  if (modelShownCtrl) modelShownCtrl.updateDisplay();
}
function setLakeEnabled(v) {
  lakeState.enabled = v;
  lakeUniforms.uLakeEnabled.value = v ? 1 : 0;
  lake.applyShape();
  if (v && appState.showModel) setModelShown(false);
  syncToggleDisplays();
}
function setModelShown(v) {
  appState.showModel = v;
  model.setVisible(v);
  if (v && lakeState.enabled) setLakeEnabled(false);
  syncToggleDisplays();
}

/* --- Frozen lake ----------------------------------------------------------- */
// Master toggle drives the shared uLakeEnabled (carves the ground + shows ice).
const fLake = gui.addFolder(t('folderLake'));
lakeEnabledCtrl = fLake
  .add(lakeState, 'enabled')
  .name(t('lakeEnabled'))
  .onChange(setLakeEnabled);

// Shape & size — every change re-fits the ice disc to the new outline.
const reshape = () => lake.applyShape();
const fShape = fLake.addFolder(t('folderLakeShape'));
fShape.add(lakeUniforms.uLakeRadius, 'value', 1, 9, 0.05).name(t('lakeSize')).onChange(reshape);
fShape.add(lakeUniforms.uLakeCenter.value, 'x', -8, 8, 0.05).name(t('lakeCenterX')).onChange(reshape);
fShape.add(lakeUniforms.uLakeCenter.value, 'y', -8, 8, 0.05).name(t('lakeCenterZ')).onChange(reshape);
fShape.add(lakeUniforms.uLakeShapeAmp, 'value', 0, 0.6, 0.01).name(t('lakeIrregularity')).onChange(reshape);
fShape.add(lakeUniforms.uLakeShapeFreq, 'value', 1, 8, 1).name(t('lakeLobes')).onChange(reshape);
fShape.add(lakeUniforms.uLakeSeed, 'value', 0, 20, 0.01).name(t('lakeShapeSeed')).listen();
fShape
  .add(
    { randomize: () => { lakeUniforms.uLakeSeed.value = Math.random() * 20; } },
    'randomize'
  )
  .name(t('lakeRandomizeShape'));
fShape.add(lakeUniforms.uLakeEdge, 'value', 0.005, 0.25, 0.005).name(t('lakeShoreSoftness'));

// Basin & water depth.
const fBasin = fLake.addFolder(t('folderLakeBasin'));
fBasin.add(lakeUniforms.uLakeDepth, 'value', 0, 3, 0.01).name(t('lakeBasinDepth'));
fBasin.addColor({ c: '#33b1ff' }, 'c').name(t('lakeBedColor')).onChange((v) => lakeUniforms.uLakeBedColor.value.set(v));

// Ice surface look.
const fIce = fLake.addFolder(t('folderLakeIce'));
fIce.add(lake.uniforms.uIceOpacity, 'value', 0, 1, 0.01).name(t('lakeIceOpacity'));
fIce.addColor({ c: '#9fc6d8' }, 'c').name(t('lakeShallowColor')).onChange((v) => lake.uniforms.uShallowColor.value.set(v));
fIce.addColor({ c: '#184762' }, 'c').name(t('lakeDeepWaterColor')).onChange((v) => lake.uniforms.uDeepColor.value.set(v));
fIce.addColor({ c: '#afc4e0' }, 'c').name(t('lakeReflectionColor')).onChange((v) => lake.uniforms.uReflectColor.value.set(v));
fIce.add(lake.uniforms.uReflectStrength, 'value', 0, 1.5, 0.01).name(t('lakeReflectionStrength'));
fIce.add(lake.uniforms.uFresnelPower, 'value', 1, 8, 0.05).name(t('lakeFresnelPower'));
fIce.add(lake.uniforms.uGlint, 'value', 0, 2, 0.01).name(t('lakeSunGlint'));
fIce.add(lake.uniforms.uSurfaceRipple, 'value', 0, 1, 0.01).name(t('lakeSurfaceUnevenness'));
fIce.add(lake.uniforms.uRippleScale, 'value', 0.5, 8, 0.05).name(t('lakeSurfaceScale'));

const fDetail = fLake.addFolder(t('folderLakeDetail'));
fDetail.add(lake.uniforms.uCrackAmount, 'value', 0, 1, 0.01).name(t('lakeCrackAmount'));
fDetail.add(lake.uniforms.uCrackScale, 'value', 0.3, 5, 0.05).name(t('lakeCrackScale'));
fDetail.add(lake.uniforms.uFrost, 'value', 0, 1, 0.01).name(t('lakeShoreFrost'));
fDetail.add(lake.uniforms.uFrostWidth, 'value', 0.05, 0.8, 0.01).name(t('lakeFrostWidth'));
fDetail.add(lake.uniforms.uBubbleAmount, 'value', 0, 1, 0.01).name(t('lakeBubbleAmount'));
fDetail.add(lake.uniforms.uBubbleScale, 'value', 8, 60, 0.5).name(t('lakeBubbleDensity'));

fShape.close();
fBasin.close();
fIce.close();
fDetail.close();
fLake.close();

/* --- Model + snow accumulation --------------------------------------------- */
const fModel = gui.addFolder(t('folderModel'));
modelShownCtrl = fModel
  .add(appState, 'showModel')
  .name(t('loadModel'))
  .onChange(setModelShown);

const modelSelect = { active: 'Rusty Car' };
fModel
  .add(modelSelect, 'active', Object.keys(MODELS))
  .name(t('modelPick'))
  .onChange((k) => model.loadModel(MODELS[k]));

const fileInput = document.getElementById('glb-input');
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) model.importFile(file);
  fileInput.value = ''; // allow re-importing the same file
});
fModel.add({ import: () => fileInput.click() }, 'import').name(t('importGlb'));

// Transform — every change re-syncs the world->model matrix so the snow stays put.
const modelTransform = { scale: 1, posX: 0, posY: 0, posZ: 0, rotY: 0 };
function applyModelTransform() {
  model.group.scale.setScalar(modelTransform.scale);
  model.group.position.set(modelTransform.posX, modelTransform.posY, modelTransform.posZ);
  model.group.rotation.y = THREE.MathUtils.degToRad(modelTransform.rotY);
  model.refreshMatrix();
}
fModel.add(modelTransform, 'scale', 0.05, 10, 0.01).name(t('modelScale')).onChange(applyModelTransform);
fModel.add(modelTransform, 'posX', -10, 10, 0.01).name(t('modelPosX')).onChange(applyModelTransform);
fModel.add(modelTransform, 'posY', -5, 10, 0.01).name(t('modelPosY')).onChange(applyModelTransform);
fModel.add(modelTransform, 'posZ', -10, 10, 0.01).name(t('modelPosZ')).onChange(applyModelTransform);
fModel.add(modelTransform, 'rotY', 0, 360, 1).name(t('modelRotY')).onChange(applyModelTransform);

const fAccum = fModel.addFolder(t('folderAccum'));
fAccum.add(model.snow.uSnowCoverage, 'value', 0, 1, 0.01).name(t('accumCoverage'));
fAccum.add(model.snow.uSnowThickness, 'value', 0, 0.3, 0.001).name(t('accumThickness'));
fAccum.add(model.snow.uSnowScale, 'value', 0.1, 4, 0.01).name(t('accumScale'));
fAccum.add(model.snow.uSnowEdge, 'value', 0.01, 0.4, 0.005).name(t('accumPatchSoftness'));
fAccum.add(model.snow.uSnowSeed.value, 'x', -50, 50, 0.1).name(t('accumSeedX')).listen();
fAccum.add(model.snow.uSnowSeed.value, 'y', -50, 50, 0.1).name(t('accumSeedY')).listen();
fAccum
  .add(
    {
      randomize: () =>
        model.snow.uSnowSeed.value.set(
          (Math.random() - 0.5) * 100,
          (Math.random() - 0.5) * 100
        ),
    },
    'randomize'
  )
  .name(t('accumRandomize'));
fAccum
  .add(model.snow.uSnowFlatThreshold, 'value', 0, 1, 0.01)
  .name(t('accumFlatnessCutoff'));
fAccum
  .addColor({ c: '#eaf1ff' }, 'c')
  .name(t('accumSnowColor'))
  .onChange((v) => model.snow.uSnowColor.value.set(v));
fAccum.add(model.snow.uSnowRoughness, 'value', 0.3, 1, 0.01).name(t('accumSnowRoughness'));
fAccum.add(model.snow.uSnowBump, 'value', 0, 1.5, 0.01).name(t('accumReliefStrength'));
fAccum.add(model.snow.uSnowBumpScale, 'value', 0.5, 8, 0.05).name(t('accumReliefScale'));
fAccum.add(model.snow.uSnowSparkle, 'value', 0, 1, 0.01).name(t('accumSparkle'));
fAccum.add(model.snow.uSnowSparkleScale, 'value', 30, 300, 1).name(t('accumSparkleDensity'));

fAccum.close();
fModel.close();

const snowParams = { density: 0.5 };

// Ambient snowfall sound: muted at density 0, full volume at density 1.
const snowAudio = createSnowAudio();
snowAudio.setDensity(snowParams.density);

const fSnow = gui.addFolder(t('folderSnowfall'));
fSnow
  .add(snowParams, 'density', 0, 1, 0.01)
  .name(t('snowfallDensity'))
  .onChange((v) => {
    snow.setDensity(v);
    snowAudio.setDensity(v);
  });
fSnow.add(snow.uniforms.uSpeed, 'value', 0.5, 12, 0.1).name(t('snowfallFallSpeed'));
fSnow.add(snow.uniforms.uSize, 'value', 0.01, 0.25, 0.001).name(t('snowfallFlakeSize'));
fSnow.add(snow.uniforms.uSway, 'value', 0, 3, 0.01).name(t('snowfallSway'));
fSnow.add(snow.uniforms.uOpacity, 'value', 0, 1, 0.01).name(t('snowfallOpacity'));
fSnow
  .addColor({ c: '#ffffff' }, 'c')
  .name(t('snowfallFlakeColor'))
  .onChange((v) => snow.uniforms.uColor.value.set(v));
fSnow.add(snow.uniforms.uVolume.value, 'y', 10, 80, 1).name(t('snowfallFallHeight'));
fSnow.close();

const fWind = gui.addFolder(t('folderWind'));
fWind.add(wind, 'strength', 0, 12, 0.1).name(t('windStrength')).onChange(applyWind);
fWind.add(wind, 'direction', 0, 360, 1).name(t('windDirection')).onChange(applyWind);
fWind.close();

const fLight = gui.addFolder(t('folderLighting'));
fLight.add(renderer, 'toneMappingExposure', 0, 3, 0.01).name(t('lightingExposure'));
fLight.add(keyLight, 'intensity', 0, 8, 0.01).name(t('lightingKey'));
fLight.add(fillLight, 'intensity', 0, 4, 0.01).name(t('lightingFill'));
fLight.add(rimLight, 'intensity', 0, 400, 1).name(t('lightingRim'));
fLight.add(scene, 'environmentIntensity', 0, 2, 0.01).name(t('lightingEnv'));

// Fog — heavier values dim the scene more as the camera pulls back, so keep it
// light (or turn it off) if zooming reads as a lighting change.
const fogState = { enabled: true, density: scene.fog.density };
function applyFog() {
  scene.fog.density = fogState.enabled ? fogState.density : 0;
}
fLight.add(fogState, 'enabled').name(t('lightingFog')).onChange(applyFog);
fLight
  .add(fogState, 'density', 0, 0.03, 0.0005)
  .name(t('lightingFogDensity'))
  .onChange(applyFog);
fLight.close();

// --- Cinematic --------------------------------------------------------------
const fCine = gui.addFolder(t('folderCinematic'));

const fCam = fCine.addFolder(t('folderCam'));
fCam.add(cine, 'autoOrbit').name(t('autoOrbit')).onChange((v) => (controls.autoRotate = v));
fCam.add(cine, 'orbitSpeed', -3, 3, 0.05).name(t('orbitSpeed')).onChange((v) => (controls.autoRotateSpeed = v));
fCam.add(cine, 'fov', 18, 80, 1).name(t('fov')).onChange((v) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
fCam.add(cine, 'letterbox').name(t('letterbox')).onChange(applyLetterbox);

const dofParams = { enabled: false };
fx.bokeh.enabled = dofParams.enabled; // off by default — opt in when framing
const fDof = fCine.addFolder(t('folderDof'));
fDof.add(dofParams, 'enabled').name(t('dofEnabled')).onChange((v) => (fx.bokeh.enabled = v));
fDof
  .add(fx.bokeh.uniforms.focus, 'value', 1, 40, 0.1)
  .name(t('focusDistance'))
  .onChange(showFocusPlane); // flash the focus plane while dragging
fDof.add(fx.bokeh.uniforms.aperture, 'value', 0, 0.004, 0.00005).name(t('aperture'));
fDof.add(fx.bokeh.uniforms.maxblur, 'value', 0, 0.02, 0.0005).name(t('maxBlur'));

const fFx = fCine.addFolder(t('folderFx'));
fFx.add(fx.bloom, 'strength', 0, 2, 0.01).name(t('bloom'));
fFx.add(fx.bloom, 'radius', 0, 2, 0.01).name(t('bloomRadius'));
fFx.add(fx.bloom, 'threshold', 0, 1, 0.01).name(t('bloomThreshold'));
fFx.add(fx.grade.uniforms.uGrain, 'value', 0, 0.25, 0.005).name(t('filmGrain'));
fFx.add(fx.grade.uniforms.uVignette, 'value', 0, 1.5, 0.01).name(t('vignette'));
fFx.add(fx.grade.uniforms.uChroma, 'value', 0, 0.01, 0.0001).name(t('chromaticAberration'));
fFx.add(fx.grade.uniforms.uContrast, 'value', 0.7, 1.6, 0.01).name(t('contrast'));
fFx.add(fx.grade.uniforms.uSaturation, 'value', 0, 2, 0.01).name(t('saturation'));
fCine.close();

/* -------------------------------------------------------------------------- */
/*  Resize & render loop                                                       */
/* -------------------------------------------------------------------------- */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  fx.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1); // clamp after tab-switches
  shared.uTime.value += dt;

  controls.update();
  snow.update();
  lake.update(camera.position);
  updateFocusPlane(dt);

  fx.render(dt);
});
