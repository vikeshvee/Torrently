const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, spawn } = require('child_process');
const TorrentEngine = require('../src/main/engine');
const StreamServer = require('../src/main/streamServer');
const { request } = require('../src/cli');

test('Engine: auto-pauses when all files are deselected and auto-resumes when a file is selected', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:4444444444444444444444444444444444444444&dn=TestAutoPause', {
    name: 'TestAutoPause',
    paused: false
  });

  const wtTorrent = engine.torrents.get(torrent.infoHash);
  wtTorrent.files = [
    { name: 'file1.mp4', path: 'TestAutoPause/file1.mp4', length: 1000, downloaded: 500, progress: 0.5, select: () => {}, deselect: () => {} },
    { name: 'file2.mp4', path: 'TestAutoPause/file2.mp4', length: 2000, downloaded: 0, progress: 0.0, select: () => {}, deselect: () => {} }
  ];

  assert.strictEqual(wtTorrent.paused, false);

  // Deselect file 0 -> 1 file remains wanted -> should stay active
  engine.setFileWanted(torrent.infoHash, 0, false);
  assert.strictEqual(wtTorrent.paused, false);

  // Deselect file 1 -> 0 files wanted -> MUST auto-pause
  engine.setFileWanted(torrent.infoHash, 1, false);
  assert.strictEqual(wtTorrent.paused, true, 'Torrent should automatically pause when all files are deselected');

  // Select file 0 while paused -> MUST auto-resume
  engine.setFileWanted(torrent.infoHash, 0, true);
  assert.strictEqual(wtTorrent.paused, false, 'Torrent should automatically resume when a file is selected');

  // Ensure only file 0 is wanted, file 1 is still skipped
  const formatted = engine.getFormattedFiles(wtTorrent);
  assert.strictEqual(formatted[0].wanted, true);
  assert.strictEqual(formatted[1].wanted, false);

  engine.destroy();
});

test('Engine: strictly computes subfile completion and avoids false 100% rounding', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  const torrent = await engine.addTorrent('magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=TestAccuracy', {
    name: 'TestAccuracy',
    paused: false
  });

  const wtTorrent = engine.torrents.get(torrent.infoHash);
  wtTorrent.files = [
    // 99.8% done (not complete yet)
    { name: 'movie.mp4', path: 'TestAccuracy/movie.mp4', length: 10000, downloaded: 9980, progress: 0.998, select: () => {}, deselect: () => {} },
    // 100% done
    { name: 'subs.srt', path: 'TestAccuracy/subs.srt', length: 500, downloaded: 500, progress: 1.0, select: () => {}, deselect: () => {} }
  ];

  const formatted = engine.getFormattedFiles(wtTorrent);

  // File 0: not complete, progress must not report 1.0
  assert.strictEqual(formatted[0].isDone, false);
  assert.ok(formatted[0].progress < 1.0, 'Incomplete file progress must be strictly less than 1.0');
  assert.ok(formatted[0].progress <= 0.99, 'Incomplete file progress must be capped at 0.99 to prevent false 100% display');

  // File 1: complete
  assert.strictEqual(formatted[1].isDone, true);
  assert.strictEqual(formatted[1].progress, 1.0);

  engine.destroy();
});

