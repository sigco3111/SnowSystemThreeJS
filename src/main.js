import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import GUI from 'lil-gui';
import { createSnow } from './snow.js';
import { createPostFX } from './postfx.js';

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
renderer.toneMappingExposure = 1.0;

/* -------------------------------------------------------------------------- */
/*  Scene & Camera                                                             */
/* -------------------------------------------------------------------------- */
const scene = new THREE.Scene();
// Cool, hazy winter night — slightly lifted from black so falling snow reads.
scene.background = new THREE.Color(0x0a0e16);
scene.fog = new THREE.FogExp2(0x0a0e16, 0.015);

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
  'Asphalt 025C': { dir: '/Material_1/', prefix: 'Asphalt025C_1K-JPG_' },
  'Asphalt 024A': { dir: '/Material_2/', prefix: 'Asphalt024A_1K-JPG_' },
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

// Shared GLSL injected into BOTH the vertex and fragment stages: the same
// height field drives the geometry displacement (vertex) and the lit surface
// normals (fragment), so the thick snow shades correctly on its own slopes.
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

// Fractal Brownian motion for organic, blotchy snow drifts.
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

// Returns 0 (bare asphalt) .. 1 (deep snow) for a world-space XZ position.
float snowMaskAt(vec2 worldXZ) {
  vec2 p = worldXZ * uSnowScale + uSnowSeed;
  float n = fbm(p) * 0.5 + 0.5;               // -> 0..1
  float threshold = 1.0 - uSnowCoverage;      // more coverage = lower bar
  return smoothstep(threshold - uSnowEdge, threshold + uSnowEdge, n);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
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

// Surface normal of the displaced snow, from the gradient of the height field.
vec3 snowSurfaceNormal(vec2 worldXZ) {
  float e = 0.08;
  float h0 = snowHeightAt(worldXZ);
  float hx = snowHeightAt(worldXZ + vec2(e, 0.0));
  float hz = snowHeightAt(worldXZ + vec2(0.0, e));
  vec2 grad = vec2(hx - h0, hz - h0) / e;
  return normalize(vec3(-grad.x, 1.0, -grad.y));
}
`;

material.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, snowUniforms);

  // Vertex: inject the height field, then displace the plane upward by it so the
  // snow has real geometric thickness. World XZ is read from the un-displaced
  // position (displacement is purely vertical, so XZ is unaffected).
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + SNOW_FUNCTIONS
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec2 snowXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
      transformed += normalize(objectNormal) * snowHeightAt(snowXZ);
      vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );

  shader.fragmentShader = shader.fragmentShader
    // Inject noise helpers + uniforms (keeps the original <common> include).
    .replace(
      '#include <common>',
      '#include <common>\nvarying vec3 vWorldPosition;\n' + SNOW_FUNCTIONS
    )
    // Compute the mask once and lift the albedo toward snow where it's settled.
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float snowMask = snowMaskAt(vWorldPosition.xz);
      // Subtle brightness variation across the blanket so it isn't a flat fill.
      float snowShade = 0.85 + 0.15 * (fbm(vWorldPosition.xz * uSnowBumpScale * 2.0) * 0.5 + 0.5);
      vec3 snowAlbedo = uSnowColor * snowShade;
      // Sparkle: rare bright specks that catch the light like ice crystals.
      float sp = hash21(floor(vWorldPosition.xz * uSparkleScale));
      float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + sp * 30.0);
      float sparkle = step(0.985, sp) * twinkle * uSparkle;
      snowAlbedo += sparkle;
      diffuseColor.rgb = mix(diffuseColor.rgb, snowAlbedo, snowMask);`
    )
    // Snow is matte; sparkle specks drop to near-mirror to glint.
    .replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, uSnowRoughness, snowMask);
      roughnessFactor = mix(roughnessFactor, 0.08, sparkle * snowMask);`
    )
    // Shade the snow with the normal of its own displaced surface (drift slopes
    // + banked melt-line edges), blended in by the coverage mask.
    .replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
      vec3 snowN = snowSurfaceNormal(vWorldPosition.xz);
      vec3 snowView = normalize((viewMatrix * vec4(snowN, 0.0)).xyz);
      normal = normalize(mix(normal, snowView, snowMask));`
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

const gui = new GUI({ title: '❄️ Snow Studio' });

const fMat = gui.addFolder('Material');
fMat
  .add(matSettings, 'active', Object.keys(MATERIALS))
  .name('Material')
  .onChange(loadMaterial);
fMat
  .add(params, 'textureScale', 0.5, 20, 0.1)
  .name('Texture Scale')
  .onChange(applyTextureScale);
fMat
  .add(params, 'normalIntensity', 0, 3, 0.01)
  .name('Normal Intensity')
  .onChange((v) => material.normalScale.set(v, v));
fMat
  .add(params, 'aoIntensity', 0, 3, 0.01)
  .name('AO Intensity')
  .onChange((v) => (material.aoMapIntensity = v));
fMat
  .add(params, 'roughnessIntensity', 0, 2, 0.01)
  .name('Roughness Intensity')
  .onChange((v) => (material.roughness = v));
fMat
  .add(params, 'displacementScale', 0, 1, 0.001)
  .name('Displacement')
  .onChange((v) => (material.displacementScale = v));
fMat.close();

const fSnowGround = gui.addFolder('Snow on Ground');
fSnowGround
  .add(snowUniforms.uSnowScale, 'value', 0.02, 0.8, 0.001)
  .name('Drift Scale');
fSnowGround
  .add(snowUniforms.uSnowSeed.value, 'x', -50, 50, 0.1)
  .name('Seed X')
  .listen();
