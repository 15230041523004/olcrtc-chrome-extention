/**
 * Dynamic Icon Theme Engine for olcRTC Extension.
 *
 * Implements 3 customizable visual themes across 5 connection states:
 * 1. "wormhole" (Червоточина — Sci-Fi Portal)
 * 2. "optics"   (Оптика — Transparent Prism + Dynamic Badge)
 * 3. "radar"    (Локатор — Research Sonar)
 *
 * States:
 * - 'disconnected': Tunnel inactive
 * - 'connecting':   Handshake / WebRTC negotiation in progress
 * - 'connected':    Tunnel established and idle
 * - 'active':       Active in-flight traffic / high throughput
 * - 'error':        Connection failure / broken transport
 */

export const ICON_THEMES = Object.freeze(['wormhole', 'optics', 'radar']);
export const DEFAULT_ICON_THEME = 'wormhole';

export const ICON_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'active',
  'error',
]);

/**
 * Resolve high-level icon state from background tunnel state.
 * @param {object} publicState
 * @returns {{ state: string, inFlight: number, loadPercent: number, frame: number, flagCount: number, progress: number }}
 */
export function resolveIconState(publicState, frame = 0) {
  const status = publicState?.status || 'idle';
  const flags = publicState?.flags || {};
  const stats = publicState?.interceptStats || {};
  const inFlight = stats.inflightCount || (flags.intercept ? 1 : 0);
  const throughput = (flags.transformIn || 0) + (flags.transformOut || 0);

  const flagKeys = [
    'authOk', 'wsOpen', 'helloSent', 'serverHello', 'subConnected',
    'pubConnected', 'senderTransform', 'remoteVp8', 'tokenOk', 'handshakeOk',
    'pingOk', 'intercept', 'blockWebrtc'
  ];
  let flagCount = 0;
  for (const k of flagKeys) {
    if (flags[k]) flagCount++;
  }

  let state = 'disconnected';

  if (status === 'error' || flags.interceptLost) {
    state = 'error';
  } else if (status === 'connecting') {
    state = 'connecting';
  } else if (status === 'connected' && flags.handshakeOk) {
    if (inFlight > 0) {
      state = 'active';
    } else {
      state = 'connected';
    }
  } else if (status === 'connected') {
    state = 'connecting';
  } else {
    state = 'disconnected';
  }

  // Progress 0..1 based on real active flags (deterministic, no looping spin)
  const flagProgress = flagKeys.length > 0 ? flagCount / flagKeys.length : 0;
  const progress = state === 'connecting'
    ? Math.max(0.1, flagProgress)
    : (state === 'connected' || state === 'active') ? 1.0 : 0;

  // Compute estimated load percentage (0 - 100%) for active traffic
  const loadPercent = Math.min(100, Math.max(5, Math.round(inFlight * 22 + (throughput % 100) * 0.3)));

  return { state, inFlight, loadPercent, frame, flagCount, progress };
}

/**
 * Compute badge text and background color for a theme and state.
 * @param {string} theme
 * @param {string} state
 * @param {{ inFlight?: number, loadPercent?: number, showThroughput?: boolean, speedMbps?: number }} [options]
 * @returns {{ text: string, color: string }}
 */
