const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const TorrentEngine = require('../src/main/engine');

test('User home state persistence preserves both in-progress and paused torrents', async () => {
  const homeDir = path.join(os.homedir(), '.torrently');
  const homeStateFile = path.join(homeDir, 'torrently-state.json');
  assert.strictEqual(fs.existsSync(homeStateFile), true, 'Home state file ~/.torrently/torrently-state.json must exist');

  const raw = fs.readFileSync(homeStateFile, 'utf8');
  const list = JSON.parse(raw);
  assert.strictEqual(Array.isArray(list), true, 'State must be an array of torrents');
  assert.strictEqual(list.length >= 10, true, 'All user torrents must be preserved (found ' + list.length + ')');

  // Verify paused torrents remain paused
  const pausedTorrents = list.filter(t => t.paused === true);
  assert.strictEqual(pausedTorrents.length > 0, true, 'Paused torrents must be preserved with paused: true');

  // Verify in-progress torrents have progress preserved
  const inProgress = list.filter(t => t.progress > 0 && t.progress < 1);
  assert.strictEqual(inProgress.length > 0, true, 'In-progress torrents must be preserved with progress > 0');

  // Verify engine can load this state directly
  const engine = new TorrentEngine({
    disableClient: true,
    stateFilePath: homeStateFile
  });
  await engine.init();
  const loaded = engine.getTorrents();
  assert.strictEqual(loaded.length >= list.length, true, 'Engine must load all torrents from user home');
  engine.destroy();
});

test('Magnet link sanitization handles inverted parameters and trailing punctuation', async () => {
  const engine = new TorrentEngine({ disableClient: true, disableState: true });
  await engine.init();
  
  // Test magnet with dn before xt and trailing period
  const raw1 = 'magnet:?dn=Test+Video&xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp://tracker.org:1337.';
  const added = await engine.addTorrent(raw1);
  assert.strictEqual(added.infoHash, '0123456789abcdef0123456789abcdef01234567', 'InfoHash extracted accurately');
  assert.strictEqual(added.name, 'Test Video', 'Torrent name extracted from dn');

  engine.destroy();
});

test('Top action bar buttons have no text names and are styled as 36px compact themed icon-only buttons', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/style.css'), 'utf8');

  // Extract header-actions block from html
  const headerMatch = html.match(/<div class="header-actions">([\s\S]*?)<\/header>/);
  assert.strictEqual(Boolean(headerMatch), true, 'header-actions must be in html');
  const headerHTML = headerMatch[1];

  // Verify buttons in header-actions do not have text spans
  assert.strictEqual(headerHTML.includes('<span>CLI</span>'), false, 'CLI button must not have text span');
  assert.strictEqual(headerHTML.includes('<span>Refresh</span>'), false, 'Refresh button must not have text span');
  assert.strictEqual(headerHTML.includes('<span>Open .torrent</span>'), false, 'Open .torrent button must not have text span');
  assert.strictEqual(headerHTML.includes('<span>Add Magnet Link</span>'), false, 'Add Magnet button must not have text span');
  assert.strictEqual(headerHTML.includes('<span>Share Files / Folders</span>'), false, 'Share button must not have text span');

  // Verify CSS styles header-actions buttons with 36px dimensions
  assert.strictEqual(css.includes('.header-actions .btn'), true, 'CSS must have .header-actions .btn');
  assert.strictEqual(css.includes('width: 36px;'), true, 'Buttons must have width: 36px');
  assert.strictEqual(css.includes('height: 36px;'), true, 'Buttons must have height: 36px');
});
