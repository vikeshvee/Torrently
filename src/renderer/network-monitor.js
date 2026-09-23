const { ipcRenderer } = require('electron');

// State Variables
let historyData = []; // Array of { t, down, up }
let currentSnapshot = null;
let currentUnit = 'bytes'; // 'bytes' (KB/s, MB/s) or 'bits' (kbps, Mbps)
let viewWindowSeconds = 300; // 5 minutes default
let isFollowingLive = true;
let viewEndTimestamp = Date.now(); // Right edge timestamp of view window
let isStatusBarActive = false;

// DOM Elements
const canvas = document.getElementById('speed-canvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvas-container');
const tooltip = document.getElementById('chart-tooltip');
const tooltipTime = document.getElementById('tooltip-time');
const tooltipDl = document.getElementById('tooltip-dl');
const tooltipUl = document.getElementById('tooltip-ul');
const tooltipTotal = document.getElementById('tooltip-total');

const valDlSpeed = document.getElementById('val-dl-speed');
const valDlSub = document.getElementById('val-dl-sub');
const valUlSpeed = document.getElementById('val-ul-speed');
const valUlSub = document.getElementById('val-ul-sub');
const valTotSpeed = document.getElementById('val-tot-speed');
const valTotSub = document.getElementById('val-tot-sub');
const valPeakSpeed = document.getElementById('val-peak-speed');
const valPeakSub = document.getElementById('val-peak-sub');

const btnUnitBytes = document.getElementById('btn-unit-bytes');
const btnUnitBits = document.getElementById('btn-unit-bits');
const legendDlUnit = document.getElementById('legend-dl-unit');
const legendUlUnit = document.getElementById('legend-ul-unit');

const btnFollowLive = document.getElementById('btn-follow-live');
const followBtnText = document.getElementById('follow-btn-text');
const btnJumpLive = document.getElementById('btn-jump-live');
const chartStatusInfo = document.getElementById('chart-status-info');

const timelineSlider = document.getElementById('timeline-slider');
const scrubStartTime = document.getElementById('scrub-start-time');
const scrubEndTime = document.getElementById('scrub-end-time');

const dataPointsCount = document.getElementById('data-points-count');
const totalSessionTransferred = document.getElementById('total-session-transferred');

const btnToggleStatusBar = document.getElementById('btn-toggle-status-bar');
const statusBarBtnText = document.getElementById('status-bar-btn-text');
const btnExport = document.getElementById('btn-export');
const btnClear = document.getElementById('btn-clear');

// Mouse Interaction State
let isDragging = false;
let dragStartX = 0;
let dragStartEndTimestamp = 0;
let hoverIndex = -1;
let hoverCoord = null;

// Helpers: Speed Formatting
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 KB/s';
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
}

function formatBits(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0.00 Mbps';
  const bits = bytes * 8;
  if (bits < 1000) return `${Math.round(bits)} bps`;
  if (bits < 1000 * 1000) return `${(bits / 1000).toFixed(1)} kbps`;
  if (bits < 1000 * 1000 * 1000) return `${(bits / (1000 * 1000)).toFixed(2)} Mbps`;
  return `${(bits / (1000 * 1000 * 1000)).toFixed(2)} Gbps`;
}

function formatSpeedForUnit(bytes, unit = currentUnit) {
  return unit === 'bits' ? formatBits(bytes) : formatBytes(bytes);
}

function formatTime(timestamp, includeSeconds = true) {
  const d = new Date(timestamp);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  if (!includeSeconds) return `${h}:${m}`;
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + formatTime(timestamp, false);
}

// Resize Canvas Handling for Retina/HiDPI
function resizeCanvas() {
  const rect = container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(200, Math.floor(rect.width * dpr));
  canvas.height = Math.max(120, Math.floor(rect.height * dpr));
  ctx.scale(dpr, dpr);
  renderGraph();
}

window.addEventListener('resize', resizeCanvas);

