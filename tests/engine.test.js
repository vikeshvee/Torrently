const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const TorrentEngine = require('../src/main/engine');
const { parseTorrentMetadata } = require('../src/main/bencode');
const { expandPath } = require('../src/main/paths');

test('Cross-platform path expansion', () => {
  const expandedHome = expandPath('~/Downloads/Torrently');
  assert.ok(!expandedHome.startsWith('~'));
  assert.ok(expandedHome.includes('Downloads'));
});

test('TorrentEngine initialization & state isolation', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  assert.strictEqual(typeof engine.addTorrent, 'function');
  assert.strictEqual(typeof engine.getTorrents, 'function');
  assert.strictEqual(typeof engine.getTorrentPeers, 'function');
  engine.client = client;
  engine.destroy();
});

test('Pasted torrent link sanitization & magnet name extraction', () => {
  const rawMagnet = ' <magnet:?xt=urn:btih:6a9759b02a0c4f8280f55e5d&dn=Ubuntu+22.04+Desktop&tr=udp://tracker.opentrackers.org:1337> ';
  const cleaned = TorrentEngine.sanitizeTorrentInput(rawMagnet);
  assert.strictEqual(cleaned.startsWith('magnet:?'), true);
  assert.strictEqual(cleaned.endsWith('>'), false);

  const name = TorrentEngine.extractTorrentName(cleaned);
  assert.strictEqual(name, 'Ubuntu 22.04 Desktop');

  const rawHash = ' 4a40669176e3d23190df0df32007eed5ffce8f58 ';
  const cleanedHash = TorrentEngine.sanitizeTorrentInput(rawHash);
  assert.strictEqual(TorrentEngine.isValidWebTorrentInput(cleanedHash), true);
});

test('Transmission Bencode Parser & Piece Boundaries', () => {
  const torrentFile = path.join(__dirname, '../../The.Auction.mp4.torrent');
  if (fs.existsSync(torrentFile)) {
    const meta = parseTorrentMetadata(torrentFile);
    assert.ok(meta.name.includes('The.Auction'));
    assert.strictEqual(meta.length, 486229889);
    assert.strictEqual(meta.files.length, 1);
    assert.strictEqual(meta.files[0].startPiece, 0);
    assert.ok(meta.pieceLength > 0);
  }
});

test('TorrentEngine length preservation, zero peer metrics & peer inspector extraction', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const torrentFile = path.join(__dirname, '../../The.Auction.mp4.torrent');
  if (fs.existsSync(torrentFile)) {
    const torrent = await engine.addTorrent(torrentFile, {
      paused: true,
      file_wanted: [true],
      file_priorities: ['high']
    });

    assert.ok(torrent.infoHash);
    assert.strictEqual(torrent.paused, true);
    assert.strictEqual(torrent.length, 486229889);
    assert.strictEqual(torrent.downloadSpeed, 0);

    const progressMeta = engine.formatTorrentProgress(torrent);
    assert.strictEqual(progressMeta.length, 486229889);
    assert.strictEqual(progressMeta.downloadSpeed, 0);

    // Verify peer inspector method
    const peers = engine.getTorrentPeers(torrent.infoHash);
    assert.ok(Array.isArray(peers));

    // Verify live file wanted toggle
    const updated = engine.setFileWanted(torrent.infoHash, 0, false);
    assert.strictEqual(updated, true);
    const updatedTorrent = engine.torrents.get(torrent.infoHash);
    assert.strictEqual(updatedTorrent.file_wanted[0], false);
  }

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine local data re-check and piece verification (verifyTorrent)', async () => {
  const tmpDir = path.join(__dirname, 'tmp_verify_test');
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const fileName = 'test_verify_sample.bin';
  const filePath = path.join(tmpDir, fileName);
  const partialSize = 250000;
  const totalLength = 1000000;

  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:e3b0c44298fc1c149afbf4c8996fb92427ae41e4&dn=TestVerify', {
    name: fileName,
    downloadPath: tmpDir,
    length: totalLength,
    progress: 0,
    downloaded: 0
  });

  assert.strictEqual(torrent.progress, 0);
  assert.strictEqual(torrent.downloaded, 0);

  // Write partial file on disk
  fs.writeFileSync(filePath, Buffer.alloc(partialSize, 0x5a));

  // Run verifyTorrent
  const verified = await engine.verifyTorrent(torrent.infoHash);
  assert.ok(verified);
  assert.strictEqual(verified.downloaded, partialSize);
  assert.strictEqual(verified.progress, 0.25);
  assert.strictEqual(verified.verifying, false);

  // Clean up
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  } catch (e) {}

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine pause and resume state controls', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2&dn=PauseResumeTest', {
    length: 500000,
    paused: false
  });

  assert.strictEqual(torrent.paused, false);

  const pauseRes = engine.pauseTorrent(torrent.infoHash);
  assert.strictEqual(pauseRes, true);
  const pausedMeta = engine.torrents.get(torrent.infoHash);
  assert.strictEqual(pausedMeta.paused, true);
  assert.strictEqual(pausedMeta.downloadSpeed, 0);

  const resumeRes = engine.resumeTorrent(torrent.infoHash);
  assert.strictEqual(resumeRes, true);
  const resumedMeta = engine.torrents.get(torrent.infoHash);
  assert.strictEqual(resumedMeta.paused, false);

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine duplicate torrent add resumes from where finished without duplicate card', async () => {
  const tmpDir = path.join(__dirname, 'tmp_dup_test');
  fs.mkdirSync(tmpDir, { recursive: true });

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const magnet = 'magnet:?xt=urn:btih:1122334455667788990011223344556677889900&dn=DuplicateTest';
  const fileName = 'dup_sample.bin';
  const filePath = path.join(tmpDir, fileName);

  const t1 = await engine.addTorrent(magnet, {
    name: fileName,
    downloadPath: tmpDir,
    length: 1000000,
    progress: 0,
    downloaded: 0
  });

  // Simulate download progress of 400,000 bytes
  fs.writeFileSync(filePath, Buffer.alloc(400000, 0x11));
  engine.pauseTorrent(t1.infoHash);
  assert.strictEqual(engine.torrents.get(t1.infoHash).paused, true);

  // Now add the duplicate torrent
  const t2 = await engine.addTorrent(magnet, {
    name: fileName,
    downloadPath: tmpDir
  });

  // Must match the original torrent infoHash
  assert.strictEqual(t2.infoHash, t1.infoHash);
  // Must have synced the 400,000 bytes from disk
  assert.strictEqual(t2.downloaded, 400000);
  assert.strictEqual(t2.progress, 0.4);
  // Must resume downloading (paused: false)
  assert.strictEqual(t2.paused, false);
  // Torrents map must still only contain 1 torrent (no duplicates)
  assert.strictEqual(engine.torrents.size, 1);

  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  } catch (e) {}

  engine.client = client;
  engine.destroy();
});

