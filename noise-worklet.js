// Brown (Brownian / red) noise generator.
//
// Math: Brown noise is the running integral of white noise.
// A naive integral drifts (random walk → unbounded DC), so we use a
// leaky integrator: y[n] = (y[n-1] + step * white) / (1 + leak)
//   - step  (0.005) controls integration amplitude
//   - leak  (0.005) sets the DC-bleed corner ≈ leak * sampleRate / (2π)
//     At 44.1 kHz this puts the corner at ~35 Hz, so the −6 dB/oct
//     brown-noise slope is preserved well into the sub-bass region.
//     (The previous 0.02 leak corner was ~138 Hz, which audibly thinned
//     the bottom end — that's why early builds didn't sound deep enough.)
// Output is then scaled by 8 to bring RMS back into a useful range.

const STEP = 0.005;
const LEAK = 0.005;
const SCALE = 8;

class BrownNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.last = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let last = this.last;
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + STEP * white) / (1 + LEAK);
      out[i] = last * SCALE;
    }
    this.last = last;
    return true;
  }
}

registerProcessor('brown-noise', BrownNoiseProcessor);
