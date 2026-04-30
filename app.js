const majorTrack = document.getElementById("majorTrack");
const subTrack = document.getElementById("subTrack");
const playhead = document.getElementById("playhead");
const bpmValue = document.getElementById("bpmValue");
const bpmInput = document.getElementById("bpmInput");
const tempoControl = document.getElementById("tempoControl");
const transportButton = document.getElementById("transportButton");

const TOTAL_STEPS = 16;
const STEPS_PER_BEAT = 4;
const MAJOR_STEPS = new Set([0, 4, 8, 12]);
const LOOKAHEAD_INTERVAL_MS = 25;
const SCHEDULE_AHEAD_TIME = 0.1;
const TAP_DRAG_THRESHOLD_PX = 8;
const MIN_BPM = 40;
const MAX_BPM = 240;
const TEMPO_CONTROL_IDLE_LABEL = "Drag left or right to set tempo or tap to type BPM";

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
  phaseSegments: [],
  isTempoEditing: false,
  transportRunId: 0,
  majorTicks: new Map(),
  subdivisionButtons: new Map(),
  drag: {
    active: false,
    startX: 0,
    startY: 0,
    startBpm: 120,
    didDrag: false,
    pointerId: null,
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
  state.majorTicks.clear();
  state.subdivisionButtons.clear();

  for (let step = 0; step < TOTAL_STEPS; step += 1) {
    const leftPct = (step / TOTAL_STEPS) * 100;
    if (MAJOR_STEPS.has(step)) {
      const majorTick = document.createElement("div");
      majorTick.className = "major-tick";
      majorTick.style.left = `${leftPct}%`;
      state.majorTicks.set(step, majorTick);

      majorFragment.appendChild(majorTick);
      continue;
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

    state.subdivisionButtons.set(step, button);
    subFragment.appendChild(button);
  }

  majorTrack.appendChild(majorFragment);
  subTrack.appendChild(subFragment);
}

function updateTempoText() {
  const shown = state.previewBpm ?? state.pendingBpm ?? state.currentBpm;
  bpmValue.textContent = String(shown);
  if (!state.isTempoEditing) {
    bpmInput.value = String(shown);
  }
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

function pulseElement(element) {
  if (!element) {
    return;
  }
  element.classList.remove("pulse");
  // Restart animation for repeated triggers on the same element.
  void element.offsetWidth;
  element.classList.add("pulse");
}

function scheduleVisualPulse(step, time, runId) {
  if (!audioCtx) {
    return;
  }
  const delayMs = Math.max(0, (time - audioCtx.currentTime) * 1000);
  window.setTimeout(() => {
    if (!state.isPlaying || state.transportRunId !== runId) {
      return;
    }
    if (MAJOR_STEPS.has(step)) {
      pulseElement(state.majorTicks.get(step));
      return;
    }
    if (state.activeSubdivisions.has(step)) {
      pulseElement(state.subdivisionButtons.get(step));
    }
  }, delayMs);
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
      pushPhaseSegment(state.nextStepTime, state.currentStep, state.currentBpm);
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
    scheduleVisualPulse(step, state.nextStepTime, state.transportRunId);
    nextStep();
  }
}

function pushPhaseSegment(startTime, startStep, bpm) {
  const segment = {
    startTime,
    startStep,
    bpm,
  };
  const existingIndex = state.phaseSegments.findIndex(
    (item) => Math.abs(item.startTime - startTime) < 0.000001
  );
  if (existingIndex >= 0) {
    state.phaseSegments.splice(existingIndex, 1, segment);
  } else {
    state.phaseSegments.push(segment);
    state.phaseSegments.sort((a, b) => a.startTime - b.startTime);
  }
  if (state.phaseSegments.length > 16) {
    state.phaseSegments = state.phaseSegments.slice(-16);
  }
}

function getPlayheadStepAtTime(time) {
  if (state.phaseSegments.length === 0) {
    return 0;
  }
  const firstSegment = state.phaseSegments[0];
  if (time <= firstSegment.startTime) {
    return firstSegment.startStep;
  }
  let activeSegment = firstSegment;
  for (const segment of state.phaseSegments) {
    if (segment.startTime <= time) {
      activeSegment = segment;
    } else {
      break;
    }
  }
  const elapsed = Math.max(0, time - activeSegment.startTime);
  const elapsedSteps = elapsed / stepDurationSeconds(activeSegment.bpm);
  return (activeSegment.startStep + elapsedSteps) % TOTAL_STEPS;
}

function updatePlayhead() {
  if (!state.isPlaying || !audioCtx) {
    requestAnimationFrame(updatePlayhead);
    return;
  }

  const visualStep = getPlayheadStepAtTime(audioCtx.currentTime);
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
  state.transportRunId += 1;
  state.currentStep = 0;
  state.nextStepTime = audioCtx.currentTime + 0.05;
  state.phaseSegments = [];
  pushPhaseSegment(state.nextStepTime, state.currentStep, state.currentBpm);
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
  state.transportRunId += 1;
  state.currentStep = 0;
  state.phaseSegments = [];
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
    state.pendingBeatGrace = 0;
  }
  updateTempoText();
}