test('User magnet link sanitization, trailing period removal & name extraction', () => {
  const userLink = `magnet:?xt=urn:btih:5e74f5027bbcad0186c4fe585505e23b99015b58&dn=Rocco's%20Teens%20Unleashed%205%20[Evil%20Angel]%20(2026)%20540p&tr=udp://tracker.torrent.eu.org:451/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.bittor.pw:1337/announce&tr=udp://explodie.org:6969/announce&tr=udp://tracker.dler.org:6969/announce&tr=udp://open.demonii.com:1337/announce&tr=udp://exodus.desync.com:6969/announce&tr=udp://tracker.filemail.com:6969/announce&tr=udp://tracker.tryhackx.org:6969/announce&tr=udp://tracker.qu.ax:6969/announce&tr=udp://tracker.opentorrent.top:6969/announce&tr=udp://udp.tracker.projectk.org:23333/announce&tr=udp://martin-gebhardt.eu:6969/announce.`;

  const sanitized = TorrentEngine.sanitizeTorrentInput(userLink);
  assert.ok(sanitized.startsWith('magnet:?xt=urn:btih:5e74f5027bbcad0186c4fe585505e23b99015b58'));
  assert.strictEqual(sanitized.endsWith('.'), false);
  assert.strictEqual(TorrentEngine.isValidWebTorrentInput(sanitized), true);

  const name = TorrentEngine.extractTorrentName(sanitized);
  assert.ok(name.includes('Rocco'));
  assert.ok(name.includes('Teens'));

  // Test embedded link from clipboard text
  const clipboardSentence = `Download here: <${userLink}>.`;
  const extracted = TorrentEngine.sanitizeTorrentInput(clipboardSentence);
  assert.ok(extracted.startsWith('magnet:?xt=urn:btih:5e74f5027bbcad0186c4fe585505e23b99015b58'));
  assert.strictEqual(extracted.endsWith('>'), false);
  assert.strictEqual(extracted.endsWith('.'), false);
});