export function getThemeBadge(theme, state, options = {}) {
  const showThroughput = Boolean(options.showThroughput);
  const inFlight = options.inFlight || 0;
  const load = options.loadPercent || 0;
  const speedMbps = typeof options.speedMbps === 'number' ? options.speedMbps : 0;

  if (state === 'error') {
    if (theme === 'optics') {
      return { text: '!', color: '#dc2626' };
    }
    return { text: '', color: '#00000000' };
  }

  // Real-time throughput speed badge in Mbps (when enabled by user)
  if (showThroughput) {
    if (state === 'connected' || state === 'active') {
      if (speedMbps <= 0.05 && inFlight === 0) {
        return { text: '', color: '#00000000' };
      }
      let text = '0M';
      if (speedMbps < 0.1) {
        text = '0.1M';
      } else if (speedMbps < 10) {
        text = `${speedMbps.toFixed(1)}M`;
      } else if (speedMbps < 1000) {
        text = `${Math.round(speedMbps)}M`;
      } else {
        text = `${(speedMbps / 1000).toFixed(1)}G`;
      }
      const color = speedMbps > 50 ? '#ef4444' : speedMbps > 10 ? '#f59e0b' : '#10b981';
      return { text, color };
    }
  }

  // Optics theme default load percentage badge
  if (theme === 'optics') {
    if (state === 'active' && inFlight > 0) {
      const text = inFlight > 9 ? `${inFlight}` : `${load}%`;
      const color = load > 75 ? '#ef4444' : load > 40 ? '#f59e0b' : '#10b981';
      return { text, color };
    }
  }

  return { text: '', color: '#00000000' };
}

/**
 * Render an icon for a specific theme, state, and pixel dimension.
 * Uses OffscreenCanvas where available or an internal pixel buffer in pure JS.
 * @param {string} theme
 * @param {string} state
 * @param {number} size (16, 32, 48, 128)
 * @param {{ frame?: number, loadPercent?: number, progress?: number }} [options]
 * @returns {ImageData|object}
 */
export function renderIcon(theme, state, size = 32, options = {}) {
  const validTheme = ICON_THEMES.includes(theme) ? theme : DEFAULT_ICON_THEME;
  const validState = ICON_STATES.includes(state) ? state : 'disconnected';
  const frame = options.frame || 0;
  const load = options.loadPercent || 50;
  const progress = typeof options.progress === 'number' ? options.progress : 0;

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    if (validTheme === 'wormhole') {
      drawWormhole(ctx, validState, size, frame, load, progress);
    } else if (validTheme === 'optics') {
      drawOptics(ctx, validState, size, frame, load);
    } else if (validTheme === 'radar') {
      drawRadar(ctx, validState, size, frame, load);
    }

    return ctx.getImageData(0, 0, size, size);
  }

  // Pure JS fallback ImageData object for headless test runners
  return createMockImageData(size, validTheme, validState);
}

/**
 * Generate dictionary of ImageData for standard Chrome action icon sizes (16, 32).
 * @param {string} theme
 * @param {string} state
 * @param {object} [options]
 * @returns {{ 16: ImageData, 32: ImageData }}
 */
export function generateIconData(theme, state, options = {}) {
  return {
    16: renderIcon(theme, state, 16, options),
    32: renderIcon(theme, state, 32, options),
  };
}

/* -------------------------------------------------------------------------- */
/* Theme 1: Wormhole (Оптическая Диафрагма / Оптоволокно)                     */
/* -------------------------------------------------------------------------- */

