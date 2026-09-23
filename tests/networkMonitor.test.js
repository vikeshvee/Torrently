const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const NetworkMonitor = require('../src/main/networkMonitor');

test('NetworkMonitor formatting helpers (Bytes & Bits)', () => {
  // Format Bytes
  assert.strictEqual(NetworkMonitor.formatBytes(0), '0 B/s');
  assert.strictEqual(NetworkMonitor.formatBytes(500), '500 B/s');
  assert.strictEqual(NetworkMonitor.formatBytes(1024 * 150), '150.0 KB/s');
  assert.strictEqual(NetworkMonitor.formatBytes(1024 * 1024 * 5.5), '5.50 MB/s');
  assert.strictEqual(NetworkMonitor.formatBytes(1024 * 1024 * 1024 * 1.25), '1.25 GB/s');

  // Format Bits
  assert.strictEqual(NetworkMonitor.formatBits(0), '0 bps');
  assert.strictEqual(NetworkMonitor.formatBits(100), '800 bps');
  assert.strictEqual(NetworkMonitor.formatBits(12500), '100.0 kbps'); // 12500 bytes = 100,000 bits = 100 kbps
  assert.strictEqual(NetworkMonitor.formatBits(1250000), '10.00 Mbps'); // 1.25 MB = 10 Mbps
  assert.strictEqual(NetworkMonitor.formatBits(125000000), '1.00 Gbps');

  // Format Compact
  assert.strictEqual(NetworkMonitor.formatCompact(0), '0K');
  assert.strictEqual(NetworkMonitor.formatCompact(500), '500B');
  assert.strictEqual(NetworkMonitor.formatCompact(1024 * 450), '450K');
  assert.strictEqual(NetworkMonitor.formatCompact(1024 * 1024 * 3.5), '3.5M');
});

test('NetworkMonitor history persistence to disk and reload', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-test-'));
  const testStorage = path.join(tmpDir, 'network-history.json');

  try {
    const monitor1 = new NetworkMonitor({
      storagePath: testStorage,
      maxHistoryPoints: 50
    });

    const baseTime = Date.now() - 60000;
    for (let i = 0; i < 20; i++) {
      monitor1.history.push({
        t: baseTime + i * 1000,
        down: 1024 * (i + 1),
        up: 512 * (i + 1)
      });
    }
    monitor1.peakSpeed = { down: 20480, up: 10240, total: 30720 };
    monitor1.dirty = true;
    monitor1.saveHistory();

    assert.strictEqual(fs.existsSync(testStorage), true);

    // Initialize second monitor reading from the same file
    const monitor2 = new NetworkMonitor({
      storagePath: testStorage,
      maxHistoryPoints: 50
    });

    assert.strictEqual(monitor2.history.length, 20);
    assert.strictEqual(monitor2.history[0].down, 1024);
    assert.strictEqual(monitor2.history[19].down, 20480);
    assert.strictEqual(monitor2.peakSpeed.down, 20480);

    monitor1.destroy();
    monitor2.destroy();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('NetworkMonitor getHistory time filtering and downsampling', () => {
  const monitor = new NetworkMonitor();
  const baseTime = 1700000000000;

  for (let i = 0; i < 100; i++) {
    monitor.history.push({
      t: baseTime + i * 1000,
      down: 1000 + i,
      up: 500 + i
    });
  }

  // Filter with from and to
  const slice = monitor.getHistory({
    from: baseTime + 10000,
    to: baseTime + 20000
  });
  assert.strictEqual(slice.length, 11);
  assert.strictEqual(slice[0].t, baseTime + 10000);
  assert.strictEqual(slice[10].t, baseTime + 20000);

  // Downsample when exceeding maxPoints
  const downsampled = monitor.getHistory({ maxPoints: 10 });
  assert.strictEqual(downsampled.length <= 15, true);
  assert.strictEqual(downsampled.length > 0, true);

  monitor.destroy();
});

test('NetworkMonitor history compaction', () => {
  const monitor = new NetworkMonitor();
  const dummyPoints = [];
  const now = Date.now();

  for (let i = 0; i < 10000; i++) {
    dummyPoints.push({ t: now - (10000 - i) * 1000, down: 100, up: 50 });
  }

  const compacted = monitor.compactHistory(dummyPoints, 8000);
  assert.strictEqual(compacted.length <= 8000, true);
  // Preserves recent samples
  assert.strictEqual(compacted[compacted.length - 1].t, dummyPoints[dummyPoints.length - 1].t);

  monitor.destroy();
});

test('NetworkMonitor export to JSON and CSV', () => {
  const monitor = new NetworkMonitor();
  const now = 1700000000000;
  monitor.history.push({ t: now, down: 5000, up: 2000 });
  monitor.history.push({ t: now + 1000, down: 6000, up: 3000 });

  // JSON export
  const jsonStr = monitor.exportHistory('json');
  const parsed = JSON.parse(jsonStr);
  assert.strictEqual(parsed.dataPoints.length, 2);
  assert.strictEqual(parsed.dataPoints[0].down, 5000);

  // CSV export
  const csvStr = monitor.exportHistory('csv');
  assert.strictEqual(csvStr.includes('Timestamp,DateTime,Download_Bytes_Sec'), true);
  assert.strictEqual(csvStr.includes('5000,2000,7000'), true);

  // Clear history
  monitor.clearHistory();
  assert.strictEqual(monitor.history.length, 0);
  assert.strictEqual(monitor.peakSpeed.down, 0);

  monitor.destroy();
});

test('NetworkMonitor torrent engine correlation fallback', () => {
  const fakeEngine = {
    torrents: new Map([
      ['t1', { paused: false, downloadSpeed: 1048576, uploadSpeed: 262144 }],
      ['t2', { paused: true, downloadSpeed: 500000, uploadSpeed: 100000 }]
    ])
  };

  const monitor = new NetworkMonitor({ engine: fakeEngine });
  const engineSpeeds = monitor.getTorrentEngineSpeeds();
  assert.strictEqual(engineSpeeds.down, 1048576);
  assert.strictEqual(engineSpeeds.up, 262144);

  monitor.destroy();
});

test('macOS Status bar speed title formatting and snapshot', () => {
  const downBytes = 1024 * 1024 * 2.4; // 2.4 MB/s
  const upBytes = 1024 * 350; // 350 KB/s

  const downStr = NetworkMonitor.formatBytes(downBytes);
  const upStr = NetworkMonitor.formatBytes(upBytes);
  const title = ` ↓ ${downStr}  ↑ ${upStr}`;

  assert.strictEqual(title, ' ↓ 2.40 MB/s  ↑ 350.0 KB/s');

  const monitor = new NetworkMonitor();
  monitor.currentSpeed = {
    timestamp: Date.now(),
    down: downBytes,
    up: upBytes,
    total: downBytes + upBytes
  };
  const snap = monitor.getSnapshot();
  assert.strictEqual(snap.formatted.downBytes, '2.40 MB/s');
  assert.strictEqual(snap.formatted.upBytes, '350.0 KB/s');
  assert.strictEqual(snap.formatted.downBits, '20.13 Mbps');
  monitor.destroy();
});