// Update Top KPI Cards
function updateKpiCards(snapshot) {
  if (!snapshot) return;
  const curr = snapshot.current || { down: 0, up: 0, total: 0 };
  const peak = snapshot.peak || { down: 0, up: 0, total: 0 };

  if (currentUnit === 'bytes') {
    valDlSpeed.textContent = formatBytes(curr.down);
    valDlSub.textContent = formatBits(curr.down);
    valUlSpeed.textContent = formatBytes(curr.up);
    valUlSub.textContent = formatBits(curr.up);
    valTotSpeed.textContent = formatBytes(curr.total);
    valTotSub.textContent = formatBits(curr.total);
    valPeakSpeed.textContent = formatBytes(peak.total);
    valPeakSub.textContent = formatBits(peak.total);
  } else {
    valDlSpeed.textContent = formatBits(curr.down);
    valDlSub.textContent = formatBytes(curr.down);
    valUlSpeed.textContent = formatBits(curr.up);
    valUlSub.textContent = formatBytes(curr.up);
    valTotSpeed.textContent = formatBits(curr.total);
    valTotSub.textContent = formatBytes(curr.total);
    valPeakSpeed.textContent = formatBits(peak.total);
    valPeakSub.textContent = formatBytes(peak.total);
  }

  if (dataPointsCount) {
    dataPointsCount.textContent = `${historyData.length} recorded samples`;
  }

  if (totalSessionTransferred && snapshot.totalTransferred) {
    const downMb = (snapshot.totalTransferred.down / (1024 * 1024)).toFixed(1);
    const upMb = (snapshot.totalTransferred.up / (1024 * 1024)).toFixed(1);
    totalSessionTransferred.textContent = `Total: ${downMb} MB Down / ${upMb} MB Up`;
  }
}

// Timeline Scrubber Sync
function updateScrubber() {
  if (historyData.length === 0) return;
  const oldest = historyData[0].t;
  const newest = historyData[historyData.length - 1].t;
  const totalRange = Math.max(1000, newest - oldest);

  scrubStartTime.textContent = formatDate(oldest);
  scrubEndTime.textContent = isFollowingLive ? 'Now (Live)' : formatTime(newest);

  if (isFollowingLive) {
    timelineSlider.value = 1000;
  } else {
    const frac = Math.max(0, Math.min(1, (viewEndTimestamp - oldest) / totalRange));
    timelineSlider.value = Math.round(frac * 1000);
  }
}