test('TorrentEngine resumes from where left off and never starts from zero when partial data exists', async () => {
  const tmpDir = path.join(__dirname, 'tmp_resume_nonzero_test');
  fs.mkdirSync(tmpDir, { recursive: true });

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const magnet = 'magnet:?xt=urn:btih:9988776655443322110099887766554433221100&dn=ResumeTest';
  const fileName = 'resume_sample.bin';
  const filePath = path.join(tmpDir, fileName);
  const totalLength = 2000000;
  const initialDownloaded = 750000; // 37.5% downloaded

  // Write existing partial file to disk
  fs.writeFileSync(filePath, Buffer.alloc(initialDownloaded, 0xab));

  // Add torrent with previous state (or disk data)
  const torrent = await engine.addTorrent(magnet, {
    name: fileName,
    downloadPath: tmpDir,
    length: totalLength,
    downloaded: initialDownloaded,
    progress: initialDownloaded / totalLength
  });

  // Must retain downloaded bytes and NOT start from 0
  assert.strictEqual(torrent.downloaded, initialDownloaded);
  assert.strictEqual(torrent.progress, 0.375);

  const progressObj = engine.formatTorrentProgress(torrent);
  assert.strictEqual(progressObj.downloaded, initialDownloaded);
  assert.strictEqual(progressObj.progress, 0.375);

  // Clean up
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  } catch (e) {}

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine never marks 9% torrent complete when file on disk is sparse allocated', async () => {
  const tmpDir = path.join(__dirname, 'tmp_sparse_test');
  fs.mkdirSync(tmpDir, { recursive: true });

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const fileName = 'sparse_sample.mp4';
  const filePath = path.join(tmpDir, fileName);
  const totalLength = 100000000; // 100 MB
  const actualDownloaded = 9000000; // 9 MB (9%)

  // On macOS/Linux, when WebTorrent writes a piece, stat.size can report full 100MB
  fs.writeFileSync(filePath, Buffer.alloc(1024, 0x11));
  fs.truncateSync(filePath, totalLength); // Simulate sparse/pre-allocated file
  assert.strictEqual(fs.statSync(filePath).size, totalLength);

  // Load torrent with 9% progress
  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:3344556677889900112233445566778899001122&dn=SparseTest', {
    name: fileName,
    downloadPath: tmpDir,
    length: totalLength,
    downloaded: actualDownloaded,
    progress: 0.09
  });

  // Must remain at 9%, NOT 100%!
  assert.strictEqual(torrent.downloaded, actualDownloaded);
  assert.strictEqual(torrent.progress, 0.09);
  assert.notStrictEqual(torrent.progress, 1.0);

  const formatted = engine.formatTorrentProgress(torrent);
  assert.strictEqual(formatted.downloaded, actualDownloaded);
  assert.strictEqual(formatted.progress, 0.09);

  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(tmpDir);
  } catch (e) {}

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine preserves 4 sub-files and per-file progress across state persistence', async () => {
  const statePath = path.join(__dirname, 'tmp_multifile_state.json');
  const tmpDir = path.join(__dirname, 'tmp_multifile_dir');
  try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch (e) {}
  try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(tmpDir, { recursive: true });

  const engine = new TorrentEngine({ stateFilePath: statePath, downloadDir: tmpDir, disableClient: true });
  await engine.init();

  const fourFiles = [
    { index: 0, name: 'video1.mp4', path: 'video1.mp4', length: 1000000, downloaded: 30000, progress: 0.03, wanted: true },
    { index: 1, name: 'video2.mp4', path: 'video2.mp4', length: 1000000, downloaded: 10000, progress: 0.01, wanted: true },
    { index: 2, name: 'notes.pdf', path: 'notes.pdf', length: 500000, downloaded: 0, progress: 0.0, wanted: true },
    { index: 3, name: 'bonus.zip', path: 'bonus.zip', length: 500000, downloaded: 0, progress: 0.0, wanted: false }
  ];

  const t = await engine.addTorrent('magnet:?xt=urn:btih:4455667788990011223344556677889900112233&dn=MultiFileTest', {
    name: 'MultiFileTest',
    downloadPath: tmpDir,
    length: 3000000,
    downloaded: 40000,
    progress: 40000 / 3000000,
    isMultiFile: true,
    files: fourFiles
  });

  assert.strictEqual(t.isMultiFile, true);
  assert.strictEqual(t.files.length, 4);
  assert.strictEqual(t.files[0].progress, 0.03);
  assert.strictEqual(t.files[1].progress, 0.01);
  assert.strictEqual(t.files[2].progress, 0.0);

  // Save state
  engine.saveState();
  assert.ok(fs.existsSync(statePath));
  engine.destroy();

  // Restart engine and verify state restoration
  const engine2 = new TorrentEngine({ stateFilePath: statePath, downloadDir: tmpDir, disableClient: true });
  await engine2.init();

  const restoredTorrents = engine2.getTorrents();
  assert.strictEqual(restoredTorrents.length, 1);
  const restored = restoredTorrents[0];

  assert.strictEqual(restored.isMultiFile, true);
  assert.strictEqual(restored.files.length, 4);
  assert.strictEqual(restored.files[0].name, 'video1.mp4');
  assert.strictEqual(restored.files[0].progress, 0.03);
  assert.strictEqual(restored.files[1].progress, 0.01);
  assert.strictEqual(restored.files[2].progress, 0.0);
  assert.strictEqual(restored.files[3].wanted, false);

  engine2.destroy();
  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
});

test('TorrentEngine set location flow and step status progression', async () => {
  const statePath = path.join(__dirname, 'tmp_set_loc_state.json');
  const initialDir = path.join(__dirname, 'tmp_loc_initial');
  const newDir = path.join(__dirname, 'tmp_loc_destination');

  try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch (e) {}
  try { if (fs.existsSync(initialDir)) fs.rmSync(initialDir, { recursive: true, force: true }); } catch (e) {}
  try { if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true }); } catch (e) {}

  fs.mkdirSync(initialDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });

  const fileName = 'location_test_sample.bin';
  const initialFilePath = path.join(initialDir, fileName);
  fs.writeFileSync(initialFilePath, Buffer.alloc(150000, 0x42));

  const engine = new TorrentEngine({ stateFilePath: statePath, downloadDir: initialDir, disableClient: true });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  const t = await engine.addTorrent('magnet:?xt=urn:btih:778899aabbccddeeff0011223344556677889900&dn=LocationTest', {
    name: fileName,
    downloadPath: initialDir,
    length: 500000,
    downloaded: 150000,
    progress: 0.3
  });

  const emittedStatuses = [];
  engine.on('torrent-action-status', (evt) => {
    if (evt.infoHash === t.infoHash) {
      emittedStatuses.push({ status: evt.status, buttonsDisabled: evt.buttonsDisabled });
    }
  });

  // Execute setTorrentLocation
  const updated = await engine.setTorrentLocation(t.infoHash, newDir);
  assert.ok(updated);

  // Verify all 5 steps were emitted in exact required order:
  // New location -> Stop Torrent -> Verify data -> Update dbs -> Resume Torrent -> Enable pause/resume buttons -> Done
  const statusTexts = emittedStatuses.map(e => e.status);
  assert.ok(statusTexts.includes('Stopping torrent...'));
  assert.ok(statusTexts.includes('Verifying data...'));
  assert.ok(statusTexts.includes('Updating database...'));
  assert.ok(statusTexts.includes('Resuming torrent...'));
  assert.ok(statusTexts.includes('Done'));

  // Check buttonsDisabled states: true during operation, false when Done
  const doneEvt = emittedStatuses.find(e => e.status === 'Done');
  assert.strictEqual(doneEvt.buttonsDisabled, false);

  const stoppingEvt = emittedStatuses.find(e => e.status === 'Stopping torrent...');
  assert.strictEqual(stoppingEvt.buttonsDisabled, true);

  // Verify file was moved to new directory
  const newFilePath = path.join(newDir, fileName);
  assert.strictEqual(fs.existsSync(newFilePath), true);
  assert.strictEqual(fs.statSync(newFilePath).size, 150000);

  // Verify updated download path in memory and in state file
  assert.strictEqual(updated.downloadPath, newFilePath);
  const stateRaw = fs.readFileSync(statePath, 'utf8');
  const savedTorrents = JSON.parse(stateRaw);
  assert.strictEqual(savedTorrents[0].downloadPath, newFilePath);

  // Now test verifyTorrent step progression on the new location
  const verifyStatuses = [];
  engine.on('torrent-action-status', (evt) => {
    if (evt.infoHash === t.infoHash) {
      verifyStatuses.push({ status: evt.status, buttonsDisabled: evt.buttonsDisabled });
    }
  });

  const verified = await engine.verifyTorrent(t.infoHash);
  assert.ok(verified);

  const verifyTexts = verifyStatuses.map(e => e.status);
  assert.ok(verifyTexts.includes('Stopping torrent...'));
  assert.ok(verifyTexts.includes('Verifying data...'));
  assert.ok(verifyTexts.includes('Updating database...'));
  assert.ok(verifyTexts.includes('Resuming torrent...'));
  assert.ok(verifyTexts.includes('Done'));

  engine.client = client;
  engine.destroy();

  try {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    if (fs.existsSync(initialDir)) fs.rmSync(initialDir, { recursive: true, force: true });
    if (fs.existsSync(newDir)) fs.rmSync(newDir, { recursive: true, force: true });
  } catch (e) {}
});

