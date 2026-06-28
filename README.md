# Snow System (Three.js)

A realistic, fully procedural snow studio — the winter counterpart to the Rain
System. Reuses the same asphalt PBR textures, cinematic lighting rig, and
post-processing stack, with snowfall and ground-accumulation replacing the rain
and puddles.

## What's inside

- **GPU-instanced snowfall** (`src/snow.js`) — soft round flakes that fall
  slowly and meander with a per-flake figure-eight flutter, drifting on the
  wind. The field wraps around the camera so it's effectively infinite.
- **Snow accumulation shader** (`src/main.js`) — an FBM noise mask in world
  space decides where snow has settled on the asphalt. Inside the blanket the
  albedo lifts to a cool snow-white, roughness goes matte, the surface gains
  soft drift bumps, and scattered ice-crystal **sparkles** twinkle in the light.
- **Same cinematic rig** — identical key/fill/rim/ambient lighting, IBL, and
  the Bokeh DoF -> Bloom -> film-grade post stack (`src/postfx.js`).
- **lil-gui controls** for material, snow-on-ground, snowfall, wind, lighting,
  and the cinematic camera/DoF/effects.

> Model import is intentionally left out to keep this build simple.

## Run

```bash
npm install
npm run dev
```

Drag to orbit, scroll to zoom.
