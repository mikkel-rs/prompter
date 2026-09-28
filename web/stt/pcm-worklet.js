// AudioWorklet: mono float input at the context rate -> 16 kHz Int16 frames of ~100 ms.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.acc = [];
    this.accLen = 0;
    this.frameSamples = 1600; // 100 ms at 16 kHz
    this.pos = 0; // fractional read position into the resample stream
    this.carry = new Float32Array(0);
    this.rmsAcc = 0; this.rmsN = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Concatenate carry + new samples, then pick every `ratio`-th sample with linear interp.
    const input = new Float32Array(this.carry.length + ch.length);
    input.set(this.carry, 0); input.set(ch, this.carry.length);
    const out = [];
    let p = this.pos;
    while (p + 1 < input.length) {
      const i = Math.floor(p), f = p - i;
      const s = input[i] * (1 - f) + input[i + 1] * f;
      out.push(s);
      p += this.ratio;
    }
    const consumed = Math.floor(p);
    this.carry = input.slice(consumed);
    this.pos = p - consumed;
    for (const s of out) { this.rmsAcc += s * s; this.rmsN++; }
    this.acc.push(...out);
    while (this.acc.length >= this.frameSamples) {
      const chunk = this.acc.splice(0, this.frameSamples);
      const i16 = new Int16Array(chunk.length);
      for (let k = 0; k < chunk.length; k++) {
        const v = Math.max(-1, Math.min(1, chunk[k]));
        i16[k] = v < 0 ? v * 32768 : v * 32767;
      }
      const rms = Math.sqrt(this.rmsAcc / Math.max(1, this.rmsN));
      this.rmsAcc = 0; this.rmsN = 0;
      this.port.postMessage({ pcm: i16.buffer, rms }, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-downsampler", PcmDownsampler);