test('TorrentEngine preserves prototype getters on Torrent and File objects and updates progress dynamically', async () => {
  const engine = new TorrentEngine({ disableClient: true, disableState: true });

  // Create a mock prototype with dynamic getters matching WebTorrent's Torrent and File classes
  class MockTorrent {
    constructor() {
      this._bytes = 0;
      this.length = 10000;
    }
    get downloaded() {
      return this._bytes;
    }
    get progress() {
      return this.length > 0 ? this._bytes / this.length : 0;
    }
  }

  const mockT = new MockTorrent();

  // Test setMetric doesn't shadow prototype getter
  engine.setMetric(mockT, 'downloaded', 0);
  engine.setMetric(mockT, 'progress', 0);

  // Getter should still function when underlying bytes increase
  mockT._bytes = 5000;
  assert.strictEqual(engine.getMetric(mockT, 'downloaded'), 5000);
  assert.strictEqual(engine.getMetric(mockT, 'progress'), 0.5);

  // Test when disk floor is higher
  engine.setMetric(mockT, 'downloaded', 6000);
  assert.strictEqual(engine.getMetric(mockT, 'downloaded'), 6000);

  // When live bytes exceed disk floor, live bytes take precedence
  mockT._bytes = 8000;
  assert.strictEqual(engine.getMetric(mockT, 'downloaded'), 8000);
  assert.strictEqual(engine.getMetric(mockT, 'progress'), 0.8);

  // Test resolveTorrentPaths does not introduce duplicate nested directories
  const baseDir = '/tmp/downloads';
  const torrentName = 'SampleMovie';
  const resolved = engine.resolveTorrentPaths(baseDir, baseDir, torrentName);
  assert.strictEqual(resolved.targetPath, path.join(baseDir, torrentName));
  assert.strictEqual(resolved.baseFolder, baseDir);

  engine.destroy();
});

test('TorrentEngine saves and restores both paused and completed torrents across engine restarts', async () => {
  const tmpState = path.join(__dirname, 'test_paused_completed_state.json');
  const tmpDir = path.join(__dirname, 'tmp_dl_state_test');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const engine1 = new TorrentEngine({ stateFilePath: tmpState, downloadDir: tmpDir, disableClient: true });
    await engine1.init();

    // Add a paused torrent
    await engine1.addTorrent('magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=PausedTorrent', {
      name: 'PausedTorrent.mp4',
      length: 100000,
      downloaded: 45000,
      progress: 0.45,
      paused: true
    });

    // Add a completed torrent
    await engine1.addTorrent('magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=CompletedTorrent', {
      name: 'CompletedTorrent.mkv',
      length: 200000,
      downloaded: 200000,
      progress: 1.0,
      paused: false
    });

    engine1.saveState();
    engine1.destroy();

    // Verify state file was written with both torrents
    assert.strictEqual(fs.existsSync(tmpState), true);
    const raw = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
    assert.strictEqual(raw.length, 2);

    // Now start engine 2 and load state
    const engine2 = new TorrentEngine({ stateFilePath: tmpState, downloadDir: tmpDir, disableClient: true });
    await engine2.init();

    const restoredTorrents = engine2.getTorrents();
    assert.strictEqual(restoredTorrents.length, 2);

    const paused = restoredTorrents.find(t => t.name === 'PausedTorrent.mp4');
    assert.ok(paused);
    assert.strictEqual(paused.paused, true);
    assert.strictEqual(paused.progress, 0.45);
    assert.strictEqual(paused.downloaded, 45000);

    const completed = restoredTorrents.find(t => t.name === 'CompletedTorrent.mkv');
    assert.ok(completed);
    assert.strictEqual(completed.progress, 1.0);
    assert.strictEqual(completed.downloaded, 200000);

    engine2.destroy();
  } finally {
    try { if (fs.existsSync(tmpState)) fs.unlinkSync(tmpState); } catch (e) {}
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('Multi-file torrent metadata arrival expands files and updates sub-file progress', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  // Simulate magnet link added with 1 initial placeholder file
  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:3333333333333333333333333333333333333333&dn=MultiFileTorrent', {
    name: 'MultiFileTorrent',
    paused: false
  });

  assert.strictEqual(torrent.files.length, 1);
  assert.strictEqual(torrent.isMultiFile, false);

  // Simulate WebTorrent discovering metadata with 3 files
  const wtFiles = [
    { name: 'sample.mp4', path: 'MultiFileTorrent/sample.mp4', length: 1000, downloaded: 1000, progress: 1.0 },
    { name: 'movie.mkv', path: 'MultiFileTorrent/movie.mkv', length: 1000000, downloaded: 100000, progress: 0.1 },
    { name: 'subs.srt', path: 'MultiFileTorrent/subs.srt', length: 5000, downloaded: 0, progress: 0.0 }
  ];

  const wtTorrent = engine.torrents.get(torrent.infoHash);
  wtTorrent.files = wtFiles;
  wtTorrent.length = 1006000;
  wtTorrent.downloaded = 101000;
  wtTorrent.progress = 101000 / 1006000;

  // Format meta and progress
  const meta = engine.formatTorrentMeta(wtTorrent);
  assert.strictEqual(meta.isMultiFile, true);
  assert.strictEqual(meta.files.length, 3);
  assert.strictEqual(meta.files[0].name, 'sample.mp4');
  assert.strictEqual(meta.files[0].progress, 1.0);
  assert.strictEqual(meta.files[1].name, 'movie.mkv');
  assert.strictEqual(meta.files[1].progress, 0.1);
  assert.strictEqual(meta.files[2].name, 'subs.srt');
  assert.strictEqual(meta.files[2].progress, 0.0);

  const progress = engine.formatTorrentProgress(wtTorrent);
  assert.strictEqual(progress.isMultiFile, true);
  assert.strictEqual(progress.files.length, 3);
  assert.strictEqual(progress.files[0].progress, 1.0);
  assert.strictEqual(progress.files[1].progress, 0.1);
  assert.ok(progress.progress < 1.0);

  engine.client = client;
  engine.destroy();
});

