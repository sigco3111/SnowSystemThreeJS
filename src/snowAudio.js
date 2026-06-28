/**
 * Looping ambient snowfall sound whose volume is driven by snow density.
 *
 * density 0   -> muted / paused (no sound)
 * density max -> full volume (`maxVolume`)
 * in between  -> volume scales linearly with density
 *
 * Browsers block audio until the user interacts with the page, so playback is
 * armed on the first pointer/key/touch gesture and started then.
 */
export function createSnowAudio({ src = `${import.meta.env.BASE_URL}snowfall.mp3`, maxVolume = 1.0 } = {}) {
  const audio = new Audio(src);
  audio.loop = true;
  audio.preload = 'auto';
  audio.volume = 0;

  let density = 0; // last requested density (0..1)
  let unlocked = false; // has a user gesture allowed playback yet?

  function refresh() {
    audio.volume = Math.max(0, Math.min(1, density)) * maxVolume;
    // density 0 -> fully disabled (paused); any density -> playing (once unlocked).
    if (density <= 0) {
      if (!audio.paused) audio.pause();
    } else if (unlocked && audio.paused) {
      audio.play().catch(() => {}); // ignore autoplay rejections
    }
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    refresh();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('touchstart', unlock);
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  window.addEventListener('touchstart', unlock);

  return {
    audio,
    /** Set snow density (0..1); volume follows, 0 disables the sound. */
    setDensity(fraction) {
      density = fraction;
      refresh();
    },
  };
}