fSnowGround
  .add(snowUniforms.uSnowSeed.value, 'y', -50, 50, 0.1)
  .name('Seed Y')
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
  .name('🎲 Randomize Seed');
fSnowGround
  .add(snowUniforms.uSnowCoverage, 'value', 0, 1, 0.01)
  .name('Coverage');
fSnowGround
  .add(snowUniforms.uSnowEdge, 'value', 0.001, 0.4, 0.001)
  .name('Melt-line Softness');
fSnowGround
  .addColor({ c: '#eaf1ff' }, 'c')
  .name('Snow Color')
  .onChange((v) => snowUniforms.uSnowColor.value.set(v));
fSnowGround
  .add(snowUniforms.uSnowRoughness, 'value', 0.3, 1, 0.01)
  .name('Snow Roughness');
fSnowGround
  .add(snowUniforms.uSnowDepth, 'value', 0, 3, 0.01)
  .name('Snow Depth');
fSnowGround
  .add(snowUniforms.uSnowBumpScale, 'value', 0.1, 3, 0.01)
  .name('Drift Bump Scale');
fSnowGround
  .add(snowUniforms.uSnowBumpStrength, 'value', 0, 2, 0.01)
  .name('Drift Bump Strength');
fSnowGround
  .add(snowUniforms.uSparkle, 'value', 0, 1, 0.01)
  .name('Sparkle');
fSnowGround
  .add(snowUniforms.uSparkleScale, 'value', 20, 300, 1)
  .name('Sparkle Density');
fSnowGround.close();

const snowParams = { density: 0.5 };

const fSnow = gui.addFolder('Snowfall');
fSnow
  .add(snowParams, 'density', 0, 1, 0.01)
  .name('Density')
  .onChange((v) => snow.setDensity(v));
fSnow.add(snow.uniforms.uSpeed, 'value', 0.5, 12, 0.1).name('Fall Speed');
fSnow.add(snow.uniforms.uSize, 'value', 0.01, 0.25, 0.001).name('Flake Size');
fSnow.add(snow.uniforms.uSway, 'value', 0, 3, 0.01).name('Sway / Flutter');
fSnow.add(snow.uniforms.uOpacity, 'value', 0, 1, 0.01).name('Opacity');
fSnow
  .addColor({ c: '#ffffff' }, 'c')
  .name('Flake Color')
  .onChange((v) => snow.uniforms.uColor.value.set(v));
fSnow.add(snow.uniforms.uVolume.value, 'y', 10, 80, 1).name('Fall Height');
fSnow.close();

const fWind = gui.addFolder('Wind');
fWind.add(wind, 'strength', 0, 12, 0.1).name('Strength').onChange(applyWind);
fWind.add(wind, 'direction', 0, 360, 1).name('Direction °').onChange(applyWind);
fWind.close();

const fLight = gui.addFolder('Lighting');
fLight.add(renderer, 'toneMappingExposure', 0, 3, 0.01).name('Exposure');
fLight.add(keyLight, 'intensity', 0, 8, 0.01).name('Key');
fLight.add(fillLight, 'intensity', 0, 4, 0.01).name('Fill');
fLight.add(rimLight, 'intensity', 0, 400, 1).name('Rim');
fLight.add(scene, 'environmentIntensity', 0, 2, 0.01).name('Env / IBL');
fLight.close();

// --- Cinematic --------------------------------------------------------------
const fCine = gui.addFolder('🎬 Cinematic');

const fCam = fCine.addFolder('Camera');
fCam.add(cine, 'autoOrbit').name('Auto Orbit').onChange((v) => (controls.autoRotate = v));
fCam.add(cine, 'orbitSpeed', -3, 3, 0.05).name('Orbit Speed').onChange((v) => (controls.autoRotateSpeed = v));
fCam.add(cine, 'fov', 18, 80, 1).name('Focal / FOV').onChange((v) => {
  camera.fov = v;
  camera.updateProjectionMatrix();
});
fCam.add(cine, 'letterbox').name('Letterbox').onChange(applyLetterbox);

const dofParams = { enabled: false };
fx.bokeh.enabled = dofParams.enabled; // off by default — opt in when framing
const fDof = fCine.addFolder('Depth of Field');
fDof.add(dofParams, 'enabled').name('Enable DoF').onChange((v) => (fx.bokeh.enabled = v));
fDof
  .add(fx.bokeh.uniforms.focus, 'value', 1, 40, 0.1)
  .name('Focus Distance')
  .onChange(showFocusPlane); // flash the focus plane while dragging
fDof.add(fx.bokeh.uniforms.aperture, 'value', 0, 0.004, 0.00005).name('Aperture');
fDof.add(fx.bokeh.uniforms.maxblur, 'value', 0, 0.02, 0.0005).name('Max Blur');

const fFx = fCine.addFolder('Effects');
fFx.add(fx.bloom, 'strength', 0, 2, 0.01).name('Bloom');
fFx.add(fx.bloom, 'radius', 0, 2, 0.01).name('Bloom Radius');
fFx.add(fx.bloom, 'threshold', 0, 1, 0.01).name('Bloom Threshold');
fFx.add(fx.grade.uniforms.uGrain, 'value', 0, 0.25, 0.005).name('Film Grain');
fFx.add(fx.grade.uniforms.uVignette, 'value', 0, 1.5, 0.01).name('Vignette');
fFx.add(fx.grade.uniforms.uChroma, 'value', 0, 0.01, 0.0001).name('Chromatic Aberration');
fFx.add(fx.grade.uniforms.uContrast, 'value', 0.7, 1.6, 0.01).name('Contrast');
fFx.add(fx.grade.uniforms.uSaturation, 'value', 0, 2, 0.01).name('Saturation');
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
  updateFocusPlane(dt);

  fx.render(dt);
});