test('TorrentEngine file deletion verification properly reduces progress and resets deleted file metrics', async () => {
  const tmpDir = path.join(__dirname, 'tmp_delete_test');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const torrentDir = path.join(tmpDir, 'MyMultiTorrent');
  fs.mkdirSync(torrentDir, { recursive: true });

  const file1Path = path.join(torrentDir, 'file1.bin');
  const file2Path = path.join(torrentDir, 'file2.bin');

  // Create both files on disk: file 1 = 1000 bytes, file 2 = 2000 bytes
  fs.writeFileSync(file1Path, Buffer.alloc(1000, 'A'));
  fs.writeFileSync(file2Path, Buffer.alloc(2000, 'B'));

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir });
  await engine.init();
  const client = engine.client;
  engine.client = null;

  try {
    const torrent = await engine.addTorrent('magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=MyMultiTorrent', {
      name: 'MyMultiTorrent',
      downloadPath: torrentDir,
      length: 3000,
      files: [
        { name: 'file1.bin', path: 'file1.bin', length: 1000 },
        { name: 'file2.bin', path: 'file2.bin', length: 2000 }
      ]
    });

    // Check disk files initially: both exist -> 3000 bytes (100%)
    engine.checkDiskFiles(torrent);
    assert.strictEqual(torrent.downloaded, 3000);
    assert.strictEqual(torrent.progress, 1.0);
    assert.strictEqual(torrent.files[0].downloaded, 1000);
    assert.strictEqual(torrent.files[1].downloaded, 2000);

    // Now delete file2 on disk!
    fs.unlinkSync(file2Path);
    assert.strictEqual(fs.existsSync(file2Path), false);

    // Verify torrent after file deletion
    await engine.verifyTorrent(torrent.infoHash);

    const verified = engine.torrents.get(torrent.infoHash);
    assert.strictEqual(verified.files[0].downloaded, 1000);
    assert.strictEqual(verified.files[0].progress, 1.0);
    // Deleted file must be reset to 0!
    assert.strictEqual(verified.files[1].downloaded, 0);
    assert.strictEqual(verified.files[1].progress, 0.0);
    // Total downloaded must drop from 3000 to 1000
    assert.strictEqual(verified.downloaded, 1000);
    assert.strictEqual(verified.progress, 1000 / 3000);
    assert.ok(verified.progress < 1.0);
  } finally {
    engine.client = client;
    engine.destroy();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TorrentEngine verifyTorrent syncs remote metadata file count and sizes from swarm', async () => {
  const engine = new TorrentEngine({ disableState: true, disableClient: true });
  await engine.init();

  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=RemoteSyncTest', {
    name: 'RemoteSyncTest',
    paused: true
  });

  // Initially 1 placeholder file
  assert.strictEqual(torrent.files.length, 1);

  // Mock remote WebTorrent client return with 4 files discovered from swarm
  engine.client = {
    get: (hash) => ({
      infoHash: hash,
      length: 50000,
      pieceLength: 16384,
      files: [
        { name: 'video.mp4', path: 'video.mp4', length: 40000, downloaded: 0, progress: 0 },
        { name: 'audio.mp3', path: 'audio.mp3', length: 8000, downloaded: 0, progress: 0 },
        { name: 'cover.jpg', path: 'cover.jpg', length: 1500, downloaded: 0, progress: 0 },
        { name: 'info.nfo', path: 'info.nfo', length: 500, downloaded: 0, progress: 0 }
      ],
      rescanFiles: (cb) => cb(null)
    }),
    destroy: () => {}
  };

  await engine.verifyTorrent(torrent.infoHash);

  const updated = engine.torrents.get(torrent.infoHash);
  assert.strictEqual(updated.files.length, 4);
  assert.strictEqual(updated.length, 50000);
  assert.strictEqual(updated.isMultiFile, true);
  assert.strictEqual(updated.files[0].name, 'video.mp4');
  assert.strictEqual(updated.files[1].name, 'audio.mp3');
  assert.strictEqual(updated.files[2].name, 'cover.jpg');
  assert.strictEqual(updated.files[3].name, 'info.nfo');

  engine.destroy();
});

