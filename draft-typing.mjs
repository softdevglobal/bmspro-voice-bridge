// Synthetic keyboard and mouse feedback in the bridge's native 8 kHz PCMU format.
// Generated locally once; no recordings, network requests or provider usage.
function muLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let value = Math.min(32635, Math.abs(Math.round(sample))) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
}

export function pcmuHasSpeech(frame) {
  if (!frame.length) return false;
  let energy = 0;
  for (const encoded of frame) {
    const value = (~encoded) & 255;
    const magnitude = (((value & 15) << 3) + 132) * (1 << ((value >> 4) & 7)) - 132;
    energy += magnitude * magnitude;
  }
  return energy / frame.length > 80 * 80;
}

const sound = Buffer.alloc(12800, 0xff);
const taps = [0, 1390, 2200, 3780, 4900, 6730, 7620, 9340, 10800, 11620];
let seed = 73;
for (const start of taps) {
  let previous = 0;
  for (let i = 0; i < 180; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    const sample = (noise - previous * 0.7) * 5200 * Math.exp(-i / 45);
    previous = noise;
    sound[start + i] = muLaw(sample);
  }
}

// Mouse press/release pairs sit in pauses between keystrokes. A short resonant
// snap makes them distinct from the noisier keyboard taps on a phone speaker.
for (const start of [3000, 8500]) {
  for (const [delay, gain] of [[0, 1], [240, 0.65]]) {
    for (let i = 0; i < 110; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      const snap = Math.sin(2 * Math.PI * 1400 * i / 8000);
      sound[start + delay + i] = muLaw((snap * 4700 + noise * 1800) * gain * Math.exp(-i / 24));
    }
  }
}

export function createDraftTypingCue({now = () => performance.now(), onPlayback = () => {}} = {}) {
  let startedAt, offset = 0, announced = false;
  return {
    start() {
      if (startedAt !== undefined && now() - startedAt < 45000) return;
      startedAt = now(); offset = 0; announced = false;
    },
    stop() { startedAt = undefined; offset = 0; announced = false; },
    frame(canPlay) {
      // Avoid a distracting click on fast saves and never overlap AI speech.
      if (startedAt !== undefined && now() - startedAt >= 45000) {
        startedAt = undefined;
        return null;
      }
      if (!canPlay || startedAt === undefined || now() - startedAt < 150) return null;
      if (!announced) { announced = true; onPlayback(); }
      const frame = Buffer.from(sound.subarray(offset, offset + 160));
      offset = (offset + 160) % sound.length;
      return frame;
    },
  };
}
