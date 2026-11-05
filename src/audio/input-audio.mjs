// Anchor pacing to monotonic elapsed time: setInterval callbacks can run late.
// Bounded catch-up avoids accumulating that lateness over a multi-minute call.
export function createPacedAudioTimer({tick, onError, now = () => performance.now(), schedule = setInterval, cancel = clearInterval}) {
  let timer, nextAt, started = false, stopped = false;
  const stop = () => { stopped = true; if (started) cancel(timer); };
  const pump = () => {
    if (stopped) return;
    const due = Math.floor((now() - nextAt) / 20) + 1;
    if (due > 400) { stop(); onError(); return; }
    for (let i = 0; i < Math.min(5, due) && !stopped; i++) {
      if (tick() === false) break;
      nextAt += 20;
    }
  };
  return {
    start() {
      if (started || stopped) return;
      started = true; nextAt = now(); timer = schedule(pump, 20); pump();
    },
    stop,
  };
}

// Supply PCMU silence when the PBX suppresses RTP, while preserving caller speech.
export function createInputAudioClock({send, canSend, onError, now = () => performance.now(), schedule = setInterval, cancel = clearInterval}) {
  const frameSize = 160; // 20 ms of 8 kHz PCMU.
  const maxBufferedBytes = 64000;
  let queue = Buffer.alloc(0), stopped = false;
  const stop = () => {
    stopped = true;
    clock.stop();
    queue = Buffer.alloc(0);
  };
  const fail = (code, bufferedBytes = queue.length) => { stop(); onError({code, bufferedBytes}); };
  const tick = () => {
    if (stopped || !canSend()) return false;
    const length = Math.min(frameSize, queue.length);
    const frame = Buffer.alloc(frameSize, 0xff);
    queue.copy(frame, 0, 0, length);
    try { send(frame); queue = queue.subarray(length); }
    catch { fail('INPUT_AUDIO_SEND_FAILED'); return false; }
  };
  const clock = createPacedAudioTimer({tick, now, schedule, cancel, onError: () => fail('INPUT_AUDIO_CLOCK_STALLED')});
  return {
    start() {
      if (!stopped) clock.start();
    },
    append(data) {
      if (stopped) return;
      const chunk = Buffer.from(data);
      if (queue.length + chunk.length > maxBufferedBytes) { fail('INPUT_AUDIO_BACKLOG', queue.length + chunk.length); return; }
      queue = Buffer.concat([queue, chunk]);
    },
    stop,
  };
}