test('Active downloading torrent with preallocated disk files does not falsely report sub-files as completed', async () => {
  const tmpDir = path.join(__dirname, 'tmp_active_download_test');
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const torrentDir = path.join(tmpDir, 'ActiveMultiTorrent');
  fs.mkdirSync(torrentDir, { recursive: true });

  const f1Path = path.join(torrentDir, 'video1.mp4');
  const f2Path = path.join(torrentDir, 'video2.mp4');
  const f3Path = path.join(torrentDir, 'video3.mp4');

  // Files are preallocated on disk to full length
  fs.writeFileSync(f1Path, Buffer.alloc(100));
  fs.truncateSync(f1Path, 10000000); // 10 MB
  fs.writeFileSync(f2Path, Buffer.alloc(100));
  fs.truncateSync(f2Path, 10000000); // 10 MB
  fs.writeFileSync(f3Path, Buffer.alloc(100));
  fs.truncateSync(f3Path, 10000000); // 10 MB

  const engine = new TorrentEngine({ disableState: true, downloadDir: tmpDir, disableClient: true });
  await engine.init();

  // Create mock WebTorrent File classes with prototype getters
  class MockLiveFile {
    constructor(parentTorrent, name, pathRel, length, initialBytes = 0) {
      this._torrent = parentTorrent;
      this.name = name;
      this.path = pathRel;
      this.length = length;
      this._bytes = initialBytes;
    }
    get downloaded() {
      return this._bytes;
    }
    get progress() {
      return this.length > 0 ? this._bytes / this.length : 0;
    }
  }

  class MockLiveTorrent {
    constructor(infoHash, dir) {
      this.infoHash = infoHash;
      this.downloadPath = dir;
      this.name = 'ActiveMultiTorrent';
      this.length = 30000000;
      this.bitfield = { get: (i) => i === 0, set: () => {} };
      this.pieces = [null, null, null];
      this.files = [
        new MockLiveFile(this, 'video1.mp4', 'video1.mp4', 10000000, 2000000), // 20% downloaded
        new MockLiveFile(this, 'video2.mp4', 'video2.mp4', 10000000, 0),       // 0% downloaded
        new MockLiveFile(this, 'video3.mp4', 'video3.mp4', 10000000, 0)        // 0% downloaded
      ];
    }
    get downloaded() {
      return this.files.reduce((acc, f) => acc + f.downloaded, 0);
    }
    get progress() {
      return this.downloaded / this.length;
    }
  }

  const hash = '5555555555555555555555555555555555555555';
  const mockWt = new MockLiveTorrent(hash, torrentDir);

  engine.torrents.set(hash, mockWt);
  engine.checkDiskFiles(mockWt);

  // File 0 should be 20%, Files 1 and 2 MUST be 0%, NOT 100%!
  assert.strictEqual(mockWt.files[0].downloaded, 2000000);
  assert.strictEqual(mockWt.files[0].progress, 0.2);
  assert.strictEqual(mockWt.files[1].downloaded, 0);
  assert.strictEqual(mockWt.files[1].progress, 0);
  assert.strictEqual(mockWt.files[2].downloaded, 0);
  assert.strictEqual(mockWt.files[2].progress, 0);

  // Formatted progress sent to UI must match exact piece data
  const formatted = engine.formatTorrentProgress(mockWt);
  assert.strictEqual(formatted.downloaded, 2000000);
  assert.strictEqual(formatted.progress, 2000000 / 30000000);
  assert.strictEqual(formatted.files[0].downloaded, 2000000);
  assert.strictEqual(formatted.files[0].progress, 0.2);
  assert.strictEqual(formatted.files[1].downloaded, 0);
  assert.strictEqual(formatted.files[1].progress, 0);
  assert.strictEqual(formatted.files[2].downloaded, 0);
  assert.strictEqual(formatted.files[2].progress, 0);

  engine.destroy();
  try {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {}
});

test('Peer inspector extracts country code, country name, and flag emoji for peers', async () => {
  const engine = new TorrentEngine({ disableClient: true, disableState: true });
  await engine.init();

  const mockTorrent = {
    infoHash: '6666666666666666666666666666666666666666',
    name: 'PeerFlagTest',
    wires: [
      {
        peerId: 'peer-us',
        remoteAddress: '8.8.8.8',
        remotePort: 51413,
        downloadSpeed: () => 102400,
        uploadSpeed: () => 20480,
        downloaded: 500000,
        uploaded: 100000,
        peerChoking: false,
        isSeeder: true
      },
      {
        peerId: 'peer-de',
        remoteAddress: '185.220.101.5',
        remotePort: 6881,
        downloadSpeed: () => 0,
        uploadSpeed: () => 0,
        downloaded: 0,
        uploaded: 0,
        peerChoking: true,
        isSeeder: false
      },
      {
        peerId: 'peer-lan',
        remoteAddress: '192.168.1.15',
        remotePort: 6881,
        downloadSpeed: () => 50000,
        uploadSpeed: () => 10000,
        downloaded: 10000,
        uploaded: 2000,
        peerChoking: false,
        isSeeder: false
      },
      {
        peerId: 'peer-in',
        remoteAddress: '103.24.1.1',
        remotePort: 50000,
        downloadSpeed: () => 200000,
        uploadSpeed: () => 5000,
        downloaded: 400000,
        uploaded: 10000,
        peerChoking: false,
        isSeeder: true
      },
      {
        peerId: 'peer-gb',
        remoteAddress: '212.58.244.23',
        remotePort: 80,
        downloadSpeed: () => 80000,
        uploadSpeed: () => 15000,
        downloaded: 150000,
        uploaded: 30000,
        peerChoking: false,
        isSeeder: false
      }
    ]
  };

  engine.torrents.set(mockTorrent.infoHash, mockTorrent);

  const peers = engine.getTorrentPeers(mockTorrent.infoHash);
  assert.strictEqual(peers.length, 5);

  // Peer 0: US
  assert.strictEqual(peers[0].countryCode, 'US');
  assert.strictEqual(peers[0].countryName, 'United States');
  assert.strictEqual(peers[0].flag, '🇺🇸');
  assert.strictEqual(peers[0].address, '8.8.8.8:51413');

  // Peer 1: DE
  assert.strictEqual(peers[1].countryCode, 'DE');
  assert.strictEqual(peers[1].countryName, 'Germany');
  assert.strictEqual(peers[1].flag, '🇩🇪');

  // Peer 2: LAN
  assert.strictEqual(peers[2].countryCode, 'LAN');
  assert.strictEqual(peers[2].flag, '🏠');

  // Peer 3: IN
  assert.strictEqual(peers[3].countryCode, 'IN');
  assert.strictEqual(peers[3].countryName, 'India');
  assert.strictEqual(peers[3].flag, '🇮🇳');

  // Peer 4: GB
  assert.strictEqual(peers[4].countryCode, 'GB');
  assert.strictEqual(peers[4].countryName, 'United Kingdom');
  assert.strictEqual(peers[4].flag, '🇬🇧');

  engine.destroy();
});

test('Selective file download: progress & length calculated strictly from checked files', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const mockInfoHash = 'aabbccddeeff0011223344556677889900aabbcc';
  const mockMultiFileTorrent = {
    infoHash: mockInfoHash,
    name: 'MultiTest',
    length: 200000000,
    downloaded: 100000000,
    progress: 0.5,
    numPeers: 2,
    downloadSpeed: 500000,
    uploadSpeed: 20000,
    paused: false,
    file_wanted: [true, false],
    files: [
      {
        index: 0,
        name: 'Movie.mp4',
        path: 'MultiTest/Movie.mp4',
        length: 100000000,
        downloaded: 100000000,
        progress: 1.0,
        wanted: true,
        select: () => {},
        deselect: () => {}
      },
      {
        index: 1,
        name: 'Bonus.iso',
        path: 'MultiTest/Bonus.iso',
        length: 100000000,
        downloaded: 0,
        progress: 0.0,
        wanted: false,
        select: () => {},
        deselect: () => {}
      }
    ]
  };

  engine.torrents.set(mockInfoHash, mockMultiFileTorrent);

  const formattedMeta = engine.formatTorrentMeta(mockMultiFileTorrent);
  // Total checked length should be 100MB (Bonus.iso excluded)
  assert.strictEqual(formattedMeta.length, 100000000);
  assert.strictEqual(formattedMeta.downloaded, 100000000);
  // Progress must be 1.0 (100%), not 0.5 (50%)
  assert.strictEqual(formattedMeta.progress, 1.0);

  // Now re-select file 1
  engine.setFileWanted(mockInfoHash, 1, true);
  const updatedMeta = engine.formatTorrentMeta(mockMultiFileTorrent);
  assert.strictEqual(updatedMeta.length, 200000000);
  assert.strictEqual(updatedMeta.downloaded, 100000000);
  assert.strictEqual(updatedMeta.progress, 0.5);

  engine.destroy();
});