function drawWormhole(ctx, state, size, frame, load, progress = 0) {
  const center = size / 2;
  const outerR = size * 0.46;
  const rimR = size * 0.38;
  const housingR = size * 0.34;
  const numBlades = 8;
  const numNotches = 16;

  // Aperture radius based on state and progress
  let coreR;
  if (state === 'disconnected') {
    coreR = size * 0.12; // Closed aperture
  } else if (state === 'connecting') {
    const norm = Math.max(0.1, Math.min(1.0, progress));
    coreR = size * 0.12 + (size * 0.25 - size * 0.12) * norm; // Opening aperture
  } else {
    coreR = size * 0.25; // Fully open aperture
  }

  const activeBlades = (state === 'connected' || state === 'active')
    ? numBlades
    : state === 'disconnected'
      ? 0
      : Math.max(1, Math.min(numBlades, Math.round(progress * numBlades)));

  // 1. Outer Notched Bezel Ring (16 gear notches)
  ctx.save();
  for (let i = 0; i < numNotches; i++) {
    const a1 = (i * Math.PI * 2) / numNotches;
    const a2 = ((i + 0.65) * Math.PI * 2) / numNotches;
    const a3 = ((i + 1) * Math.PI * 2) / numNotches;

    // Notch tooth
    ctx.beginPath();
    ctx.arc(center, center, outerR, a1, a2);
    ctx.arc(center, center, rimR, a2, a1, true);
    ctx.closePath();

    if (state === 'disconnected') {
      ctx.fillStyle = '#475569'; // Pleasant slate-steel (not pitch black)
    } else if (state === 'error') {
      ctx.fillStyle = '#ef4444';
    } else {
      ctx.fillStyle = '#7dd3fc'; // Vibrant sky cyan notch
    }
    ctx.fill();

    // Notch gap
    ctx.beginPath();
    ctx.arc(center, center, outerR * 0.95, a2, a3);
    ctx.arc(center, center, rimR, a3, a2, true);
    ctx.closePath();

    if (state === 'disconnected') {
      ctx.fillStyle = '#334155';
    } else if (state === 'error') {
      ctx.fillStyle = '#991b1b';
    } else {
      ctx.fillStyle = '#38bdf8'; // Electric cyan
    }
    ctx.fill();
  }
  ctx.restore();

  // 2. Bezel Groove Ring (Between rimR and housingR)
  ctx.fillStyle = state === 'error' ? '#450a0a' : state === 'disconnected' ? '#1e293b' : '#0f172a';
  ctx.beginPath();
  ctx.arc(center, center, rimR, 0, Math.PI * 2);
  ctx.arc(center, center, housingR, 0, Math.PI * 2, true);
  ctx.fill();

  ctx.strokeStyle = state === 'error' ? '#ef4444' : state === 'disconnected' ? '#64748b' : '#0284c7';
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.beginPath();
  ctx.arc(center, center, housingR, 0, Math.PI * 2);
  ctx.stroke();

  // 3. Diaphragm Iris Blades (Fixed radial orientation, NO ROTATION)
  ctx.save();
  for (let i = 0; i < numBlades; i++) {
    const aStart = -Math.PI / 2 + (i * Math.PI * 2) / numBlades;
    const aEnd = -Math.PI / 2 + ((i + 1) * Math.PI * 2) / numBlades;
    const tilt = 0.35 * (1 - (coreR / (size * 0.25)) * 0.5);

    // Diaphragm blade polygon
    ctx.beginPath();
    ctx.arc(center, center, housingR, aStart, aEnd);
    ctx.lineTo(center + Math.cos(aEnd + tilt) * coreR, center + Math.sin(aEnd + tilt) * coreR);
    ctx.arc(center, center, coreR, aEnd + tilt, aStart + tilt, true);
    ctx.closePath();

    const isBladeActive = i < activeBlades;
    if (state === 'disconnected') {
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#475569';
    } else if (state === 'error') {
      ctx.fillStyle = '#7f1d1d';
      ctx.strokeStyle = '#ef4444';
    } else if (isBladeActive) {
      if (i === activeBlades - 1 && state === 'connecting') {
        ctx.fillStyle = '#0ea5e9';
        ctx.strokeStyle = '#34d399'; // Leading blade accent
      } else {
        ctx.fillStyle = '#0369a1';
        ctx.strokeStyle = '#38bdf8';
      }
    } else {
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#334155';
    }
    ctx.lineWidth = Math.max(0.8, size * 0.03);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // 4. Central Optical Core (Inside coreR)
  if (state === 'disconnected') {
    // Soft dim blue standby core (not dark black)
    const dimCore = ctx.createRadialGradient(center, center, 0, center, center, coreR);
    dimCore.addColorStop(0, '#2563eb');
    dimCore.addColorStop(0.65, '#1d4ed8');
    dimCore.addColorStop(1, '#0f172a');
    ctx.fillStyle = dimCore;
    ctx.beginPath();
    ctx.arc(center, center, coreR, 0, Math.PI * 2);
    ctx.fill();
  } else if (state === 'error') {
    const errCore = ctx.createRadialGradient(center, center, 0, center, center, coreR);
    errCore.addColorStop(0, '#fca5a5');
    errCore.addColorStop(0.5, '#ef4444');
    errCore.addColorStop(1, '#7f1d1d');
    ctx.fillStyle = errCore;
    ctx.beginPath();
    ctx.arc(center, center, coreR, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Radiant laser beam matching the official icon
    const laserBeam = ctx.createRadialGradient(center, center, 0, center, center, coreR);
    laserBeam.addColorStop(0, '#ffffff');    // Brilliant focal spot
    laserBeam.addColorStop(0.3, '#7dd3fc');  // Sky cyan
    laserBeam.addColorStop(0.65, '#38bdf8'); // Electric cyan
    laserBeam.addColorStop(1, '#0284c7');    // Optical azure
    ctx.fillStyle = laserBeam;
    ctx.beginPath();
    ctx.arc(center, center, coreR, 0, Math.PI * 2);
    ctx.fill();

    if (state === 'connected' || state === 'active') {
      // Concentric refractive inner ring
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = Math.max(0.8, size * 0.03);
      ctx.beginPath();
      ctx.arc(center, center, coreR * 0.55, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.beginPath();
      ctx.arc(center, center, coreR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Theme 2: Optics (Оптика — Transparent Prism + Refracted Beam)             */
/* -------------------------------------------------------------------------- */

function drawOptics(ctx, state, size, frame, load) {
  const p1 = [size * 0.5, size * 0.15];   // Top apex
  const p2 = [size * 0.18, size * 0.82];  // Bottom left
  const p3 = [size * 0.82, size * 0.82];  // Bottom right

  if (state === 'disconnected') {
    // Matte frosted gray prism without light beam
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = Math.max(1.5, size * 0.08);
    ctx.stroke();
    return;
  }

  if (state === 'connecting') {
    // Prism with pulsed dashed entry beam
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = Math.max(1.5, size * 0.08);
    ctx.stroke();

    // Entry laser beam
    const offset = (frame % 4) * 2;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineDashOffset = -offset;
    ctx.strokeStyle = '#67e8f9';
    ctx.lineWidth = Math.max(1.5, size * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, size * 0.65);
    ctx.lineTo(size * 0.45, size * 0.52);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (state === 'error') {
    // Red fractured prism
    ctx.fillStyle = '#450a0a';
    ctx.beginPath();
    ctx.moveTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.lineTo(p3[0], p3[1]);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.stroke();

    // Crack line
    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.25);
    ctx.lineTo(size * 0.42, size * 0.55);
    ctx.lineTo(size * 0.6, size * 0.82);
    ctx.stroke();
    return;
  }

  // Connected / Active Traffic: Glass prism with refracted multi-spectral beam
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.beginPath();
  ctx.moveTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.lineTo(p3[0], p3[1]);
  ctx.closePath();
  ctx.fill();

  // Prism glass gradient
  const prismGrad = ctx.createLinearGradient(p1[0], p1[1], p3[0], p3[1]);
  prismGrad.addColorStop(0, 'rgba(56, 189, 248, 0.4)');
  prismGrad.addColorStop(1, 'rgba(147, 51, 234, 0.4)');
  ctx.fillStyle = prismGrad;
  ctx.fill();

  // Outer prism border
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = Math.max(1.5, size * 0.08);
  ctx.stroke();

  // White incoming beam from left
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, size * 0.09);
  ctx.beginPath();
  ctx.moveTo(0, size * 0.62);
  ctx.lineTo(size * 0.42, size * 0.54);
  ctx.stroke();

  // Refracted outgoing spectral beams (Cyan, Green, Violet)
  const beams = [
    { color: '#38bdf8', yEnd: size * 0.35 },
    { color: '#10b981', yEnd: size * 0.52 },
    { color: '#a855f7', yEnd: size * 0.68 },
  ];

  for (const b of beams) {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = Math.max(1.2, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(size * 0.42, size * 0.54);
    ctx.lineTo(size, b.yEnd);
    ctx.stroke();
  }
}

/* -------------------------------------------------------------------------- */
/* Theme 3: Radar (Локатор — Research Sonar)                                 */
/* -------------------------------------------------------------------------- */

function drawRadar(ctx, state, size, frame, load) {
  const center = size / 2;
  const radius = size * 0.44;

  // Outer sonar bezel
  ctx.fillStyle = '#09151f';
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = state === 'error' ? '#ef4444' : state === 'disconnected' ? '#334155' : '#059669';
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.stroke();

  if (state === 'disconnected') {
    // Static dark sonar grid with dim center blip
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.5, 0, Math.PI * 2);
    ctx.moveTo(center, center - radius);
    ctx.lineTo(center, center + radius);
    ctx.moveTo(center - radius, center);
    ctx.lineTo(center + radius, center);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.beginPath();
    ctx.arc(center, center, Math.max(1.5, size * 0.08), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (state === 'connecting') {
    // Concentric expanding sonar pulse arcs
    const pulseStep = (frame % 3) / 3;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1;

    for (let r = 0.3; r <= 0.9; r += 0.3) {
      ctx.beginPath();
      ctx.arc(center, center, radius * ((r + pulseStep) % 1), 0, Math.PI * 2);
      ctx.stroke();
    }
    return;
  }

  if (state === 'error') {
    // Red alert crosshair sonar
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(center, center, radius * 0.55, 0, Math.PI * 2);
    ctx.moveTo(center, center - radius * 0.8);
    ctx.lineTo(center, center + radius * 0.8);
    ctx.moveTo(center - radius * 0.8, center);
    ctx.lineTo(center + radius * 0.8, center);
    ctx.stroke();

    ctx.fillStyle = '#f87171';
    ctx.beginPath();
    ctx.arc(center, center, Math.max(2, size * 0.1), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Connected / Active Traffic: Sonar grid with rotating sweep or locked green target
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.5, 0, Math.PI * 2);
  ctx.moveTo(center, center - radius);
  ctx.lineTo(center, center + radius);
  ctx.moveTo(center - radius, center);
  ctx.lineTo(center + radius, center);
  ctx.stroke();

  // Target locked blip at (X: 65%, Y: 35%)
  const targetX = center + radius * 0.35;
  const targetY = center - radius * 0.35;

  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.arc(targetX, targetY, Math.max(2, size * 0.09), 0, Math.PI * 2);
  ctx.fill();

  if (state === 'active') {
    // Signal level bars on the bottom left
    const barWidth = Math.max(2, size * 0.07);
    const bars = Math.min(4, Math.max(1, Math.ceil((load / 100) * 4)));
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < bars ? '#10b981' : 'rgba(16, 185, 129, 0.2)';
      const h = (i + 1) * (size * 0.08);
      ctx.fillRect(center - radius * 0.7 + i * (barWidth + 2), center + radius * 0.6 - h, barWidth, h);
    }
  } else {
    // Subtle sweep beam
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();
  }
}

/* -------------------------------------------------------------------------- */
/* Mock ImageData for Test Environments                                      */
/* -------------------------------------------------------------------------- */

function createMockImageData(size, theme, state) {
  const data = new Uint8ClampedArray(size * size * 4);
  // Fill with dummy deterministic bytes for testing
  for (let i = 0; i < data.length; i += 4) {
    data[i] = theme === 'wormhole' ? 139 : theme === 'optics' ? 6 : 16;
    data[i + 1] = state === 'error' ? 0 : 185;
    data[i + 2] = state === 'error' ? 0 : 212;
    data[i + 3] = state === 'disconnected' ? 100 : 255;
  }
  return { width: size, height: size, data };
}

