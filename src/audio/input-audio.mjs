// Purpose: keeps the caller's audio flowing to OpenAI at a steady pace.
// Phone audio (PCMU, 8 kHz) is sent in 20 ms frames, 50 per second. This file provides:
//   1. createPacedAudioTimer: a steady 20 ms clock that does not drift on long calls.
//   2. createInputAudioClock: a queue that sends caller audio frame by frame,
//      and fills gaps with silence when the phone system sends nothing.

// Anchor pacing to monotonic elapsed time: setInterval callbacks can run late.
// Bounded catch-up avoids accumulating that lateness over a multi-minute call.
// tick: called once per 20 ms frame; return false to pause for this round.
// onError: called if the clock falls too far behind.
// now / schedule / cancel: time functions, replaceable so tests can fake time.
export function createPacedAudioTimer({tick, onError, now = () => performance.now(), schedule = setInterval, cancel = clearInterval}) {
  // timer: the interval handle. nextAt: when the next frame is due. started/stopped: lifecycle flags.
  let timer, nextAt, started = false, stopped = false;
  // Stops the clock for good, and cancels the interval if it was started.
  const stop = () => { stopped = true; if (started) cancel(timer); };
  // Runs every 20 ms: sends any frames that are due.
  const pump = () => {
    // Do nothing once stopped.
    if (stopped) return;
    // How many 20 ms frames are due by now (at least 1 once the time has passed).
    const due = Math.floor((now() - nextAt) / 20) + 1;
    // More than 400 frames (8 seconds) behind: give up and report an error.
    if (due > 400) { stop(); onError(); return; }
    // Send the due frames, but at most 5 per run so catching up stays gentle.
    for (let i = 0; i < Math.min(5, due) && !stopped; i++) {
      // If tick says it cannot send now (returns false), stop for this round.
      if (tick() === false) break;
      // Move the schedule forward by one frame (20 ms).
      nextAt += 20;
    }
  };
  // The object the caller uses.
  return {
    // Starts the clock (only once, and not after stop).
    start() {
      // Ignore a second start, or a start after stop.
      if (started || stopped) return;
      // Mark started, set the first due time to now, run pump every 20 ms, and run it once straight away.
      started = true; nextAt = now(); timer = schedule(pump, 20); pump();
    },
    // Stops the clock.
    stop,
  };
}

// Supply PCMU silence when the PBX suppresses RTP, while preserving caller speech.
// send(frame): sends one 160-byte frame onward. canSend(): true when the connection is ready.
// onError({code, bufferedBytes}): called when something goes wrong.
export function createInputAudioClock({send, canSend, onError, now = () => performance.now(), schedule = setInterval, cancel = clearInterval}) {
  const frameSize = 160; // 20 ms of 8 kHz PCMU.
  // Most audio waiting in the queue: 64,000 bytes = 8 seconds. More than this means we are too far behind.
  const maxBufferedBytes = 64000;
  // queue: caller audio waiting to be sent. stopped: this clock has been stopped.
  let queue = Buffer.alloc(0), stopped = false;
  // Stops everything and throws away any queued audio.
  const stop = () => {
    // Remember that we are stopped, so nothing more is sent.
    stopped = true;
    // Stop the underlying 20 ms clock (defined further down).
    clock.stop();
    // Empty the queue.
    queue = Buffer.alloc(0);
  };
  // Stops everything, then reports an error code and how many bytes were queued.
  const fail = (code, bufferedBytes = queue.length) => { stop(); onError({code, bufferedBytes}); };
  // Called every 20 ms by the clock: sends exactly one frame.
  const tick = () => {
    // Do not send if stopped or the connection is not ready; false tells the clock to pause.
    if (stopped || !canSend()) return false;
    // How much real audio we have for this frame (up to 160 bytes).
    const length = Math.min(frameSize, queue.length);
    // Start with a full frame of 0xFF, which is silence in PCMU.
    const frame = Buffer.alloc(frameSize, 0xff);
    // Copy the real audio over the start of the frame; any remainder stays as silence.
    queue.copy(frame, 0, 0, length);
    // Send the frame, then remove the sent audio from the queue.
    try { send(frame); queue = queue.subarray(length); }
    // If sending fails, stop and report; false tells the clock to pause.
    catch { fail('INPUT_AUDIO_SEND_FAILED'); return false; }
  };
  // Create the 20 ms clock that calls tick; if it falls too far behind, report INPUT_AUDIO_CLOCK_STALLED.
  const clock = createPacedAudioTimer({tick, now, schedule, cancel, onError: () => fail('INPUT_AUDIO_CLOCK_STALLED')});
  // The object the bridge uses.
  return {
    // Starts sending frames (unless already stopped).
    start() {
      if (!stopped) clock.start();
    },
    // Adds incoming caller audio to the queue.
    append(data) {
      // Ignore audio after stop.
      if (stopped) return;
      // Copy the incoming bytes into a Buffer.
      const chunk = Buffer.from(data);
      // If adding this would exceed 8 seconds of backlog, stop and report INPUT_AUDIO_BACKLOG.
      if (queue.length + chunk.length > maxBufferedBytes) { fail('INPUT_AUDIO_BACKLOG', queue.length + chunk.length); return; }
      // Otherwise add it to the end of the queue.
      queue = Buffer.concat([queue, chunk]);
    },
    // Stops the clock and clears the queue.
    stop,
  };
}
