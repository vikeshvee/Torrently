const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const TorrentEngine = require('../src/main/engine');

test('Engine resolveTorrentPaths prevents nested folder duplication when path matches torrent name', async () => {
  const engine = new TorrentEngine({ disableClient: true, disableState: true });
  await engine.init();

  // Test 1: inputPath is parent folder, torrentName is subfolder
  const res1 = engine.resolveTorrentPaths('/Users/apple/Downloads', '/Users/apple/Downloads', 'MyTorrentMovie');
  assert.strictEqual(res1.targetPath, '/Users/apple/Downloads/MyTorrentMovie');
  assert.strictEqual(res1.baseFolder, '/Users/apple/Downloads');

  // Test 2: inputPath is already the exact torrent folder (e.g. from previous download or state)
  const res2 = engine.resolveTorrentPaths('/Users/apple/Downloads/MyTorrentMovie', '/Users/apple/Downloads', 'MyTorrentMovie');
  assert.strictEqual(res2.targetPath, '/Users/apple/Downloads/MyTorrentMovie');
  assert.strictEqual(res2.baseFolder, '/Users/apple/Downloads');

  // Test 3: inputPath ends with sanitized or lowercase variation
  const res3 = engine.resolveTorrentPaths('/Users/apple/Downloads/mytorrentmovie', '/Users/apple/Downloads', 'MyTorrentMovie');
  assert.strictEqual(res3.targetPath, '/Users/apple/Downloads/mytorrentmovie');
  assert.strictEqual(res3.baseFolder, '/Users/apple/Downloads');

  engine.destroy();
});

test('Engine emits loading-state during loadState lifecycle', async () => {
  const tmpState = path.join(os.tmpdir(), `test-loading-state-${Date.now()}.json`);
  fs.writeFileSync(tmpState, JSON.stringify([]));

  const engine = new TorrentEngine({
    disableClient: true,
    stateFilePath: tmpState
  });
  const loadingStates = [];
  engine.on('loading-state', state => loadingStates.push(state));

  await engine.init();
  assert.strictEqual(loadingStates.length >= 2, true, 'Must emit loading: true and loading: false');
  assert.strictEqual(loadingStates[0].loading, true);
  assert.strictEqual(loadingStates[loadingStates.length - 1].loading, false);

  engine.destroy();
  try { fs.unlinkSync(tmpState); } catch (e) {}
});

test('HTML and CSS have iOS-style switch controls, screen loading banner, and compact close buttons', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf8');

  // iOS switch components
  assert.strictEqual(html.includes('class="ios-switch"'), true, 'HTML must contain ios-switch');
  assert.strictEqual(html.includes('class="ios-slider"'), true, 'HTML must contain ios-slider');
  assert.strictEqual(css.includes('.ios-switch'), true, 'CSS must style .ios-switch');
  assert.strictEqual(css.includes('.ios-slider'), true, 'CSS must style .ios-slider');

  // Screen loading indicator
  assert.strictEqual(html.includes('id="screen-loading-indicator"'), true, 'HTML must have screen-loading-indicator');
  assert.strictEqual(css.includes('.screen-loading-indicator'), true, 'CSS must style .screen-loading-indicator');

  // Standardized modal close buttons
  assert.strictEqual(html.includes('class="modal-close-btn"'), true, 'HTML must use modal-close-btn');
  assert.strictEqual(css.includes('.modal-close-btn'), true, 'CSS must style .modal-close-btn');

  // Peer clickable style and clean status icon
  assert.strictEqual(css.includes('.clickable-peer-count'), true, 'CSS must style .clickable-peer-count');
  assert.strictEqual(css.includes('.status-icon-clean'), true, 'CSS must style .status-icon-clean');
});

test('Speed monitor header does not overlap macOS traffic light window controls', () => {
  const monCss = fs.readFileSync(path.join(__dirname, '../src/renderer/network-monitor.css'), 'utf8');
  assert.strictEqual(monCss.includes('padding-left: 78px;'), true, 'Network monitor header must have 78px left padding for traffic lights');
});

test('Package.json includes Debian target and dist:deb script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['dist:deb'], 'electron-builder --linux deb --arm64');
  assert.deepStrictEqual(pkg.build.linux.target, ['deb']);
});

test('Version number, in-app README section, and release key points are displayed in app', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

  // Version number matches package.json
  assert.strictEqual(pkg.version, '1.0.0');

  // Sidebar version pill
  assert.strictEqual(html.includes('id="btn-brand-version"'), true, 'Sidebar must have version pill button');
  assert.strictEqual(html.includes('v1.0.0'), true, 'Version number v1.0.0 must be visible in HTML');

  // Settings version card & release keypoints
  assert.strictEqual(html.includes('id="pref-card-version"'), true, 'Settings must have pref-card-version');
  assert.strictEqual(html.includes('Key Points of Release v1.0.0'), true, 'Release keypoints header must be present');
  assert.strictEqual(html.includes('version-keypoints-grid'), true, 'Keypoints grid must be present in settings');

  // Readme modal
  assert.strictEqual(html.includes('id="readme-modal"'), true, 'In-app README modal must exist');
  assert.strictEqual(html.includes('id="btn-readme-top"'), true, 'Top header must have readme/version button');

  // CSS styles
  assert.strictEqual(css.includes('.brand-version-pill'), true, 'CSS must style .brand-version-pill');
  assert.strictEqual(css.includes('.version-tag'), true, 'CSS must style .version-tag');
  assert.strictEqual(css.includes('.version-release-box'), true, 'CSS must style .version-release-box');
});