// Chart Rendering Logic
function renderGraph() {
  const rect = container.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  if (!width || !height) return;

  const padLeft = 70;
  const padRight = 20;
  const padTop = 15;
  const padBottom = 26;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  if (chartW <= 0 || chartH <= 0) return;

  const now = Date.now();
  if (isFollowingLive) {
    viewEndTimestamp = now;
  }

  const effectiveWindowMs = viewWindowSeconds === 'all'
    ? Math.max(60000, (historyData.length > 0 ? (viewEndTimestamp - historyData[0].t) : 300000))
    : viewWindowSeconds * 1000;

  const viewStartTimestamp = viewEndTimestamp - effectiveWindowMs;

  // Filter visible points plus one point before/after for boundary interpolation
  const visible = [];
  for (let i = 0; i < historyData.length; i++) {
    const pt = historyData[i];
    if (pt.t >= viewStartTimestamp - 2000 && pt.t <= viewEndTimestamp + 2000) {
      visible.push(pt);
    }
  }

  // Determine Max Y value in current unit
  let maxRawBytes = 1024 * 10; // At least 10 KB/s floor
  for (const pt of visible) {
    if (pt.down > maxRawBytes) maxRawBytes = pt.down;
    if (pt.up > maxRawBytes) maxRawBytes = pt.up;
  }
  // 20% headroom
  const maxYBytes = maxRawBytes * 1.25;

  // Draw Horizontal Gridlines & Y-Axis Labels
  const gridRows = 4;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748B';
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= gridRows; i++) {
    const yValBytes = (maxYBytes / gridRows) * (gridRows - i);
    const y = padTop + (chartH / gridRows) * i;

    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + chartW, y);
    ctx.stroke();

    const labelText = formatSpeedForUnit(yValBytes, currentUnit);
    ctx.fillText(labelText, padLeft - 8, y);
  }

  // Draw Vertical Gridlines & X-Axis Time Labels
  const timeCols = Math.max(2, Math.floor(chartW / 110));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i <= timeCols; i++) {
    const t = viewStartTimestamp + (effectiveWindowMs / timeCols) * i;
    const x = padLeft + (chartW / timeCols) * i;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + chartH);
    ctx.stroke();

    const timeStr = effectiveWindowMs > 86400000 ? formatDate(t) : formatTime(t, effectiveWindowMs <= 3600000);
    ctx.fillText(timeStr, x, padTop + chartH + 8);
  }

  // Axis baseline
  ctx.beginPath();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.moveTo(padLeft, padTop + chartH);
  ctx.lineTo(padLeft + chartW, padTop + chartH);
  ctx.stroke();

  if (visible.length === 0) {
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.font = '13px sans-serif';
    ctx.fillText('Waiting for network traffic data...', padLeft + chartW / 2, padTop + chartH / 2);
    return;
  }

  // Coordinate mapper functions
  function getX(t) {
    const frac = (t - viewStartTimestamp) / effectiveWindowMs;
    return padLeft + Math.max(0, Math.min(chartW, frac * chartW));
  }

  function getY(bytes) {
    const frac = Math.max(0, Math.min(1, bytes / maxYBytes));
    return padTop + chartH - (frac * chartH);
  }

  // Function to draw series line and fill
  function drawSeries(key, strokeColor, fillColor) {
    if (visible.length < 1) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(getX(visible[0].t), getY(visible[0][key]));

    for (let i = 1; i < visible.length; i++) {
      const prev = visible[i - 1];
      const curr = visible[i];
      const xPrev = getX(prev.t);
      const yPrev = getY(prev[key]);
      const xCurr = getX(curr.t);
      const yCurr = getY(curr[key]);

      const cx = (xPrev + xCurr) / 2;
      ctx.bezierCurveTo(cx, yPrev, cx, yCurr, xCurr, yCurr);
    }

    // Stroke line
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Area Fill
    const lastX = getX(visible[visible.length - 1].t);
    const firstX = getX(visible[0].t);
    ctx.lineTo(lastX, padTop + chartH);
    ctx.lineTo(firstX, padTop + chartH);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH);
    grad.addColorStop(0, fillColor);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  // Draw Upload Series (emerald #10B981)
  drawSeries('up', '#10B981', 'rgba(16, 185, 129, 0.22)');

  // Draw Download Series (cyan #38BDF8)
  drawSeries('down', '#38BDF8', 'rgba(56, 189, 248, 0.26)');

  // Hover crosshair and inspection dot
  if (hoverCoord && hoverIndex >= 0 && hoverIndex < historyData.length) {
    const pt = historyData[hoverIndex];
    const ptX = getX(pt.t);

    if (ptX >= padLeft && ptX <= padLeft + chartW) {
      // Crosshair vertical line
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(ptX, padTop);
      ctx.lineTo(ptX, padTop + chartH);
      ctx.stroke();
      ctx.restore();

      // Download dot
      const dlY = getY(pt.down);
      ctx.beginPath();
      ctx.arc(ptX, dlY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#38BDF8';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Upload dot
      const ulY = getY(pt.up);
      ctx.beginPath();
      ctx.arc(ptX, ulY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#10B981';
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Update Status bar info label
  if (chartStatusInfo) {
    const rangeName = viewWindowSeconds === 'all'
      ? 'All Time'
      : (viewWindowSeconds < 3600 ? `${viewWindowSeconds / 60}m` : `${viewWindowSeconds / 3600}h`);
    if (isFollowingLive) {
      chartStatusInfo.textContent = `Live Auto-Follow (${rangeName})`;
    } else {
      chartStatusInfo.textContent = `Viewing History (${formatTime(viewStartTimestamp)} – ${formatTime(viewEndTimestamp)})`;
    }
  }
}

// Mouse and Touch Interaction Handlers
container.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragStartX = e.clientX;
  dragStartEndTimestamp = viewEndTimestamp;
  setFollowLive(false);
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

window.addEventListener('mousemove', (e) => {
  const rect = container.getBoundingClientRect();
  const padLeft = 70;
  const padRight = 20;
  const chartW = rect.width - padLeft - padRight;

  if (isDragging) {
    const deltaX = e.clientX - dragStartX;
    const effectiveWindowMs = viewWindowSeconds === 'all' ? 3600000 : viewWindowSeconds * 1000;
    const timeDelta = -(deltaX / chartW) * effectiveWindowMs;

    const oldest = historyData.length > 0 ? historyData[0].t : Date.now() - 3600000;
    const now = Date.now();

    viewEndTimestamp = Math.max(oldest + effectiveWindowMs, Math.min(now, dragStartEndTimestamp + timeDelta));
    if (viewEndTimestamp >= now - 1500) {
      setFollowLive(true);
    }
    updateScrubber();
    renderGraph();
    return;
  }

  // Hover detection
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (mouseX >= padLeft && mouseX <= padLeft + chartW && mouseY >= 10 && mouseY <= rect.height - 25) {
    const effectiveWindowMs = viewWindowSeconds === 'all'
      ? (historyData.length > 0 ? Math.max(60000, viewEndTimestamp - historyData[0].t) : 300000)
      : viewWindowSeconds * 1000;
    const viewStartTimestamp = viewEndTimestamp - effectiveWindowMs;
    const frac = (mouseX - padLeft) / chartW;
    const targetTimestamp = viewStartTimestamp + (frac * effectiveWindowMs);

    // Find nearest point
    let closestIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < historyData.length; i++) {
      const diff = Math.abs(historyData[i].t - targetTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    if (closestIdx >= 0 && minDiff < 10000) {
      hoverIndex = closestIdx;
      hoverCoord = { x: mouseX, y: mouseY };
      const pt = historyData[closestIdx];

      tooltip.style.display = 'block';
      tooltip.style.left = `${mouseX}px`;
      tooltip.style.top = `${mouseY}px`;

      tooltipTime.textContent = formatDate(pt.t);
      tooltipDl.textContent = `${formatBytes(pt.down)} (${formatBits(pt.down)})`;
      tooltipUl.textContent = `${formatBytes(pt.up)} (${formatBits(pt.up)})`;
      const tot = pt.down + pt.up;
      tooltipTotal.textContent = `${formatBytes(tot)} (${formatBits(tot)})`;

      renderGraph();
      return;
    }
  }

  if (hoverIndex !== -1) {
    hoverIndex = -1;
    hoverCoord = null;
    tooltip.style.display = 'none';
    renderGraph();
  }
});

container.addEventListener('mouseleave', () => {
  hoverIndex = -1;
  hoverCoord = null;
  tooltip.style.display = 'none';
  renderGraph();
});

// Wheel / Trackpad horizontal scroll to browse history
container.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const effectiveWindowMs = viewWindowSeconds === 'all' ? 3600000 : viewWindowSeconds * 1000;
  const shiftMs = (delta * (effectiveWindowMs / 1000)) * 0.4;

  const oldest = historyData.length > 0 ? historyData[0].t : Date.now() - 3600000;
  const now = Date.now();

  viewEndTimestamp = Math.max(oldest + effectiveWindowMs, Math.min(now, viewEndTimestamp + shiftMs));

  if (viewEndTimestamp >= now - 1500) {
    setFollowLive(true);
  } else {
    setFollowLive(false);
  }

  updateScrubber();
  renderGraph();
}, { passive: false });

// Timeline Slider Event
timelineSlider.addEventListener('input', () => {
  const val = parseInt(timelineSlider.value, 10);
  const oldest = historyData.length > 0 ? historyData[0].t : Date.now() - 3600000;
  const now = Date.now();
  const totalRange = Math.max(1000, now - oldest);

  const frac = val / 1000;
  viewEndTimestamp = oldest + (frac * totalRange);

  if (val >= 995) {
    setFollowLive(true);
  } else {
    setFollowLive(false);
  }

  renderGraph();
});

// Follow Live Toggle & Jump
function setFollowLive(follow) {
  isFollowingLive = follow;
  if (follow) {
    btnFollowLive.classList.add('active');
    followBtnText.textContent = 'Follow Live';
    btnJumpLive.style.display = 'none';
    viewEndTimestamp = Date.now();
  } else {
    btnFollowLive.classList.remove('active');
    followBtnText.textContent = 'Paused (History)';
    btnJumpLive.style.display = 'inline-flex';
  }
  updateScrubber();
}

btnFollowLive.addEventListener('click', () => {
  setFollowLive(!isFollowingLive);
  renderGraph();
});

btnJumpLive.addEventListener('click', () => {
  setFollowLive(true);
  renderGraph();
});

// Units Switcher (Bytes vs Bits)
btnUnitBytes.addEventListener('click', () => {
  currentUnit = 'bytes';
  btnUnitBytes.classList.add('active');
  btnUnitBits.classList.remove('active');
  legendDlUnit.textContent = 'KB/s';
  legendUlUnit.textContent = 'KB/s';
  updateKpiCards(currentSnapshot);
  renderGraph();
});

btnUnitBits.addEventListener('click', () => {
  currentUnit = 'bits';
  btnUnitBits.classList.add('active');
  btnUnitBytes.classList.remove('active');
  legendDlUnit.textContent = 'Mbps';
  legendUlUnit.textContent = 'Mbps';
  updateKpiCards(currentSnapshot);
  renderGraph();
});

// Range Buttons
document.querySelectorAll('.btn-range').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-range').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const rangeVal = btn.getAttribute('data-range');
    viewWindowSeconds = rangeVal === 'all' ? 'all' : parseInt(rangeVal, 10);
    renderGraph();
  });
});