function beginTempoEditing() {
  if (state.isTempoEditing) {
    return;
  }
  state.isTempoEditing = true;
  state.previewBpm = null;
  updateTempoText();
  bpmValue.hidden = true;
  bpmInput.hidden = false;
  tempoControl.setAttribute("aria-label", "Type tempo BPM and press Enter");
  requestAnimationFrame(() => {
    bpmInput.focus();
    bpmInput.select();
  });
}

function finishTempoEditing(shouldCommit) {
  if (!state.isTempoEditing) {
    return;
  }
  if (shouldCommit) {
    const typed = Number.parseInt(bpmInput.value, 10);
    if (Number.isFinite(typed)) {
      queueTempoChange(typed);
    }
  }
  state.isTempoEditing = false;
  bpmInput.hidden = true;
  bpmValue.hidden = false;
  tempoControl.setAttribute("aria-label", TEMPO_CONTROL_IDLE_LABEL);
  updateTempoText();
}

function handlePointerDown(event) {
  if (state.isTempoEditing) {
    return;
  }
  event.preventDefault();
  state.drag.active = true;
  state.drag.didDrag = false;
  state.drag.pointerId = event.pointerId;
  state.drag.startX = event.clientX;
  state.drag.startY = event.clientY;
  state.drag.startBpm = state.pendingBpm ?? state.currentBpm;
  state.previewBpm = state.drag.startBpm;
  updateTempoText();
  tempoControl.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
    return;
  }
  const deltaX = event.clientX - state.drag.startX;
  const deltaY = event.clientY - state.drag.startY;
  if (
    !state.drag.didDrag &&
    Math.hypot(deltaX, deltaY) < TAP_DRAG_THRESHOLD_PX
  ) {
    return;
  }
  state.drag.didDrag = true;
  const preview = clamp(state.drag.startBpm + deltaX * 0.35, MIN_BPM, MAX_BPM);
  state.previewBpm = Math.round(preview);
  updateTempoText();
}

function finishDrag(event, reason) {
  if (!state.drag.active) {
    return;
  }
  if (event.pointerId !== state.drag.pointerId) {
    return;
  }
  const shouldOpenEditor = !state.drag.didDrag && reason === "up";
  if (state.drag.didDrag) {
    queueTempoChange(state.previewBpm ?? state.currentBpm);
  }
  state.previewBpm = null;
  state.drag.active = false;
  state.drag.didDrag = false;
  state.drag.pointerId = null;
  updateTempoText();
  if (shouldOpenEditor) {
    beginTempoEditing();
  }
}

function handleTempoInputKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    finishTempoEditing(true);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    finishTempoEditing(false);
  }
}

function initTempoDrag() {
  tempoControl.addEventListener("pointerdown", handlePointerDown);
  tempoControl.addEventListener("pointermove", handlePointerMove);
  tempoControl.addEventListener("pointerup", (event) => finishDrag(event, "up"));
  tempoControl.addEventListener("pointercancel", (event) =>
    finishDrag(event, "cancel")
  );
  tempoControl.addEventListener("lostpointercapture", (event) =>
    finishDrag(event, "lost")
  );
  tempoControl.addEventListener("keydown", (event) => {
    if (state.isTempoEditing) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      beginTempoEditing();
    }
  });
  bpmInput.addEventListener("keydown", handleTempoInputKeydown);
  bpmInput.addEventListener("blur", () => finishTempoEditing(true));
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
