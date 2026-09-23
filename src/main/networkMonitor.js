const { EventEmitter } = require('events');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

class NetworkMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMs = options.intervalMs || 1000;
    this.storagePath = options.storagePath || null;
    this.maxHistoryPoints = options.maxHistoryPoints || 43200; // ~12 hours at 1s intervals
    this.engine = options.engine || null;

    this.timer = null;
    this.saveTimer = null;
    this.dirty = false;

    this.lastSampleTime = null;
    this.lastBytesIn = null;
    this.lastBytesOut = null;

    this.currentSpeed = {
      timestamp: Date.now(),
      down: 0, // bytes/sec
      up: 0,   // bytes/sec
      total: 0 // bytes/sec
    };

    this.history = []; // Array of { t: timestampMs, down: bytesPerSec, up: bytesPerSec }
    this.peakSpeed = { down: 0, up: 0, total: 0 };
    this.totalBytesTransferred = { down: 0, up: 0 };

    this.loadHistory();
  }

  loadHistory() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.history)) {
          this.history = data.history
            .filter(p => p && typeof p.t === 'number' && typeof p.down === 'number' && typeof p.up === 'number')
            .slice(-this.maxHistoryPoints);

          for (const item of this.history) {
            if (item.down > this.peakSpeed.down) this.peakSpeed.down = item.down;
            if (item.up > this.peakSpeed.up) this.peakSpeed.up = item.up;
            const tot = item.down + item.up;
            if (tot > this.peakSpeed.total) this.peakSpeed.total = tot;
          }
        }
      }
    } catch (err) {
      console.warn('[NetworkMonitor] Failed to load history from disk:', err.message);
      this.history = [];
    }
  }

  saveHistory() {
    if (!this.storagePath || !this.dirty) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const compacted = this.compactHistory(this.history, this.maxHistoryPoints);
      this.history = compacted;

      const payload = {
        updatedAt: Date.now(),
        peakSpeed: this.peakSpeed,
        history: this.history
      };

      fs.writeFileSync(this.storagePath, JSON.stringify(payload), 'utf8');
      this.dirty = false;
    } catch (err) {
      console.warn('[NetworkMonitor] Failed to persist history to disk:', err.message);
    }
  }

  compactHistory(points, max) {
    if (!points || points.length <= max) return points || [];
    const keepRecentCount = Math.min(points.length, 7200);
    const recent = points.slice(-keepRecentCount);
    const older = points.slice(0, -keepRecentCount);

    const downsampledOlder = [];
    const step = Math.max(2, Math.ceil(older.length / (max - keepRecentCount)));
    for (let i = 0; i < older.length; i += step) {
      downsampledOlder.push(older[i]);
    }

    return [...downsampledOlder, ...recent].slice(-max);
  }

  start() {
    if (this.timer) return;

    this.sampleRawCounters((err, counters) => {
      if (!err && counters) {
        this.lastSampleTime = Date.now();
        this.lastBytesIn = counters.inBytes;
        this.lastBytesOut = counters.outBytes;
      }
    });

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);

    this.saveTimer = setInterval(() => {
      this.saveHistory();
    }, 20000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveHistory();
  }

  isRunning() {
    return Boolean(this.timer);
  }

  destroy() {
    this.stop();
    this.removeAllListeners();
  }

  sampleRawCounters(callback) {
    const platform = process.platform;

    if (platform === 'darwin') {
      cp.exec('netstat -ibn', { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return callback(err || new Error('No stdout'));
        let inBytes = 0;
        let outBytes = 0;
        const lines = stdout.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(/\s+/);
          if (parts[0] && !parts[0].startsWith('lo') && parts.some(p => p.startsWith('<Link#'))) {
            if (parts.length >= 11) {
              inBytes += parseInt(parts[6], 10) || 0;
              outBytes += parseInt(parts[9], 10) || 0;
            } else if (parts.length === 10) {
              inBytes += parseInt(parts[5], 10) || 0;
              outBytes += parseInt(parts[8], 10) || 0;
            }
          }
        }
        callback(null, { inBytes, outBytes });
      });
    } else if (platform === 'linux') {
      fs.readFile('/proc/net/dev', 'utf8', (err, data) => {
        if (err || !data) return callback(err || new Error('Cannot read /proc/net/dev'));
        let inBytes = 0;
        let outBytes = 0;
        const lines = data.split('\n');
        for (const line of lines) {
          const colonIdx = line.indexOf(':');
          if (colonIdx === -1) continue;
          const iface = line.slice(0, colonIdx).trim();
          if (iface === 'lo') continue;
          const values = line.slice(colonIdx + 1).trim().split(/\s+/);
          if (values.length >= 9) {
            inBytes += parseInt(values[0], 10) || 0;
            outBytes += parseInt(values[8], 10) || 0;
          }
        }
        callback(null, { inBytes, outBytes });
      });
    } else if (platform === 'win32') {
      cp.exec('netstat -e', { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return callback(err || new Error('netstat -e failed'));
        const lines = stdout.split('\n');
        let inBytes = 0;
        let outBytes = 0;
        for (const line of lines) {
          if (line.toLowerCase().includes('bytes')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              inBytes = parseInt(parts[1], 10) || 0;
              outBytes = parseInt(parts[2], 10) || 0;
            }
          }
        }
        callback(null, { inBytes, outBytes });
      });
    } else {
      callback(new Error('Unsupported platform'));
    }
  }

  getTorrentEngineSpeeds() {
    let down = 0;
    let up = 0;
    if (this.engine && this.engine.torrents) {
      try {
        for (const t of this.engine.torrents.values()) {
          if (!t.paused) {
            down += (t.downloadSpeed || 0);
            up += (t.uploadSpeed || 0);
          }
        }
      } catch (e) {}
    }
    return { down, up };
  }

  tick() {
    const now = Date.now();
    this.sampleRawCounters((err, counters) => {
      let downSpeed = 0;
      let upSpeed = 0;

      if (!err && counters) {
        if (this.lastSampleTime && this.lastBytesIn !== null && this.lastBytesOut !== null) {
          const timeDeltaSec = (now - this.lastSampleTime) / 1000;
          if (timeDeltaSec > 0.3) {
            const inDelta = counters.inBytes - this.lastBytesIn;
            const outDelta = counters.outBytes - this.lastBytesOut;

            if (inDelta >= 0 && outDelta >= 0) {
              downSpeed = Math.round(inDelta / timeDeltaSec);
              upSpeed = Math.round(outDelta / timeDeltaSec);
            }
          }
        }

        this.lastSampleTime = now;
        this.lastBytesIn = counters.inBytes;
        this.lastBytesOut = counters.outBytes;
      }

      const engineSpeeds = this.getTorrentEngineSpeeds();
      if (engineSpeeds.down > downSpeed) downSpeed = engineSpeeds.down;
      if (engineSpeeds.up > upSpeed) upSpeed = engineSpeeds.up;

      this.totalBytesTransferred.down += downSpeed;
      this.totalBytesTransferred.up += upSpeed;

      const totalSpeed = downSpeed + upSpeed;

      if (downSpeed > this.peakSpeed.down) this.peakSpeed.down = downSpeed;
      if (upSpeed > this.peakSpeed.up) this.peakSpeed.up = upSpeed;
      if (totalSpeed > this.peakSpeed.total) this.peakSpeed.total = totalSpeed;

      this.currentSpeed = {
        timestamp: now,
        down: downSpeed,
        up: upSpeed,
        total: totalSpeed
      };

      this.history.push({
        t: now,
        down: downSpeed,
        up: upSpeed
      });

      this.dirty = true;

      if (this.history.length > this.maxHistoryPoints * 1.2) {
        this.history = this.compactHistory(this.history, this.maxHistoryPoints);
      }

      const snapshot = this.getSnapshot();
      this.emit('speed', snapshot);
    });
  }

  getCurrentSpeed() {
    return this.currentSpeed;
  }

  getSnapshot() {
    return {
      current: this.currentSpeed,
      peak: this.peakSpeed,
      totalTransferred: this.totalBytesTransferred,
      historyCount: this.history.length,
      formatted: {
        downBytes: NetworkMonitor.formatBytes(this.currentSpeed.down),
        upBytes: NetworkMonitor.formatBytes(this.currentSpeed.up),
        totalBytes: NetworkMonitor.formatBytes(this.currentSpeed.total),
        downBits: NetworkMonitor.formatBits(this.currentSpeed.down),
        upBits: NetworkMonitor.formatBits(this.currentSpeed.up),
        totalBits: NetworkMonitor.formatBits(this.currentSpeed.total)
      }
    };
  }

  getHistory(options = {}) {
    const { from, to, maxPoints = 2000 } = options;
    let filtered = this.history;

    if (typeof from === 'number') {
      filtered = filtered.filter(p => p.t >= from);
    }
    if (typeof to === 'number') {
      filtered = filtered.filter(p => p.t <= to);
    }

    if (filtered.length <= maxPoints) {
      return filtered;
    }

    const step = Math.ceil(filtered.length / maxPoints);
    const result = [];
    for (let i = 0; i < filtered.length; i += step) {
      const slice = filtered.slice(i, i + step);
      let sumDown = 0;
      let sumUp = 0;
      for (const pt of slice) {
        sumDown += pt.down;
        sumUp += pt.up;
      }
      result.push({
        t: slice[slice.length - 1].t,
        down: Math.round(sumDown / slice.length),
        up: Math.round(sumUp / slice.length)
      });
    }

    return result;
  }

  clearHistory() {
    this.history = [];
    this.peakSpeed = { down: 0, up: 0, total: 0 };
    this.totalBytesTransferred = { down: 0, up: 0 };
    this.dirty = true;
    this.saveHistory();
    this.emit('cleared');
  }

  exportHistory(format = 'json') {
    if (format === 'csv') {
      const rows = ['Timestamp,DateTime,Download_Bytes_Sec,Upload_Bytes_Sec,Total_Bytes_Sec'];
      for (const p of this.history) {
        const iso = new Date(p.t).toISOString();
        rows.push(`${p.t},"${iso}",${p.down},${p.up},${p.down + p.up}`);
      }
      return rows.join('\n');
    }
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      peakSpeed: this.peakSpeed,
      totalTransferred: this.totalBytesTransferred,
      dataPoints: this.history
    }, null, 2);
  }

  static formatBytes(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B/s';
    if (bytes < 1024) return `${Math.round(bytes)} B/s`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  }

  static formatBits(bytes) {
    if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 bps';
    const bits = bytes * 8;
    if (bits < 1000) return `${Math.round(bits)} bps`;
    if (bits < 1000 * 1000) return `${(bits / 1000).toFixed(1)} kbps`;
    if (bits < 1000 * 1000 * 1000) return `${(bits / (1000 * 1000)).toFixed(2)} Mbps`;
    return `${(bits / (1000 * 1000 * 1000)).toFixed(2)} Gbps`;
  }

  static formatCompact(bytes) {
    if (!bytes || bytes <= 0) return '0K';
    if (bytes < 1024) return `${Math.round(bytes)}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }
}

module.exports = NetworkMonitor;
