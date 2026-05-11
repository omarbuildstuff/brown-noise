// Stillness — audio engine, UI logic, PWA glue.
//
// Audio graph:  brown-noise worklet → highpass(20Hz) → lowpass(1500Hz) → master gain → output
// The noise is generated continuously; play/pause is implemented as a fade
// on the master gain, never by stopping the source — so the next play() is
// instant and click-free.

// ---------- DOM refs ----------
const body          = document.body;
const toggleBtn     = document.getElementById('toggle');
const volumeInput   = document.getElementById('volume');
const installBtn    = document.getElementById('install');
const pillEls       = Array.from(document.querySelectorAll('.pill'));
const remainingEl   = document.getElementById('timer-remaining');

// ---------- Constants ----------
const FADE_IN_MS      = 800;
const FADE_OUT_MS     = 400;
const TIMER_FADE_MS   = 30_000;   // graceful 30s fade-out when sleep timer expires
const IDLE_MS         = 4000;     // controls dim after this much pointer/key inactivity
const SILENT_GAIN     = 0.0001;   // exponentialRampToValueAtTime rejects 0
const STORAGE_VOL     = 'stillness:volume';
const STORAGE_TIMER   = 'stillness:timer';

// ---------- State ----------
let ctx          = null;
let graphBuilt   = false;
let noiseNode    = null;
let masterGain   = null;
let playing      = false;
let wakeLock     = null;
let timerTimeoutId  = null;
let timerFadeTimeoutId = null;
let timerEndAt   = 0;
let timerIntervalId = null;
let deferredInstall = null;

// Logarithmic-feeling volume curve. Power 2.5 keeps the low end fine-grained
// (so 5–40% feels like a real range) without ever getting too hot at 100%.
const volumeFromSlider = (pct) => {
  const x = Math.max(0, Math.min(100, Number(pct))) / 100;
  return Math.pow(x, 2.5);
};

// Restore last volume (or 40% default).
{
  const stored = parseFloat(localStorage.getItem(STORAGE_VOL));
  volumeInput.value = Number.isFinite(stored) ? stored : 40;
}

// ---------- Audio engine ----------
//
// Splitting "unlock the context" from "build the graph" matters: Chrome's
// autoplay policy only accepts a resume() call that happens synchronously
// inside the user-gesture task. The `await audioWorklet.addModule()` later
// in buildGraph() can spend that gesture token, so we unlock the context
// during the first pointerdown/keydown (no awaits) and only build the
// graph when the user actually presses play.

function unlockCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC({ latencyHint: 'playback' });
  }
  // Fire-and-forget — resume must be called in-gesture but doesn't need awaiting.
  ctx.resume?.().catch(() => {});
}

async function buildGraph() {
  if (graphBuilt) return;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });
  }

  await ctx.audioWorklet.addModule('./noise-worklet.js');
  noiseNode = new AudioWorkletNode(ctx, 'brown-noise', {
    // Force mono output — without this, some browsers leave channel 1
    // unwritten (we only fill outputs[0][0]) and the signal is silent on
    // the right side of a stereo destination.
    outputChannelCount: [1],
  });

  // Subsonic rumble removal — brown noise integrates DC drift, the highpass
  // at 20 Hz keeps the speakers from wasting cone excursion below audible.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 20;
  hp.Q.value = 0.7;

  // Cascade two lowpass biquads at 500 Hz for a steep ~-24 dB/oct shoulder
  // above 500 Hz. Combined with brown noise's native -6 dB/oct slope this
  // gives a deep, warm waterfall with negligible high-frequency hiss.
  const lp1 = ctx.createBiquadFilter();
  lp1.type = 'lowpass';
  lp1.frequency.value = 500;
  lp1.Q.value = 0.7;

  const lp2 = ctx.createBiquadFilter();
  lp2.type = 'lowpass';
  lp2.frequency.value = 500;
  lp2.Q.value = 0.7;

  masterGain = ctx.createGain();
  masterGain.gain.value = SILENT_GAIN;

  noiseNode.connect(hp).connect(lp1).connect(lp2).connect(masterGain).connect(ctx.destination);
  graphBuilt = true;
}

async function ensureAudio() {
  unlockCtx();                       // safe to call repeatedly
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
  await buildGraph();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch {}
  }
}

// Capture the very first user gesture to unlock the context, well before
// the worklet finishes loading.
['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
  window.addEventListener(ev, unlockCtx, { once: true, passive: true, capture: true })
);

// Cancel pending automation and pin the current value before scheduling a
// new ramp — without this, overlapping ramps glitch on rapid toggles.
function rampGain(target, durationMs) {
  if (!ctx || !masterGain) return;
  const t  = ctx.currentTime;
  const cur = Math.max(SILENT_GAIN, masterGain.gain.value);
  masterGain.gain.cancelScheduledValues(t);
  masterGain.gain.setValueAtTime(cur, t);
  masterGain.gain.exponentialRampToValueAtTime(
    Math.max(SILENT_GAIN, target),
    t + durationMs / 1000
  );
}

async function play() {
  await ensureAudio();
  rampGain(volumeFromSlider(volumeInput.value), FADE_IN_MS);
  setPlaying(true);
  acquireWakeLock();
}