// MacBook Status Bar Toggle Button
btnToggleStatusBar.addEventListener('click', async () => {
  try {
    const newState = !isStatusBarActive;
    const res = await ipcRenderer.invoke('toggle-status-bar-speed', newState);
    updateStatusBarButton(res.showInStatusBar);
  } catch (err) {
    console.warn('Failed to toggle status bar:', err);
  }
});

function updateStatusBarButton(active) {
  isStatusBarActive = Boolean(active);
  if (isStatusBarActive) {
    btnToggleStatusBar.classList.add('active');
    statusBarBtnText.textContent = 'MacBook Status Bar: ON';
  } else {
    btnToggleStatusBar.classList.remove('active');
    statusBarBtnText.textContent = 'MacBook Status Bar: OFF';
  }
}

// Clear History Button
btnClear.addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all recorded network speed history?')) {
    try {
      await ipcRenderer.invoke('clear-network-speed-history');
      historyData = [];
      setFollowLive(true);
      renderGraph();
      updateScrubber();
    } catch (err) {
      console.warn('Failed to clear history:', err);
    }
  }
});

// Export Button
btnExport.addEventListener('click', async () => {
  try {
    const csv = await ipcRenderer.invoke('export-network-speed-history', 'csv');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `torrently-network-speed-${Date.now()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn('Export failed:', err);
  }
});

// IPC Event Listeners
if (ipcRenderer) {
  // Live speed stream broadcast
  ipcRenderer.on('live-network-speed', (event, snapshot) => {
    currentSnapshot = snapshot;
    if (snapshot && snapshot.current) {
      historyData.push({
        t: snapshot.current.timestamp,
        down: snapshot.current.down,
        up: snapshot.current.up
      });

      // Keep recent in memory
      if (historyData.length > 50000) {
        historyData.splice(0, 1000);
      }
    }

    updateKpiCards(snapshot);
    if (isFollowingLive) {
      viewEndTimestamp = Date.now();
      updateScrubber();
      renderGraph();
    }
  });

  // History cleared event
  ipcRenderer.on('network-speed-history-cleared', () => {
    historyData = [];
    updateScrubber();
    renderGraph();
  });
}

// Initial Data Load
async function init() {
  resizeCanvas();

  try {
    const prefs = await ipcRenderer.invoke('get-preferences');
    if (prefs) {
      updateStatusBarButton(prefs.showInStatusBar);
    }

    const snapshot = await ipcRenderer.invoke('get-live-network-speed');
    if (snapshot) {
      currentSnapshot = snapshot;
      updateKpiCards(snapshot);
    }

    const history = await ipcRenderer.invoke('get-network-speed-history');
    if (Array.isArray(history)) {
      historyData = history;
    }

    updateScrubber();
    renderGraph();
  } catch (err) {
    console.warn('Error during monitor init:', err);
  }
}

// Continuous frame loop for smooth live updates
function animationLoop() {
  if (isFollowingLive) {
    renderGraph();
  }
  requestAnimationFrame(animationLoop);
}

// Start
init();
requestAnimationFrame(animationLoop);
