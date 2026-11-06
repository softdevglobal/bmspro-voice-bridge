// Soft, natural keyboard typing played while Sophie looks something up, in the
// bridge's native 8 kHz PCMU format. Generated locally once from a fixed seed:
// no recordings, network requests or provider usage.
//
// Design (v5): quiet background level, realistic key press + softer key release,
// a deeper space bar, irregular word-by-word rhythm with short thinking pauses,
// and a gentle low-pass so nothing sounds sharp on a phone speaker. The loop is
// 6.4 s long so the pattern is not noticeably repetitive.
const RATE = 8000;
export const TYPING_LOOP_FRAMES = 320;          // 320 × 20 ms = 6.4 s
const LENGTH = TYPING_LOOP_FRAMES * 160;
const PEAK = 7000;                              // synthesis gain; measured output peak ≈ 2.5–3k, well below speech

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

let seed = 1307;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0xffffffff; };
const between = (min, max) => min + random() * (max - min);
const ms = value => Math.round(value * RATE / 1000);

/** One key event: a short filtered click plus a damped "body" tone. */
function addKey(buffer, start, {gain, body, bodyDecay, clickDecay}) {
  let filtered = 0;
  for (let i = 0; i < ms(25) && start + i < buffer.length; i++) {
    const noise = random() * 2 - 1;
    filtered += 0.45 * (noise - filtered);      // soften the click
    const click = filtered * Math.exp(-i / clickDecay);
    const tone = Math.sin(2 * Math.PI * body * i / RATE) * Math.exp(-i / bodyDecay);
    buffer[start + i] += (click * 0.65 + tone * 0.35) * gain;
  }
}

function buildTyping() {
  const samples = new Float64Array(LENGTH);
  let at = 2;                                   // first key straight away (the cue already waits 150 ms)
  const end = LENGTH - ms(450);                 // quiet tail so the loop joins smoothly
  while (at < end) {
    const letters = Math.round(between(3, 8));
    for (let k = 0; k < letters && at < end; k++) {
      const gain = PEAK * between(0.6, 1);
      const body = between(1100, 1700);
      addKey(samples, at, {gain, body, bodyDecay: between(14, 22), clickDecay: between(6, 10)});
      // Key release: same key, much softer, shortly after the press.
      addKey(samples, at + ms(between(55, 85)), {gain: gain * 0.28, body: body * 1.08, bodyDecay: 10, clickDecay: 5});
      at += ms(between(95, 175));
    }
    if (at >= end) break;
    // Space bar: deeper and a little longer.
    addKey(samples, at, {gain: PEAK * between(0.75, 0.95), body: between(650, 850), bodyDecay: 30, clickDecay: 9});
    at += ms(between(130, 210));
    // Most words flow on; some are followed by a short pause, a few by a longer one.
    const pause = random();
    if (pause > 0.82) at += ms(between(700, 1100));
    else if (pause > 0.55) at += ms(between(250, 450));
  }
  // Gentle overall low-pass to keep the sound warm rather than crisp.
  const sound = Buffer.alloc(LENGTH);
  let smooth = 0;
  for (let i = 0; i < LENGTH; i++) {
    smooth += 0.6 * (samples[i] - smooth);
    sound[i] = muLaw(smooth);
  }
  return sound;
}

const sound = buildTyping();

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
