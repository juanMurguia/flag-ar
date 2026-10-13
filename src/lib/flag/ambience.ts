// Sound for the Hall of Fame, made in the browser with Web Audio: no audio files to download or license.
//
// - Wind: brown noise through a band-pass, swelled by two slow, out-of-step LFOs, so the gusts never repeat.
// - Flutter: brighter noise, chopped at about 7 Hz, the snap of cloth near the camera. Kept quiet.
// - Drone: a low D minor chord (D, A, D, F) of detuned sine pairs under a slow-breathing low-pass.
// Everything goes through a synthetic hall reverb, then one master gain that fades in and out.
//
// Browsers block audio until the visitor interacts with the page, so `start()` must run inside a
// pointer or key event handler.

const FADE_IN = 4; // s
const FADE_OUT = 0.6; // s
const LEVEL = 0.55;

function noiseBuffer(ctx: AudioContext, seconds: number, brown: boolean) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = white;
  }
  return buf;
}

/** Impulse response for the reverb: stereo noise that decays over `seconds`. */
function hallImpulse(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

function lfo(ctx: AudioContext, hz: number, depth: number, target: AudioParam) {
  const o = ctx.createOscillator();
  o.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g).connect(target);
  o.start();
}

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Builds the graph on first call, then fades in. Call it from a user gesture. */
  start() {
    if (!this.ctx) this.build();
    const ctx = this.ctx!, g = this.master!.gain;
    void ctx.resume();
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(LEVEL, ctx.currentTime + FADE_IN);
  }

  /** Fades out, then suspends the context so it costs no CPU. */
  stop() {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const g = this.master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(0, ctx.currentTime + FADE_OUT);
    setTimeout(() => {
      if (this.master && this.master.gain.value === 0) void ctx.suspend();
    }, FADE_OUT * 1000 + 100);
  }

  dispose() {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.master = master;

    // Dry path plus a hall reverb. The drone sends more to the reverb than the wind does.
    const reverb = ctx.createConvolver();
    reverb.buffer = hallImpulse(ctx, 5);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    reverb.connect(wet).connect(master);

    // Wind.
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(ctx, 6, true);
    wind.loop = true;
    const windBand = ctx.createBiquadFilter();
    windBand.type = "bandpass";
    windBand.frequency.value = 380;
    windBand.Q.value = 0.6;
    lfo(ctx, 0.05, 160, windBand.frequency); // the pitch of the wind rises with each gust
    const windGain = ctx.createGain();
    windGain.gain.value = 0.32;
    lfo(ctx, 0.071, 0.14, windGain.gain);
    lfo(ctx, 0.113, 0.08, windGain.gain);
    wind.connect(windBand).connect(windGain);
    windGain.connect(master);
    windGain.connect(reverb);
    wind.start();

    // Flutter.
    const flutter = ctx.createBufferSource();
    flutter.buffer = noiseBuffer(ctx, 3, false);
    flutter.loop = true;
    const flutterBand = ctx.createBiquadFilter();
    flutterBand.type = "bandpass";
    flutterBand.frequency.value = 1400;
    flutterBand.Q.value = 1.2;
    const flutterGain = ctx.createGain();
    flutterGain.gain.value = 0.012;
    lfo(ctx, 6.8, 0.009, flutterGain.gain);
    flutter.connect(flutterBand).connect(flutterGain).connect(master);
    flutter.start();

    // Drone: D2, A2, D3, F3.
    const pad = ctx.createBiquadFilter();
    pad.type = "lowpass";
    pad.frequency.value = 520;
    pad.Q.value = 0.4;
    lfo(ctx, 0.04, 220, pad.frequency);
    const padGain = ctx.createGain();
    padGain.gain.value = 0.07;
    pad.connect(padGain);
    padGain.connect(master);
    padGain.connect(reverb);
    for (const [hz, level] of [[73.42, 1], [110, 0.7], [146.83, 0.5], [174.61, 0.35]]) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = hz;
        o.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = level;
        o.connect(g).connect(pad);
        o.start();
      }
    }
  }
}