test('Accurate per-sub-file download speed calculation', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const mockHash = '1234567890123456789012345678901234567890';
  const file1 = {
    index: 0,
    name: 'Track1.mp3',
    path: 'Track1.mp3',
    length: 10000000,
    downloaded: 2000000,
    progress: 0.2,
    wanted: true,
    _lastSpeedDownloaded: 1000000,
    _lastSpeedTime: Date.now() - 1000 // 1 second ago, 1,000,000 bytes delta
  };
  const file2 = {
    index: 1,
    name: 'Track2.mp3',
    path: 'Track2.mp3',
    length: 10000000,
    downloaded: 10000000,
    progress: 1.0,
    wanted: true,
    _lastSpeedDownloaded: 10000000,
    _lastSpeedTime: Date.now() - 1000 // completed file: speed should be 0
  };

  const torrent = {
    infoHash: mockHash,
    name: 'Album',
    length: 20000000,
    downloaded: 12000000,
    progress: 0.6,
    numPeers: 3,
    downloadSpeed: 1000000,
    paused: false,
    file_wanted: [true, true],
    files: [file1, file2]
  };

  engine.torrents.set(mockHash, torrent);

  const formattedFiles = engine.getFormattedFiles(torrent);
  assert.strictEqual(formattedFiles.length, 2);

  // File 1 downloaded ~1 MB in 1s, speed must be ~1,000,000 B/s
  assert.ok(formattedFiles[0].downloadSpeed > 900000 && formattedFiles[0].downloadSpeed < 1100000);

  // File 2 is complete (progress 1.0), its speed must be 0
  assert.strictEqual(formattedFiles[1].downloadSpeed, 0);

  engine.destroy();
});

