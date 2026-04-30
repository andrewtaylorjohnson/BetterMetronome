const majorTrack = document.getElementById("majorTrack");
const subTrack = document.getElementById("subTrack");
const playhead = document.getElementById("playhead");
const bpmValue = document.getElementById("bpmValue");
const tempoControl = document.getElementById("tempoControl");
const transportButton = document.getElementById("transportButton");

const TOTAL_STEPS = 16;
const STEPS_PER_BEAT = 4;
const MAJOR_STEPS = new Set([0, 4, 8, 12]);
const LOOKAHEAD_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_TIME = 0.1;
const MIN_BPM = 40;
const MAX_BPM = 240;

const state = {
  isPlaying: false,
  currentBpm: 120,
  pendingBpm: null,
  pendingBeatGrace: 0,
  previewBpm: null,
  currentStep: 0,
  nextStepTime: 0,
  schedulerId: null,
  activeSubdivisions: new Set(),
  drag: {
    active: false,
    startX: 0,
    startBpm: 120,
  },
};

let audioCtx;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stepDurationSeconds(bpm) {
  return 60 / bpm / STEPS_PER_BEAT;
}

function buildTracks() {
  const majorFragment = document.createDocumentFragment();
  const subFragment = document.createDocumentFragment();

  for (let step = 0; step < TOTAL_STEPS; step += 1) {
    const leftPct = (step / TOTAL_STEPS) * 100;
    if (MAJOR_STEPS.has(step)) {
      const majorTick = document.createElement("div");
      majorTick.className = "major-tick";
      majorTick.style.left = `${leftPct}%`;

      majorFragment.appendChild(majorTick);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sub-button";
    button.style.left = `${leftPct}%`;
    button.dataset.step = String(step);
    button.ariaLabel = `Subdivision ${step + 1}`;

    button.addEventListener("click", () => {
      if (button.disabled) {
        return;
      }
      if (state.activeSubdivisions.has(step)) {
        state.activeSubdivisions.delete(step);
        button.classList.remove("active");
      } else {
        state.activeSubdivisions.add(step);
        button.classList.add("active");
      }
    });

    subFragment.appendChild(button);
  }

  majorTrack.appendChild(majorFragment);
  subTrack.appendChild(subFragment);
}

function updateTempoText() {
  const shown = state.previewBpm ?? state.pendingBpm ?? state.currentBpm;
  bpmValue.textContent = String(shown);
}

function updateTransportButton() {
  transportButton.textContent = state.isPlaying ? "Pause" : "Play";
  transportButton.setAttribute(
    "aria-label",
    state.isPlaying ? "Pause metronome" : "Play metronome"
  );
}

function makeClickSound(time, options) {
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(options.freq, time);
  gain.gain.setValueAtTime(options.volume, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + options.decay);
  oscillator.connect(gain);
  gain.connect(audioCtx.destination);
  oscillator.start(time);
  oscillator.stop(time + options.decay + 0.01);
}

function scheduleStep(step, time) {
  if (MAJOR_STEPS.has(step)) {
    makeClickSound(time, { freq: 1560, volume: 0.35, decay: 0.05 });
  } else if (state.activeSubdivisions.has(step)) {
    makeClickSound(time, { freq: 820, volume: 0.28, decay: 0.06 });
  }
}

function nextStep() {
  const currentStepDuration = stepDurationSeconds(state.currentBpm);
  const playedStep = state.currentStep;
  state.nextStepTime += currentStepDuration;
  state.currentStep = (state.currentStep + 1) % TOTAL_STEPS;

  if (state.pendingBpm !== null && MAJOR_STEPS.has(playedStep)) {
    if (state.pendingBeatGrace > 0) {
      state.pendingBeatGrace -= 1;
    } else {
      state.currentBpm = state.pendingBpm;
      state.pendingBpm = null;
      updateTempoText();
    }
  }

  return playedStep;
}

function scheduler() {
  if (!audioCtx) {
    return;
  }

  while (state.nextStepTime < audioCtx.currentTime + SCHEDULE_AHEAD_TIME) {
    const step = state.currentStep;
    scheduleStep(step, state.nextStepTime);
    nextStep();
  }
}

function updatePlayhead() {
  if (!state.isPlaying || !audioCtx) {
    requestAnimationFrame(updatePlayhead);
    return;
  }

  const stepLen = stepDurationSeconds(state.currentBpm);
  const elapsed = audioCtx.currentTime - (state.nextStepTime - stepLen);
  const progressInStep = clamp(elapsed / stepLen, 0, 1);
  const visualStep = (state.currentStep + progressInStep) % TOTAL_STEPS;
  const leftPct = (visualStep / TOTAL_STEPS) * 100;
  playhead.style.left = `${leftPct}%`;
  requestAnimationFrame(updatePlayhead);
}

async function startTransport() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  if (state.isPlaying) {
    return;
  }

  state.isPlaying = true;
  state.currentStep = 0;
  state.nextStepTime = audioCtx.currentTime + 0.05;
  state.schedulerId = window.setInterval(scheduler, LOOKAHEAD_INTERVAL_MS);
  updateTransportButton();
}

