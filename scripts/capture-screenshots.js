// scripts/capture-screenshots.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const screenshotsDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  await win.loadFile(indexPath);

  // Inject rich state for screenshot 1 (Dashboard) & screenshot 2 (My Torrents)
  await win.webContents.executeJavaScript(`
    (() => {
      // Dark theme
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');

      // Update global speeds
      const dlSpeed = document.getElementById('global-dl-speed');
      if (dlSpeed) dlSpeed.textContent = '14.8 MB/s';
      const ulSpeed = document.getElementById('global-ul-speed');
      if (ulSpeed) ulSpeed.textContent = '2.4 MB/s';
      const netSpeed = document.getElementById('global-net-speed');
      if (netSpeed) netSpeed.textContent = '120 Mbps';

      // Mock sample downloading torrent
      const sampleTorrent = {
        infoHash: 'e4d7a8f9b2c3d1e0f5a6b7c8d9e0f1a2b3c4d5e6',
        name: 'Cosmos.Luminescence.2026.1080p.WEBRip.x264',
        progress: 0.684,
        percent: 68,
        length: 2450000000,
        totalSizeText: '2.45 GB',
        downloaded: 1675800000,
        downloadedText: '1.68 GB',
        uploaded: 420000000,
        uploadedText: '420 MB',
        downloadSpeed: 15500000,
        downSpeedText: '14.8 MB/s',
        uploadSpeed: 2500000,
        upSpeedText: '2.4 MB/s',
        numPeers: 42,
        timeRemainingText: '48s remaining',
        isPaused: false,
        isCompleted: false,
        files: [
          { index: 0, name: 'Cosmos.Luminescence.2026.mp4', length: 2350000000, sizeText: '2.35 GB', progress: 0.72, percent: 72, downloaded: 1692000000, downloadSpeed: 14200000, speedText: '14.2 MB/s', wanted: true, isPlayable: true },
          { index: 1, name: 'Cosmos.English.Subtitles.srt', length: 120000, sizeText: '120 KB', progress: 1.0, percent: 100, downloaded: 120000, downloadSpeed: 0, speedText: '0 B/s', wanted: true, isPlayable: false },
          { index: 2, name: 'Soundtrack_Theme.mp3', length: 18500000, sizeText: '18.5 MB', progress: 0.85, percent: 85, downloaded: 15725000, downloadSpeed: 600000, speedText: '600 KB/s', wanted: true, isPlayable: true },
          { index: 3, name: 'Artwork_Cover_Poster.jpg', length: 4500000, sizeText: '4.5 MB', progress: 0.35, percent: 35, downloaded: 1575000, downloadSpeed: 0, speedText: '0 B/s', wanted: false, isPlayable: false }
        ]
      };

      // Mock user created torrent for My Torrents tab
      const myTorrent = {
        infoHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        name: 'OpenSource_AI_Models_Dataset_Bundle',
        progress: 1.0,
        percent: 100,
        length: 8500000000,
        totalSizeText: '8.50 GB',
        downloaded: 8500000000,
        downloadedText: '8.50 GB',
        uploaded: 18400000000,
        uploadedText: '18.4 GB',
        downloadSpeed: 0,
        downSpeedText: '0 B/s',
        uploadSpeed: 4200000,
        upSpeedText: '4.2 MB/s',
        numPeers: 19,
        isMyTorrent: true,
        createdByUser: true,
        isPaused: false,
        isCompleted: true,
        files: [
          { index: 0, name: 'raw_sensor_telemetry.parquet', length: 5000000000, sizeText: '5.00 GB', progress: 1.0, percent: 100, wanted: true },
          { index: 1, name: 'deep_learning_weights.safetensors', length: 3500000000, sizeText: '3.50 GB', progress: 1.0, percent: 100, wanted: true }
        ]
      };

      if (typeof renderTorrentCard === 'function') {
        renderTorrentCard(sampleTorrent);
        renderTorrentCard(myTorrent);
      }

      // Automatically expand files accordion
      const acc = document.querySelector('.torrent-files-accordion');
      if (acc) acc.classList.add('open');
      const toggleBtn = document.querySelector('.btn-toggle-files');
      if (toggleBtn) toggleBtn.textContent = '📁 Files (4) ▴';

      if (typeof updateCounts === 'function') updateCounts();
    })();
  `);

  await new Promise(r => setTimeout(r, 600));

  // 1. Capture Dashboard / Downloads View
  const imgDashboard = await win.capturePage();
  fs.writeFileSync(path.join(screenshotsDir, 'dashboard-downloads.png'), imgDashboard.toPNG());
  console.log('Saved dashboard-downloads.png');

  // 2. Open My Torrents Tab & Capture
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = document.querySelector('.nav-tab[data-tab="my-torrents"]');
      if (tab) tab.click();
    })();
  `);
  await new Promise(r => setTimeout(r, 400));
  const imgMyTorrents = await win.capturePage();
  fs.writeFileSync(path.join(screenshotsDir, 'my-torrents.png'), imgMyTorrents.toPNG());
  console.log('Saved my-torrents.png');

  // 3. Open Create Torrent Modal & Capture
  await win.webContents.executeJavaScript(`
    (() => {
      const modal = document.getElementById('create-torrent-modal');
      if (modal) {
        modal.classList.add('active');
        const preview = document.getElementById('create-source-preview');
        if (preview) {
          preview.innerHTML = '<div style="font-weight:600; color:#38BDF8;">📁 /Users/alex/Projects/OpenSource_AI_Models</div><div style="font-size:11px; color:#94A3B8;">8 files, 2 directories (8.50 GB)</div>';
        }
        const nameInput = document.getElementById('create-torrent-name');
        if (nameInput) nameInput.value = 'OpenSource_AI_Models_Dataset_Bundle';
      }
    })();
  `);
  await new Promise(r => setTimeout(r, 400));
  const imgCreateTorrent = await win.capturePage();
  fs.writeFileSync(path.join(screenshotsDir, 'create-torrent-modal.png'), imgCreateTorrent.toPNG());
  console.log('Saved create-torrent-modal.png');

  // 4. Close Create Torrent Modal and Open Swarm Inspector Modal & Capture
  await win.webContents.executeJavaScript(`
    (() => {
      const createModal = document.getElementById('create-torrent-modal');
      if (createModal) createModal.classList.remove('active');

      const peersModal = document.getElementById('peers-modal');
      if (peersModal) {
        peersModal.classList.add('active');
        const title = document.getElementById('peers-torrent-name');
        if (title) title.textContent = 'Cosmos.Luminescence.2026.1080p.WEBRip.x264';
        const badge = document.getElementById('peers-count-badge');
        if (badge) badge.textContent = '4 Peers Connected';
        const tbody = document.getElementById('peers-table-body');
        if (tbody) {
          tbody.innerHTML = \`
            <div class="peer-row">
              <span class="col-peer-addr"><span class="peer-flag" title="United States">🇺🇸</span> 192.0.2.45:51413</span>
              <span class="col-peer-type">Transmission 4.0</span>
              <span class="col-peer-speed" style="color:#10B981; font-weight:600;">4.8 MB/s</span>
              <span class="col-peer-speed" style="color:#38BDF8;">820 KB/s</span>
              <span class="col-peer-data">1.24 GB</span>
              <span class="col-peer-status" style="color:#10B981;">Downloading</span>
              <span class="col-peer-action"><button class="btn-peer-block">Block Node</button></span>
            </div>
            <div class="peer-row">
              <span class="col-peer-addr"><span class="peer-flag" title="Germany">🇩🇪</span> 198.51.100.12:6881</span>
              <span class="col-peer-type">qBittorrent 4.6</span>
              <span class="col-peer-speed" style="color:#10B981; font-weight:600;">6.2 MB/s</span>
              <span class="col-peer-speed" style="color:#38BDF8;">150 KB/s</span>
              <span class="col-peer-data">850 MB</span>
              <span class="col-peer-status" style="color:#10B981;">Seeding</span>
              <span class="col-peer-action"><button class="btn-peer-block">Block Node</button></span>
            </div>
            <div class="peer-row">
              <span class="col-peer-addr"><span class="peer-flag" title="India">🇮🇳</span> 203.0.113.88:51413</span>
              <span class="col-peer-type">Torrently 1.0</span>
              <span class="col-peer-speed" style="color:#10B981; font-weight:600;">3.8 MB/s</span>
              <span class="col-peer-speed" style="color:#38BDF8;">1.4 MB/s</span>
              <span class="col-peer-data">480 MB</span>
              <span class="col-peer-status" style="color:#10B981;">Downloading</span>
              <span class="col-peer-action"><button class="btn-peer-block">Block Node</button></span>
            </div>
            <div class="peer-row">
              <span class="col-peer-addr"><span class="peer-flag" title="United Kingdom">🇬🇧</span> 198.51.100.210:6889</span>
              <span class="col-peer-type">WebTorrent 3.0</span>
              <span class="col-peer-speed">0 B/s</span>
              <span class="col-peer-speed">0 B/s</span>
              <span class="col-peer-data">34 MB</span>
              <span class="col-peer-status" style="color:#EF4444;">Blocked</span>
              <span class="col-peer-action"><button class="btn-peer-unblock">Unblock</button></span>
            </div>
          \`;
        }
      }
    })();
  `);
  await new Promise(r => setTimeout(r, 400));
  const imgPeers = await win.capturePage();
  fs.writeFileSync(path.join(screenshotsDir, 'peers-inspector.png'), imgPeers.toPNG());
  console.log('Saved peers-inspector.png');

  app.quit();
});
