import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Drop-a-model-in-the-snow system (the winter counterpart to the rain's
 * wet-model loader).
 *
 *  - Loads a default GLB and lets the user import any .glb at runtime.
 *  - Sits the model on the ground plane, centered, with scale/pos/rot controls.
 *  - Injects a "snow accumulation" shader into every mesh material:
 *      • upward-facing faces grow a real, displaced layer of snow whose
 *        THICKNESS, COVERAGE, SCALE and SEED are all tunable (so flat tops and
 *        shoulders cap with snow on any model, with no mesh analysis);
 *      • the capped area turns matte snow-white with subtle drift shading and
 *        ice-crystal sparkle, matching the ground snow.
 *
 * Shares uTime by reference with the rest of the scene so the sparkle twinkles
 * in lockstep.
 */
export function createModelSystem({ scene, sharedUniforms, defaultUrl }) {
  const loader = new GLTFLoader();

  // Transform wrapper — user controls live here; the GLB is recentered inside.
  const group = new THREE.Group();
  group.visible = false; // hidden until the user toggles it on
  scene.add(group);
  let current = null; // the loaded GLB scene
  const processed = new Set(); // materials we've already made snowy

  /* ---- snow-accumulation uniforms (shared time + own knobs) -------------- */
  const snow = {
    uTime: sharedUniforms.uTime,
    uModelInv: { value: new THREE.Matrix4() }, // world -> model space (locks the pattern)
    uSnowSeed: { value: new THREE.Vector2(3.0, 7.0) }, // pan the coverage noise
    uSnowScale: { value: 0.9 }, // coverage noise frequency
    uSnowCoverage: { value: 0.7 }, // 0 = bare model, 1 = fully capped
    uSnowEdge: { value: 0.15 }, // coverage shoreline softness
    uSnowThickness: { value: 0.06 }, // displaced layer depth (world units)
    uSnowFlatThreshold: { value: 0.35 }, // how upward a face must be to collect
    uSnowColor: { value: new THREE.Color(0xeaf1ff) }, // cool snow white
    uSnowRoughness: { value: 0.85 }, // snow is matte
    uSnowSparkle: { value: 0.5 }, // ice-crystal glints
    uSnowSparkleScale: { value: 120.0 }, // glint density
    uSnowBump: { value: 0.4 }, // micro surface relief strength
    uSnowBumpScale: { value: 3.0 }, // micro relief frequency
  };

  // Shared GLSL (uniforms + noise + the coverage/relief helpers), injected into
  // BOTH stages: the vertex stage grows the layer, the fragment stage shades it.
  const SNOW_GLSL = /* glsl */ `
  varying vec3 vWorldNormalW;
  varying vec3 vModelPosW;
  uniform float uTime;
  uniform mat4  uModelInv;
  uniform vec2  uSnowSeed;
  uniform float uSnowScale;
  uniform float uSnowCoverage;
  uniform float uSnowEdge;
  uniform float uSnowThickness;
  uniform float uSnowFlatThreshold;
  uniform vec3  uSnowColor;
  uniform float uSnowRoughness;
  uniform float uSnowSparkle;
  uniform float uSnowSparkleScale;
  uniform float uSnowBump;
  uniform float uSnowBumpScale;

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
  float fbm(vec2 p) {
    float value = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) { value += amp * snoise(p); p *= 2.0; amp *= 0.5; }
    return value;
  }
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  // Patchy coverage from a top-down world-space noise (0 bare .. 1 covered).
  float snowCoverageMask(vec2 worldXZ) {
    float n = fbm(worldXZ * uSnowScale + uSnowSeed) * 0.5 + 0.5;
    float threshold = 1.0 - uSnowCoverage;
    return smoothstep(threshold - uSnowEdge, threshold + uSnowEdge, n);
  }

  // How much snow sits at a world point, given its world-space normal: only
  // upward-ish faces collect, modulated by the patchy coverage. 0..1.
  float snowAccumAt(vec3 worldNormal, vec2 worldXZ) {
    float up = clamp(worldNormal.y, 0.0, 1.0);
    float top = smoothstep(uSnowFlatThreshold, 1.0, up);
    return top * snowCoverageMask(worldXZ);
  }

  // Soft snow surface normal (world up nudged by fine relief).
  vec3 snowReliefNormal(vec2 worldXZ) {
    float e = 0.04;
    float h0 = fbm(worldXZ * uSnowBumpScale);
    float hx = fbm(worldXZ * uSnowBumpScale + vec2(e, 0.0));
    float hz = fbm(worldXZ * uSnowBumpScale + vec2(0.0, e));
    vec2 grad = vec2(hx - h0, hz - h0) / e;
    return normalize(vec3(-grad.x * uSnowBump, 1.0, -grad.y * uSnowBump));
  }
  `;

  function makeSnowy(material) {
    if (!material || processed.has(material)) return;
    processed.add(material);

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, snow);

      // Vertex: grow the snow layer on upward faces by displacing along the
      // surface normal. The displacement is converted from world units to local
      // units per-mesh (dividing by the world length of the mapped normal) so it
      // stays a consistent thickness regardless of the model/mesh scale.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + SNOW_GLSL)
        .replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nvWorldNormalW = normalize(mat3(modelMatrix) * objectNormal);'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 wPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vModelPosW = (uModelInv * vec4(wPos, 1.0)).xyz; // model-locked coords
          vec3 wN = mat3(modelMatrix) * objectNormal;
          float ms = max(length(wN), 1e-4);
          float accum = snowAccumAt(wN / ms, vModelPosW.xz);
          transformed += normalize(objectNormal) * (uSnowThickness * accum / ms);`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + SNOW_GLSL)
        // Cap the upward faces with matte snow-white + sparkle.
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec3 wn = normalize(vWorldNormalW);
          float snowAmt = snowAccumAt(wn, vModelPosW.xz);
          float shade = 0.85 + 0.15 * (fbm(vModelPosW.xz * uSnowBumpScale * 2.0) * 0.5 + 0.5);
          vec3 snowCol = uSnowColor * shade;
          float sp = hash21(floor(vModelPosW.xz * uSnowSparkleScale));
          float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + sp * 30.0);
          float sparkle = step(0.985, sp) * twinkle * uSnowSparkle;
          snowCol += sparkle;
          diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, snowAmt);`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, uSnowRoughness, snowAmt);
          roughnessFactor = mix(roughnessFactor, 0.08, sparkle * snowAmt);`
        )
        // Re-normal the capped area with soft snow relief (world up + bumps).
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          vec3 sN = snowReliefNormal(vModelPosW.xz);
          vec3 sView = normalize((viewMatrix * vec4(sN, 0.0)).xyz);
          normal = normalize(mix(normal, sView, snowAmt));`
        );
    };
    material.customProgramCacheKey = () => 'snow-model-v1';
    material.needsUpdate = true;
  }

  function disposeMaterial(mat) {
    if (!mat) return;
    for (const v of Object.values(mat)) {
      if (v && v.isTexture) v.dispose();
    }
    mat.dispose();
  }

  function setModel(root) {
    if (current) {
      group.remove(current);
      current.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach(disposeMaterial);
        else disposeMaterial(o.material);
      });
    }
    processed.clear();

    // Recenter on XZ and rest on the ground (y = 0) before the user transform.
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;

    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (Array.isArray(o.material)) o.material.forEach(makeSnowy);
      else makeSnowy(o.material);
    });

    current = root;
    group.add(root);
    refreshMatrix();
  }

  // Keep the world->model matrix current so the snow pattern stays locked to the
  // model when it's moved, rotated or scaled.
  function refreshMatrix() {
    group.updateMatrixWorld(true);
    snow.uModelInv.value.copy(group.matrixWorld).invert();
  }

  function loadURL(url, onError) {
    loader.load(
      url,
      (gltf) => setModel(gltf.scene),
      undefined,
      (err) => onError && onError(err)
    );
  }

  if (defaultUrl) loadURL(defaultUrl);

  return {
    group,
    snow,
    /** Load a GLB from a user File object. */
    importFile(file) {
      const url = URL.createObjectURL(file);
      loadURL(url, (e) => console.error('Failed to load GLB:', e));
    },
    /** Swap to one of the bundled models by URL. */
    loadModel(url) {
      loadURL(url, (e) => console.error('Failed to load GLB:', e));
    },
    /** Re-sync the world->model matrix after a transform change. */
    refreshMatrix,
    /** Show/hide the model. */
    setVisible(v) {
      group.visible = v;
    },
    get isVisible() {
      return group.visible;
    },
  };
}
