/** A soft, short shutter sound synthesised with Web Audio — no audio files needed. */
let ctx: AudioContext | null = null;

export function playShutter(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.09);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Two quick clicks: the shutter opening and closing.
      const env = Math.exp(-t * 38) + 0.55 * Math.exp(-Math.abs(t - 0.55) * 60);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2600;
    band.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(now);
  } catch {
    /* audio is a nicety */
  }
}