test('StreamServer REST API & CLI integration', async () => {
  const engine = new TorrentEngine({ disableState: true });
  await engine.init();

  let testPrefs = { savePath: '/tmp', showInStatusBar: false };
  let statusBarToggled = false;

  const streamServer = new StreamServer(engine, {
    getPreferences: () => testPrefs,
    updatePreferences: (newPrefs) => {
      testPrefs = { ...testPrefs, ...newPrefs };
      return testPrefs;
    },
    toggleStatusBar: (enable) => {
      statusBarToggled = enable;
      testPrefs.showInStatusBar = enable;
      return { showInStatusBar: enable };
    }
  });

  const port = await streamServer.start();
  assert.ok(port > 0);

  try {
    // 1. GET /api/status
    const statusRes = await request('GET', '/api/status', null, port);
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.app, 'Torrently');
    assert.strictEqual(statusRes.data.port, port);

    // 2. POST /api/torrents/add
    const addRes = await request('POST', '/api/torrents/add', {
      torrentId: 'magnet:?xt=urn:btih:6666666666666666666666666666666666666666&dn=ApiTestTorrent',
      paused: false
    }, port);
    assert.strictEqual(addRes.status, 200);
    assert.ok(addRes.data.success);
    const infoHash = addRes.data.torrent.infoHash;
    assert.strictEqual(infoHash, '6666666666666666666666666666666666666666');

    // 3. GET /api/torrents
    const listRes = await request('GET', '/api/torrents', null, port);
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.data.torrents));
    assert.strictEqual(listRes.data.torrents.length, 1);
    assert.strictEqual(listRes.data.torrents[0].infoHash, infoHash);

    // 4. POST /api/torrents/:infoHash/pause
    const pauseRes = await request('POST', `/api/torrents/${infoHash}/pause`, {}, port);
    assert.strictEqual(pauseRes.status, 200);
    assert.strictEqual(pauseRes.data.paused, true);

    // 5. POST /api/torrents/:infoHash/resume
    const resumeRes = await request('POST', `/api/torrents/${infoHash}/resume`, {}, port);
    assert.strictEqual(resumeRes.status, 200);
    assert.strictEqual(resumeRes.data.paused, false);

    // 6. GET /api/preferences & POST /api/preferences
    const prefsRes = await request('GET', '/api/preferences', null, port);
    assert.strictEqual(prefsRes.status, 200);
    assert.strictEqual(prefsRes.data.preferences.showInStatusBar, false);

    const updatePrefsRes = await request('POST', '/api/preferences', { maxDownloadSpeed: 5000 }, port);
    assert.strictEqual(updatePrefsRes.status, 200);
    assert.strictEqual(testPrefs.maxDownloadSpeed, 5000);

    // 7. POST /api/status-bar
    const barRes = await request('POST', '/api/status-bar', { enable: true }, port);
    assert.strictEqual(barRes.status, 200);
    assert.strictEqual(statusBarToggled, true);
    assert.strictEqual(testPrefs.showInStatusBar, true);

    // 8. Test bin/torrently executable with CLI commands
    const cliBin = path.join(__dirname, '../bin/torrently');
    await new Promise((resolve, reject) => {
      execFile('node', [cliBin, 'list', '--json'], (err, stdout, stderr) => {
        if (err) return reject(err);
        const parsed = JSON.parse(stdout);
        assert.ok(Array.isArray(parsed));
        assert.strictEqual(parsed[0].infoHash, infoHash);
        resolve();
      });
    });

    // 9. POST /api/torrents/:infoHash/remove
    const rmRes = await request('POST', `/api/torrents/${infoHash}/remove`, { deleteFiles: false }, port);
    assert.strictEqual(rmRes.status, 200);
    assert.strictEqual(rmRes.data.removed, true);

  } finally {
    streamServer.stop();
    engine.destroy();
  }
});

test('cliInstaller: install, status check, execution, and uninstall lifecycle', async () => {
  const cliInstaller = require('../src/main/cliInstaller');

  const targetDir = cliInstaller.getTargetDir();
  assert.ok(targetDir);
  assert.ok(cliInstaller.isWritable(targetDir));

  // Install
  const installRes = cliInstaller.install();
  assert.strictEqual(installRes.success, true);
  assert.ok(fs.existsSync(installRes.path));

  // Verify file permissions (executable: 0o755)
  const stat = fs.statSync(installRes.path);
  assert.ok(stat.mode & 0o111, 'Installed CLI wrapper must be executable');

  // Verify getStatus
  const status = cliInstaller.getStatus();
  assert.strictEqual(status.installed, true);
  assert.strictEqual(status.path, installRes.path);

  // Verify executing the installed script
  await new Promise((resolve, reject) => {
    execFile(installRes.path, ['--help'], (err, stdout, stderr) => {
      if (err) return reject(err);
      assert.ok(stdout.includes('Torrently CLI'));
      assert.ok(stdout.includes('COMMANDS:'));
      resolve();
    });
  });

  // Re-run autoInstallIfEnabled when already installed should be no-op
  const secondInstall = cliInstaller.autoInstallIfEnabled();
  assert.strictEqual(secondInstall, null);

  // Uninstall
  const uninstallRes = cliInstaller.uninstall();
  assert.strictEqual(uninstallRes.success, true);
  assert.strictEqual(uninstallRes.removed, true);

  // Verify status after uninstall
  const statusAfter = cliInstaller.getStatus();
  assert.strictEqual(statusAfter.installed, false);

  // Re-install to keep system CLI active
  cliInstaller.install();
});

