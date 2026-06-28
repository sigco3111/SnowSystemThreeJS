import * as THREE from 'three';

/**
 * Frozen-lake ice sheet.
 *
 * A translucent disc laid over the basin carved into the snow ground. It reads
 * the SAME shared lake-shape uniforms as the ground shader (passed in via
 * `lakeUniforms`) so its irregular outline and depth profile line up exactly
 * with the basin beneath it.
 *
 * Realism comes from layering: a depth-graded base colour (icy shallows ->
 * deep blue centre) seen by alpha-blending over the dark carved bed, plus
 * fresnel sky reflection, a shoreline frost rime, branching cracks, trapped
 * air bubbles, and a specular sun glint. Because it's alpha-blended over the
 * real (sunken) geometry, orbiting the camera gives genuine depth parallax.
 *
 * @param {object}   o
 * @param {object}   o.lakeUniforms  shared shape uniforms (by reference)
 * @param {object}   o.sharedUniforms  { uTime }
 * @param {string}   o.noiseGLSL     NOISE_FUNCTIONS chunk
 * @param {string}   o.lakeGLSL      LAKE_FUNCTIONS chunk
 * @param {THREE.Vector3} o.sunDir   direction TO the key light (for the glint)
 * @param {THREE.Color}   o.sunColor key-light colour
 */
export function createLake({
  lakeUniforms,
  sharedUniforms,
  noiseGLSL,
  lakeGLSL,
  sunDir,
  sunColor,
}) {
  const iceLevel = 0.04; // sits just above bare ground, below the snow banks

  const uniforms = {
    uTime: sharedUniforms.uTime,
    uCameraPos: { value: new THREE.Vector3() },
    uSunDir: { value: sunDir.clone().normalize() },
    uSunColor: { value: sunColor.clone() },
    // --- Look controls -------------------------------------------------------
    uIceOpacity: { value: 1.0 }, // overall ice density
    uShallowColor: { value: new THREE.Color(0x9fc6d8) }, // thin ice near shore
    uDeepColor: { value: new THREE.Color(0x123244) }, // deep water under ice
    uReflectColor: { value: new THREE.Color(0xafc4e0) }, // cool sky reflection
    uReflectStrength: { value: 0.8 },
    uFresnelPower: { value: 3.5 },
    uSurfaceRipple: { value: 0.25 }, // micro surface unevenness
    uRippleScale: { value: 0.5 },
    uCrackAmount: { value: 0.31 },
    uCrackScale: { value: 0.3 },
    uFrost: { value: 0.6 }, // shoreline frost rime
    uFrostWidth: { value: 0.74 }, // how far the frost reaches inward
    uBubbleAmount: { value: 0.12 }, // trapped air bubbles
    uBubbleScale: { value: 29.5 },
    uGlint: { value: 0.7 }, // sun specular highlight
  };
  // Share the lake-shape uniforms by reference so the GUI / ground stay in sync.
  Object.assign(uniforms, lakeUniforms);

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorldPos;

      uniform float uTime;
      uniform vec3  uCameraPos;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform float uIceOpacity;
      uniform vec3  uShallowColor;
      uniform vec3  uDeepColor;
      uniform vec3  uReflectColor;
      uniform float uReflectStrength;
      uniform float uFresnelPower;
      uniform float uSurfaceRipple;
      uniform float uRippleScale;
      uniform float uCrackAmount;
      uniform float uCrackScale;
      uniform float uFrost;
      uniform float uFrostWidth;
      uniform float uBubbleAmount;
      uniform float uBubbleScale;
      uniform float uGlint;

      ${noiseGLSL}
      ${lakeGLSL}

      void main() {
        vec2 xz = vWorldPos.xz;
        float inside = lakeInsideAt(xz);
        if (inside <= 0.002) discard;        // irregular outline
        float depth01 = lakeDepth01(xz);     // 0 shore .. 1 deep centre

        // Ice surface normal: flat 'up' nudged by fine surface unevenness.
        float e = 0.1;
        float h0 = fbm(xz * uRippleScale);
        float hx = fbm(xz * uRippleScale + vec2(e, 0.0));
        float hz = fbm(xz * uRippleScale + vec2(0.0, e));
        vec2 g = vec2(hx - h0, hz - h0) / e;
        vec3 N = normalize(vec3(-g.x * uSurfaceRipple, 1.0, -g.y * uSurfaceRipple));

        vec3 V = normalize(uCameraPos - vWorldPos);

        // Depth-graded base: icy shallows blend to deep water toward the centre.
        vec3 baseCol = mix(uShallowColor, uDeepColor, depth01);

        // Cracks: bright air-filled ridge lines where the noise crosses zero.
        float cr = abs(fbm(xz * uCrackScale + 11.0));
        float cracks = (1.0 - smoothstep(0.0, 0.05, cr)) * uCrackAmount;
        baseCol += cracks * 0.6;

        // Trapped bubbles: sparse specks, more visible in the clearer deep ice.
        float bh = hash21(floor(xz * uBubbleScale));
        float bubbles = step(0.93, bh) * uBubbleAmount * (0.3 + 0.7 * depth01);
        baseCol += bubbles * 0.5;

        // Frost rime hugging the shoreline (small depth = near the edge).
        float frost = (1.0 - smoothstep(0.0, uFrostWidth, depth01)) * uFrost;
        baseCol = mix(baseCol, vec3(0.95, 0.97, 1.0), frost);

        // Fresnel sky reflection — stronger at grazing angles.
        float fres = pow(1.0 - max(dot(N, V), 0.0), uFresnelPower);
        vec3 refl = reflect(-V, N);
        vec3 sky = mix(uReflectColor * 0.45, uReflectColor, clamp(refl.y * 0.5 + 0.5, 0.0, 1.0));
        vec3 col = mix(baseCol, sky, fres * uReflectStrength);

        // Sun glint (specular streak from the key light).
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 200.0);
        col += uSunColor * spec * uGlint;

        // Opacity: clear shallows (see the bed) -> dense, reflective deep ice;
        // frost & cracks read as more opaque; feather the very edge.
        float edgeFeather = smoothstep(0.0, 0.05, inside);
        float alpha = uIceOpacity * mix(0.4, 0.92, depth01);
        alpha = max(alpha, fres * uReflectStrength);
        alpha = clamp(alpha + frost * 0.5 + cracks * 0.4, 0.0, 1.0) * edgeFeather;

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  // Unit disc; rescaled to cover the irregular blob and moved to the lake centre.
  const geometry = new THREE.CircleGeometry(1, 96);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2; // lie flat (local XY -> world XZ)
  mesh.renderOrder = 2; // draw after the opaque ground
  mesh.frustumCulled = false;

  // Resize/recentre the disc to the current shape (called on every shape change).
  function applyShape() {
    const c = lakeUniforms.uLakeCenter.value;
    const maxR =
      lakeUniforms.uLakeRadius.value *
        (1.0 + lakeUniforms.uLakeShapeAmp.value) +
      0.5; // margin so the feathered edge isn't clipped
    mesh.position.set(c.x, iceLevel, c.y);
    mesh.scale.set(maxR, maxR, 1);
    mesh.visible = lakeUniforms.uLakeEnabled.value > 0.5;
  }
  applyShape();

  return {
    mesh,
    uniforms,
    applyShape,
    update(cameraPos) {
      uniforms.uCameraPos.value.copy(cameraPos);
    },
  };
}