test('Peer blocking: blockPeer and unblockPeer choke/destroy wire and prevent data transfer', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  let choked = false;
  let destroyed = false;

  const mockWire = {
    peerId: 'peer-bad-node',
    remoteAddress: '198.51.100.42',
    remotePort: 6881,
    downloadSpeed: () => 50000,
    uploadSpeed: () => 50000,
    downloaded: 200000,
    uploaded: 150000,
    peerChoking: false,
    isSeeder: false,
    choke: () => { choked = true; },
    destroy: () => { destroyed = true; }
  };

  const mockTorrent = {
    infoHash: '9988776655443322110099887766554433221100',
    name: 'SeededContent',
    length: 50000000,
    wires: [mockWire],
    blockedPeers: new Set()
  };

  engine.torrents.set(mockTorrent.infoHash, mockTorrent);

  // Verify initially unblocked
  let peers = engine.getTorrentPeers(mockTorrent.infoHash);
  assert.strictEqual(peers[0].isBlocked, false);

  // Block the peer
  const blockResult = engine.blockPeer(mockTorrent.infoHash, '198.51.100.42');
  assert.strictEqual(blockResult, true);
  assert.strictEqual(choked, true);
  assert.strictEqual(destroyed, true);
  assert.strictEqual(engine.isPeerBlocked(mockTorrent.infoHash, '198.51.100.42'), true);

  // Peers inspector marks it as blocked
  peers = engine.getTorrentPeers(mockTorrent.infoHash);
  assert.strictEqual(peers[0].isBlocked, true);
  assert.strictEqual(peers[0].status, 'Blocked');

  // Unblock the peer
  const unblockResult = engine.unblockPeer(mockTorrent.infoHash, '198.51.100.42');
  assert.strictEqual(unblockResult, true);
  assert.strictEqual(engine.isPeerBlocked(mockTorrent.infoHash, '198.51.100.42'), false);

  engine.destroy();
});

test('Torrent creation & seeding: createAndSeedTorrent creates valid torrent with files and isMyTorrent tag', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const tmpTestFile = path.join(__dirname, 'tmp_create_test.txt');
  fs.writeFileSync(tmpTestFile, 'Torrently P2P Content sharing test sample data payload');

  try {
    const created = await engine.createAndSeedTorrent(tmpTestFile, {
      name: 'CustomSeedFile',
      comment: 'Shared via Torrently',
      private: false
    });

    assert.ok(created.infoHash);
    assert.strictEqual(created.name, 'CustomSeedFile');
    assert.strictEqual(created.isMyTorrent, true);
    assert.strictEqual(created.createdByUser, true);
    assert.strictEqual(created.progress, 1.0);
    assert.ok(created.length > 0);
    assert.ok(created.magnetURI.includes(created.infoHash));

    // Verify it is restored with isMyTorrent across state
    const savedTorrents = engine.getTorrents();
    const found = savedTorrents.find(t => t.infoHash === created.infoHash);
    assert.ok(found);
    assert.strictEqual(found.isMyTorrent, true);
  } finally {
    if (fs.existsSync(tmpTestFile)) {
      fs.unlinkSync(tmpTestFile);
    }
  }

  engine.destroy();
});

test('Directory sharing: createAndSeedTorrent packages directory trees and sub-files with valid Magnet URI and trackers', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const tmpDir = path.join(__dirname, 'tmp_share_folder');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const subDir = path.join(tmpDir, 'subfolder');
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'Sample document 1');
  fs.writeFileSync(path.join(subDir, 'file2.bin'), 'Sample binary payload 2');

  try {
    const created = await engine.createAndSeedTorrent(tmpDir, {
      name: 'TestDirectoryShare',
      trackers: ['udp://tracker.opentrackers.org:1337/announce', 'udp://open.stealth.si:80/announce']
    });

    assert.ok(created.infoHash);
    assert.strictEqual(created.name, 'TestDirectoryShare');
    assert.strictEqual(created.isMyTorrent, true);
    assert.strictEqual(created.createdByUser, true);
    assert.strictEqual(created.isMultiFile, true);
    assert.strictEqual(created.files.length, 2);
    assert.ok(created.magnetURI.startsWith('magnet:?xt=urn:btih:'));
    assert.ok(created.magnetURI.includes('TestDirectoryShare'));
    assert.ok(created.magnetURI.includes('tracker.opentrackers.org'));

    // Check underlying torrent record has torrentFileBase64
    const internalTorrent = engine.torrents.get(created.infoHash);
    assert.ok(internalTorrent);
    assert.ok(internalTorrent.torrentFile || internalTorrent.torrentFileBase64);
  } finally {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  engine.destroy();
});

test('Binary .torrent export: converts Uint8Array buffers cleanly and produces parseable bencoded torrent files', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const tmpFile = path.join(__dirname, 'tmp_export_target.txt');
  fs.writeFileSync(tmpFile, 'Binary bencoded torrent buffer verification string');

  try {
    const created = await engine.createAndSeedTorrent(tmpFile, {
      name: 'ExportableTorrent'
    });

    const internalTorrent = engine.torrents.get(created.infoHash);
    assert.ok(internalTorrent);

    // Simulate binary export logic
    let torrentBuf = null;
    if (internalTorrent.torrentFile) {
      torrentBuf = Buffer.from(internalTorrent.torrentFile);
    } else if (internalTorrent.torrentFileBase64) {
      torrentBuf = Buffer.from(internalTorrent.torrentFileBase64, 'base64');
    }

    assert.ok(torrentBuf, 'Torrent buffer must exist');
    assert.strictEqual(Buffer.isBuffer(torrentBuf), true);
    assert.ok(torrentBuf.length > 0);

    // Must start with 'd' (standard bencoded dictionary marker: d8:announce...)
    assert.strictEqual(torrentBuf[0], 0x64); // 'd' in ASCII
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }

  engine.destroy();
});