function pause() {
  rampGain(SILENT_GAIN, FADE_OUT_MS);
  setPlaying(false);
  releaseWakeLock();
}

function toggle() {
  if (playing) pause();
  else play();
}

function setPlaying(next) {
  playing = next;
  body.dataset.playing = String(next);
  toggleBtn.setAttribute('aria-pressed', String(next));
  toggleBtn.setAttribute('aria-label', next ? 'Pause brown noise' : 'Play brown noise');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = next ? 'playing' : 'paused';
  }
}

// ---------- Volume ----------
function applyVolume() {
  localStorage.setItem(STORAGE_VOL, volumeInput.value);
  if (!playing) return;                    // don't ramp up muted audio
  rampGain(volumeFromSlider(volumeInput.value), 120);
}
volumeInput.addEventListener('input', applyVolume);

function nudgeVolume(delta) {
  const next = Math.max(0, Math.min(100, Number(volumeInput.value) + delta));
  volumeInput.value = next;
  applyVolume();
}

// ---------- Sleep timer ----------
function clearTimer({ updatePills = true } = {}) {
  if (timerTimeoutId)     clearTimeout(timerTimeoutId);
  if (timerFadeTimeoutId) clearTimeout(timerFadeTimeoutId);
  if (timerIntervalId)    clearInterval(timerIntervalId);
  timerTimeoutId = timerFadeTimeoutId = timerIntervalId = null;
  timerEndAt = 0;
  remainingEl.textContent = '';
  if (updatePills) {
    pillEls.forEach((p) =>
      p.setAttribute('aria-pressed', String(Number(p.dataset.minutes) === 0))
    );
  }
}

function setTimer(minutes) {
  clearTimer({ updatePills: false });
  pillEls.forEach((p) =>
    p.setAttribute('aria-pressed', String(Number(p.dataset.minutes) === minutes))
  );
  localStorage.setItem(STORAGE_TIMER, String(minutes));
  if (!minutes) return;

  timerEndAt = Date.now() + minutes * 60_000;
  timerTimeoutId = setTimeout(onTimerExpire, minutes * 60_000);
  tickTimerLabel();
  timerIntervalId = setInterval(tickTimerLabel, 1000);
}

function onTimerExpire() {
  if (!playing) {
    clearTimer();
    return;
  }
  // Graceful 30-second fade-out, then a hard pause to release the wake lock.
  rampGain(SILENT_GAIN, TIMER_FADE_MS);
  timerFadeTimeoutId = setTimeout(() => {
    setPlaying(false);
    releaseWakeLock();
    clearTimer();
  }, TIMER_FADE_MS);
}

function tickTimerLabel() {
  if (!timerEndAt) { remainingEl.textContent = ''; return; }
  const remaining = Math.max(0, timerEndAt - Date.now());
  const m = Math.floor(remaining / 60_000);
  const s = Math.floor((remaining % 60_000) / 1000);
  remainingEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

pillEls.forEach((p) =>
  p.addEventListener('click', () => setTimer(Number(p.dataset.minutes)))
);

// ---------- Wake Lock ----------
// Best-effort: Safari, embedded WebViews, and some Android browsers reject
// or omit the API entirely. The catch makes that a silent fallback.
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener?.('release', () => { wakeLock = null; });
  } catch { /* permission denied / unsupported — ignore */ }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing && !wakeLock) {
    acquireWakeLock();
  }
});

// ---------- Media Session (lock screen / Bluetooth controls) ----------
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  'Brown Noise',
      artist: 'Stillness',
      album:  'Continuous',
    });
    navigator.mediaSession.setActionHandler('play',  play);
    navigator.mediaSession.setActionHandler('pause', pause);
    navigator.mediaSession.setActionHandler('stop',  pause);
  } catch { /* older browsers — fine to ignore */ }
}

// ---------- Input handlers ----------
toggleBtn.addEventListener('click', toggle);

window.addEventListener('keydown', (e) => {
  // Don't hijack arrow keys when the user is interacting with the slider.
  if (e.target instanceof HTMLInputElement) return;

  if (e.code === 'Space') {
    e.preventDefault();
    toggle();
  } else if (e.code === 'ArrowUp' || e.code === 'ArrowRight') {
    e.preventDefault();
    nudgeVolume(+5);
  } else if (e.code === 'ArrowDown' || e.code === 'ArrowLeft') {
    e.preventDefault();
    nudgeVolume(-5);
  }
});

// ---------- Inactivity fade ----------
let idleTimer = null;
function bumpIdle() {
  body.dataset.idle = 'false';
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { body.dataset.idle = 'true'; }, IDLE_MS);
}
['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
  window.addEventListener(ev, bumpIdle, { passive: true })
);
bumpIdle();

// ---------- Install prompt ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.dataset.visible = 'true';
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) {
    installBtn.dataset.visible = 'false';
    return;
  }
  installBtn.dataset.visible = 'false';
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch {}
  deferredInstall = null;
});
window.addEventListener('appinstalled', () => {
  installBtn.dataset.visible = 'false';
  deferredInstall = null;
});

// ---------- Service worker registration ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
