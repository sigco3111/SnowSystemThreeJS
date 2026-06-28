import * as THREE from 'three';

/**
 * Fully procedural, GPU-instanced snow.
 *
 * Every flake is a camera-facing soft round billboard. Positions are wrapped
 * (mod) inside a volume that follows the camera, so the field is effectively
 * infinite for any number of flakes. Unlike rain, snow falls slowly and
 * meanders: each flake gets a per-drop sinusoidal sway (a gentle horizontal
 * wobble + flutter) layered on top of gravity and wind, so it drifts down like
 * real snow instead of dropping in a straight line.
 *
 * `sharedUniforms` (uTime, uWind) are shared by reference with the ground
 * accumulation shader so snow and wind stay in lockstep.
 */
export function createSnow({ camera, sharedUniforms, maxCount = 30000 }) {
  const geometry = new THREE.InstancedBufferGeometry();

  // Base flake quad (a unit square, shaded into a soft disc in the fragment).
  const positions = new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  // Per-flake randoms: a normalized spawn point in the volume + a variation seed.
  const aSeed = new Float32Array(maxCount * 3);
  const aRand = new Float32Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    aSeed[i * 3 + 0] = Math.random();
    aSeed[i * 3 + 1] = Math.random();
    aSeed[i * 3 + 2] = Math.random();
    aRand[i] = Math.random();
  }
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 3));
  geometry.setAttribute('aRand', new THREE.InstancedBufferAttribute(aRand, 1));

  const uniforms = {
    uTime: sharedUniforms.uTime,
    uWind: sharedUniforms.uWind,
    uCameraPos: { value: new THREE.Vector3() },
    uVolume: { value: new THREE.Vector3(50, 40, 50) },
    uSpeed: { value: 3.2 }, // fall speed — snow is slow
    uSize: { value: 0.07 }, // flake radius (world units)
    uSway: { value: 0.5 }, // horizontal wobble amplitude (kept below fall speed)
    uOpacity: { value: 0.9 },
    uColor: { value: new THREE.Color(0xffffff) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3  uWind;
      uniform vec3  uCameraPos;
      uniform vec3  uVolume;
      uniform float uSpeed;
      uniform float uSize;
      uniform float uSway;

      attribute vec3  aSeed;
      attribute float aRand;

      varying vec2  vUv;
      varying float vRand;

      void main() {
        vUv = uv;
        vRand = aRand;

        vec3 vol = uVolume;
        // Volume tracks the camera, biased upward so flakes fall into view.
        vec3 origin = uCameraPos - vec3(vol.x * 0.5, vol.y * 0.85, vol.z * 0.5);

        float speed = uSpeed * (0.6 + 0.7 * aRand); // size/mass variation
        vec3 base = aSeed * vol;

        // Per-flake phase so every flake sways out of step with its neighbours.
        float phase = aRand * 6.2831853;
        float t = uTime;
        // Gentle figure-eight flutter on top of the wind. Kept slow and small so
        // the horizontal drift speed stays well below the fall speed — i.e. with
        // no wind the snow still clearly reads as falling straight down.
        vec3 sway = vec3(
          sin(t * 0.7 + phase) + 0.35 * sin(t * 1.6 + phase * 1.7),
          0.0,
          cos(t * 0.6 + phase) + 0.35 * cos(t * 1.3 + phase * 1.3)
        ) * uSway * (0.4 + 0.6 * aRand);

        vec3 disp = vec3(uWind.x, -speed, uWind.z) * t + sway;

        // Wrap each axis to keep the flake inside the moving volume forever.
        vec3 pos = mod(base + disp - origin, vol) + origin;

        // Camera-facing billboard, sized per flake.
        float size = uSize * (0.5 + 1.0 * aRand);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 world = pos + right * (position.x * size) + up * (position.y * size);

        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3  uColor;

      varying vec2  vUv;
      varying float vRand;

      void main() {
        // Soft round flake: smooth falloff from centre to edge.
        float d = length(vUv - 0.5) * 2.0;
        float disc = smoothstep(1.0, 0.1, d);
        // A brighter core so flakes catch the light like real snow.
        float core = smoothstep(0.6, 0.0, d) * 0.5;
        float alpha = (disc + core) * uOpacity * (0.55 + 0.45 * vRand);
        if (alpha < 0.001) discard;

        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // it's always around the camera
  geometry.instanceCount = Math.floor(maxCount * 0.5); // default density

  return {
    mesh,
    material,
    uniforms,
    maxCount,
    /** Call every frame so the snow volume follows the camera. */
    update() {
      uniforms.uCameraPos.value.copy(camera.position);
    },
    /** Density as a 0..1 fraction of maxCount. */
    setDensity(fraction) {
      geometry.instanceCount = Math.max(
        1,
        Math.floor(THREE.MathUtils.clamp(fraction, 0, 1) * maxCount)
      );
    },
  };
}