function stopTransport() {
  if (!state.isPlaying) {
    return;
  }
  if (state.schedulerId !== null) {
    window.clearInterval(state.schedulerId);
    state.schedulerId = null;
  }
  state.isPlaying = false;
  state.currentStep = 0;
  playhead.style.left = "0%";
  updateTransportButton();
}

function queueTempoChange(nextBpm) {
  const safeBpm = clamp(Math.round(nextBpm), MIN_BPM, MAX_BPM);
  if (safeBpm === state.currentBpm) {
    state.pendingBpm = null;
    state.pendingBeatGrace = 0;
  } else {
    state.pendingBpm = safeBpm;
    state.pendingBeatGrace = 1;
  }
  updateTempoText();
}

function handlePointerDown(event) {
  event.preventDefault();
  state.drag.active = true;
  state.drag.startX = event.clientX;
  state.drag.startBpm = state.pendingBpm ?? state.currentBpm;
  state.previewBpm = state.drag.startBpm;
  updateTempoText();
  tempoControl.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!state.drag.active) {
    return;
  }
  const deltaX = event.clientX - state.drag.startX;
  const preview = clamp(state.drag.startBpm + deltaX * 0.35, MIN_BPM, MAX_BPM);
  state.previewBpm = Math.round(preview);
  updateTempoText();
}

function finishDrag() {
  if (!state.drag.active) {
    return;
  }
  queueTempoChange(state.previewBpm ?? state.currentBpm);
  state.previewBpm = null;
  state.drag.active = false;
  updateTempoText();
}

function initTempoDrag() {
  tempoControl.addEventListener("pointerdown", handlePointerDown);
  tempoControl.addEventListener("pointermove", handlePointerMove);
  tempoControl.addEventListener("pointerup", finishDrag);
  tempoControl.addEventListener("pointercancel", finishDrag);
  tempoControl.addEventListener("lostpointercapture", finishDrag);
}

transportButton.addEventListener("click", () => {
  if (state.isPlaying) {
    stopTransport();
  } else {
    startTransport();
  }
});

buildTracks();
initTempoDrag();
updateTempoText();
updateTransportButton();
requestAnimationFrame(updatePlayhead);

/*
Manual test checklist:
- Drag left/right on BPM circle (mouse and touch), verify BPM applies after one upcoming major beat.
- Toggle several gray subdivision ticks to white and verify secondary click sounds on those steps only.
- Verify major beat click remains distinct and steady while toggling subdivisions live.
- Confirm playhead tracks across both rails in sync with audible pulses.
- Confirm all subdivision ticks are evenly spaced and each one can be toggled.
*/
