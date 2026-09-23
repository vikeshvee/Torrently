const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { expandPath } = require('./paths');

function getFfmpegPath() {
  try {
    let ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      if (ffmpegStatic.includes('app.asar')) {
        const unpacked = ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
        if (fs.existsSync(unpacked)) return unpacked;
      }
      if (fs.existsSync(ffmpegStatic)) {
        return ffmpegStatic;
      }
    }
  } catch (e) {}

  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

class StreamServer {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.options = options;
    this.server = null;
    this.port = options.port || (process.env.TORRENTLY_TEST_SANDBOX === '1' ? 0 : 8888);
    this.activeTranscodeProcesses = new Set();
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
        if (url.pathname.startsWith('/transcode/')) {
          this.handleTranscodeRequest(req, res, url);
        } else if (url.pathname.startsWith('/raw/')) {
          this.handleRawStreamRequest(req, res, url);
        } else if (url.pathname.startsWith('/stream/')) {
          this.handleStreamRequest(req, res, url);
        } else if (url.pathname.startsWith('/api/')) {
          await this.handleApiRequest(req, res, url);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Torrently Endpoint Not Found');
        }
      });

      const tryListen = (attemptPort) => {
        this.server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.warn(`[Torrently Stream Server] Port ${attemptPort} in use. Retrying next available port...`);
            tryListen(attemptPort + 1);
          } else {
            console.error('[Torrently Stream Server] Error starting HTTP server:', err.message);
            resolve(attemptPort);
          }
        });

        this.server.listen(attemptPort, '127.0.0.1', () => {
          const boundPort = this.server.address().port;
          this.port = boundPort;
          this.savePortFile();
          console.log(`[Torrently Stream Server] Listening at http://127.0.0.1:${boundPort}`);
          resolve(boundPort);
        });
      };

      tryListen(this.port);
    });
  }

  savePortFile() {
    try {
      const dir = path.join(os.homedir(), '.torrently');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const apiFile = path.join(dir, 'api.json');
      if (fs.existsSync(apiFile)) {
        try {
          const current = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
          if (current && current.pid && current.pid !== process.pid) {
            try {
              process.kill(current.pid, 0);
              // Existing process is alive and owns api.json; do not hijack it
              return;
            } catch (e) {
              // Dead process, safe to claim
            }
          }
        } catch (e) {}
      }
      fs.writeFileSync(apiFile, JSON.stringify({
        port: this.port,
        pid: process.pid,
        url: `http://127.0.0.1:${this.port}`
      }, null, 2));
    } catch (e) {
      console.warn('[Torrently Stream Server] Could not write api.json:', e.message);
    }
  }

  removePortFile() {
    try {
      const portFile = path.join(os.homedir(), '.torrently', 'api.json');
      if (fs.existsSync(portFile)) {
        const data = JSON.parse(fs.readFileSync(portFile, 'utf8'));
        if (data.pid === process.pid) {
          fs.unlinkSync(portFile);
        }
      }
    } catch (e) {}
  }

  getMimeType(fileName) {
    if (!fileName) return 'application/octet-stream';
    const ext = path.extname(fileName).toLowerCase();
    switch (ext) {
      case '.mkv':
        return 'video/x-matroska';
      case '.mp4':
      case '.m4v':
        return 'video/mp4';
      case '.webm':
        return 'video/webm';
      case '.avi':
        return 'video/x-msvideo';
      case '.mov':
        return 'video/quicktime';
      case '.mp3':
        return 'audio/mpeg';
      case '.wav':
        return 'audio/wav';
      case '.flac':
        return 'audio/flac';
      default:
        return 'application/octet-stream';
    }
  }

  handleStreamRequest(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const infoHash = (parts[1] || '').toLowerCase();
    const fileIndex = parseInt(parts[2] || '0', 10);

    const torrent = this.engine ? (this.engine.torrents.get(infoHash) || Array.from(this.engine.torrents.values()).find(t => (t.infoHash || '').toLowerCase() === infoHash)) : null;
    if (!torrent) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Torrent not found or still connecting');
      return;
    }

    const file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File index not found in torrent');
      return;
    }

    // Auto-transcode if file uses codecs or containers unsupported by Chromium (AC3, HEVC, AVI, etc.)
    // or if explicitly requested via ?transcode=1
    const forceTranscode = url.searchParams.get('transcode') === '1';
    const forceRaw = url.searchParams.get('raw') === '1';
    if (!forceRaw && (forceTranscode || this.shouldAutoTranscode(file.name))) {
      this.handleTranscodeRequest(req, res, url);
      return;
    }

    // Fast-path: If file is already fully on disk, stream directly from disk
    const diskPath = this.resolveDiskPath(torrent, file);
    if (diskPath && fs.existsSync(diskPath)) {
      try {
        const stat = fs.statSync(diskPath);
        if (stat.isFile() && file.length > 0 && stat.size >= file.length) {
          this.streamFromDisk(req, res, diskPath, file.name || torrent.name);
          return;
        }
      } catch (e) {}
    }

    if (typeof file.createReadStream === 'function') {
      this.streamFromWebTorrentFile(req, res, file);
      return;
    }

    if (diskPath && fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
      this.streamFromDisk(req, res, diskPath, file.name || torrent.name);
      return;
    }

    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('File not available yet. Wait for download to start.');
  }

  shouldAutoTranscode(fileName) {
    if (!fileName || typeof fileName !== 'string') return false;
    const ext = path.extname(fileName).toLowerCase();
    const nonNativeExts = [
      '.avi', '.wmv', '.flv', '.divx', '.xvid', '.ts', '.vob',
      '.m2ts', '.mts', '.mpg', '.mpeg', '.asf', '.rm', '.rmvb', '.3gp'
    ];
    if (nonNativeExts.includes(ext)) return true;

    // Detect AC3, EAC3, DTS, HEVC, H265, X265, 10bit in filename tokens
    if (/[\.\-_\s\[\(](ac3|eac3|dts|dtshd|truehd|hevc|h265|x265|10bit)[\.\-_\s\]\)]/i.test(fileName)) {
      return true;
    }

    return false;
  }

  handleRawStreamRequest(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const infoHash = (parts[1] || '').toLowerCase();
    const fileIndex = parseInt(parts[2] || '0', 10);

    const torrent = this.engine ? (this.engine.torrents.get(infoHash) || Array.from(this.engine.torrents.values()).find(t => (t.infoHash || '').toLowerCase() === infoHash)) : null;
    if (!torrent) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Torrent not found or still connecting');
      return;
    }

    const file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File index not found in torrent');
      return;
    }

    const diskPath = this.resolveDiskPath(torrent, file);
    if (diskPath && fs.existsSync(diskPath)) {
      try {
        const stat = fs.statSync(diskPath);
        if (stat.isFile() && file.length > 0 && stat.size >= file.length) {
          this.streamFromDisk(req, res, diskPath, file.name || torrent.name);
          return;
        }
      } catch (e) {}
    }

    if (typeof file.createReadStream === 'function') {
      this.streamFromWebTorrentFile(req, res, file);
      return;
    }

    if (diskPath && fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
      this.streamFromDisk(req, res, diskPath, file.name || torrent.name);
      return;
    }

    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('File not available yet. Wait for download to start.');
  }

  handleTranscodeRequest(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean);
    const infoHash = (parts[1] || '').toLowerCase();
    const fileIndex = parseInt(parts[2] || '0', 10);
    const startTime = parseFloat(url.searchParams.get('start') || '0') || 0;
    const requestedMode = url.searchParams.get('mode') || 'auto';

    const torrent = this.engine ? (this.engine.torrents.get(infoHash) || Array.from(this.engine.torrents.values()).find(t => (t.infoHash || '').toLowerCase() === infoHash)) : null;
    if (!torrent) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Torrent not found or still connecting');
      return;
    }

    const file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File index not found in torrent');
      return;
    }

    if (typeof file.select === 'function') {
      try { file.select(); } catch (e) {}
    }

    const diskPath = this.resolveDiskPath(torrent, file);
    const isFileOnDisk = diskPath && fs.existsSync(diskPath) && fs.statSync(diskPath).size >= (file.length || 1);

    const inputSource = isFileOnDisk
      ? diskPath
      : `http://127.0.0.1:${this.port}/raw/${infoHash}/${fileIndex}`;

    const ffmpegBin = getFfmpegPath();
    if (!ffmpegBin) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('FFmpeg binary not available for transcoding');
      return;
    }

    const ext = path.extname(file.name || '').toLowerCase();
    const isNonNativeContainer = ['.avi', '.wmv', '.flv', '.divx', '.xvid', '.ts', '.vob', '.mpg', '.mpeg', '.asf', '.rm', '.rmvb'].includes(ext);
    const isHevc = /[\.\-_\s\[\(](hevc|h265|x265|10bit)[\.\-_\s\]\)]/i.test(file.name || '');

    const args = [
      '-hide_banner',
      '-loglevel', 'error'
    ];

    if (startTime > 0) {
      args.push('-ss', startTime.toString());
    }

    args.push('-i', inputSource);

    if (requestedMode === 'full' || isHevc || isNonNativeContainer) {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '22',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2'
      );
    } else {
      args.push(
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2'
      );
    }

    args.push(
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    );

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.activeTranscodeProcesses.add(proc);

    proc.stdout.pipe(res);

    const cleanup = () => {
      this.activeTranscodeProcesses.delete(proc);
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch (e) {}
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
    proc.on('close', cleanup);
    proc.on('error', (err) => {
      cleanup();
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Transcode process error: ' + err.message);
      }
    });
  }

  resolveDiskPath(torrent, file) {
    const downloadPath = expandPath(torrent.downloadPath);
    if (!downloadPath) return null;

    if (torrent.isMultiFile || (torrent.files && torrent.files.length > 1)) {
      return path.join(downloadPath, file.path || file.name);
    }

    if (fs.existsSync(downloadPath) && fs.statSync(downloadPath).isFile()) {
      return downloadPath;
    }

    const candidate = path.join(path.dirname(downloadPath), file.name || path.basename(downloadPath));
    if (fs.existsSync(candidate)) return candidate;

    return downloadPath;
  }

  streamFromWebTorrentFile(req, res, file) {
    // Prioritize streaming chunks in WebTorrent
    if (typeof file.select === 'function') {
      try {
        file.select();
      } catch (e) {}
    }

    const fileSize = file.length;
    const mimeType = file.mime || this.getMimeType(file.name);
    const range = req.headers.range;

    if (range) {
      const rangeParts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(rangeParts[0], 10);
      const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
      });

      file.createReadStream({ start, end }).on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      file.createReadStream().on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).pipe(res);
    }
  }

  streamFromDisk(req, res, diskPath, fileName) {
    const stat = fs.statSync(diskPath);
    const fileSize = stat.size;
    const mimeType = this.getMimeType(fileName);
    const range = req.headers.range;

    if (range) {
      const rangeParts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(rangeParts[0], 10);
      const end = rangeParts[1] ? parseInt(rangeParts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType
      });

      fs.createReadStream(diskPath, { start, end }).on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(diskPath).on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }).pipe(res);
    }
  }

  // Helper to send JSON responses
  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data, null, 2));
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 20 * 1024 * 1024) {
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve({ raw: body });
        }
      });
      req.on('error', reject);
    });
  }

  async handleApiRequest(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '');
    const method = req.method.toUpperCase();

    try {
      // GET /api/status
      if (pathname === '/api/status' && method === 'GET') {
        const activeTorrents = this.engine ? this.engine.getTorrents() : [];
        return this.sendJson(res, 200, {
          success: true,
          app: 'Torrently',
          version: '1.0.0',
          pid: process.pid,
          port: this.port,
          torrentsCount: activeTorrents.length
        });
      }

      // GET /api/torrents
      if (pathname === '/api/torrents' && method === 'GET') {
        const torrents = this.engine ? this.engine.getTorrents() : [];
        return this.sendJson(res, 200, { success: true, torrents });
      }

      // POST /api/torrents/add
      if (pathname === '/api/torrents/add' && method === 'POST') {
        const body = await this.readBody(req);
        const torrentId = body.torrentId || body.magnet || body.torrent;
        if (!torrentId) {
          return this.sendJson(res, 400, { success: false, error: 'torrentId is required' });
        }
        if (!this.engine) {
          return this.sendJson(res, 503, { success: false, error: 'Engine not ready' });
        }

        const prefs = this.options.getPreferences ? this.options.getPreferences() : {};
        const options = {
          downloadPath: expandPath(body.downloadPath || prefs.savePath),
          paused: Boolean(body.paused)
        };

        const result = await this.engine.addTorrent(torrentId, options);
        return this.sendJson(res, 200, { success: true, torrent: result });
      }

      // Specific torrent routes: /api/torrents/:infoHash/...
      const torrentMatch = pathname.match(/^\/api\/torrents\/([a-zA-Z0-9]+)(\/.*)?$/);
      if (torrentMatch) {
        const infoHash = torrentMatch[1].toLowerCase();
        const subAction = torrentMatch[2] || '';

        if (!this.engine) {
          return this.sendJson(res, 503, { success: false, error: 'Engine not ready' });
        }

        const torrent = Array.from(this.engine.torrents.values()).find(t => (t.infoHash || '').toLowerCase() === infoHash);
        if (!torrent && subAction !== '/remove') {
          return this.sendJson(res, 404, { success: false, error: `Torrent ${infoHash} not found` });
        }

        // GET /api/torrents/:infoHash
        if (subAction === '' && method === 'GET') {
          const formatted = this.engine.formatTorrentProgress(torrent);
          return this.sendJson(res, 200, { success: true, torrent: formatted });
        }

        // POST /api/torrents/:infoHash/pause
        if (subAction === '/pause' && method === 'POST') {
          const paused = this.engine.pauseTorrent(infoHash, true);
          return this.sendJson(res, 200, { success: true, infoHash, paused });
        }

        // POST /api/torrents/:infoHash/resume
        if (subAction === '/resume' && method === 'POST') {
          const resumed = this.engine.resumeTorrent(infoHash);
          return this.sendJson(res, 200, { success: true, infoHash, paused: false, resumed });
        }

        // POST /api/torrents/:infoHash/verify
        if (subAction === '/verify' && method === 'POST') {
          this.engine.verifyTorrent(infoHash).catch(e => console.error('Verify error:', e));
          return this.sendJson(res, 200, { success: true, infoHash, status: 'Verifying data...' });
        }

        // POST /api/torrents/:infoHash/remove
        if (subAction === '/remove' && method === 'POST') {
          const body = await this.readBody(req);
          const deleteFiles = Boolean(body.deleteFiles);
          const removed = this.engine.removeTorrent(infoHash, deleteFiles);
          return this.sendJson(res, 200, { success: true, infoHash, removed });
        }

        // GET /api/torrents/:infoHash/files
        if (subAction === '/files' && method === 'GET') {
          const files = this.engine.getFormattedFiles(torrent);
          return this.sendJson(res, 200, { success: true, infoHash, files });
        }

        // POST /api/torrents/:infoHash/files/:fileIndex/wanted
        const fileWantedMatch = subAction.match(/^\/files\/(\d+)\/wanted$/);
        if (fileWantedMatch && method === 'POST') {
          const fileIndex = parseInt(fileWantedMatch[1], 10);
          const body = await this.readBody(req);
          const wanted = body.wanted !== undefined ? Boolean(body.wanted) : true;
          const result = this.engine.setFileWanted(infoHash, fileIndex, wanted);
          return this.sendJson(res, 200, { success: true, infoHash, fileIndex, wanted, result });
        }
      }

      // GET /api/speed
      if (pathname === '/api/speed' && method === 'GET') {
        const monitor = this.options.getNetworkMonitor ? this.options.getNetworkMonitor() : null;
        const currentSpeed = monitor ? monitor.getCurrentSnapshot() : {
          downloadSpeed: this.engine ? this.engine.client.downloadSpeed : 0,
          uploadSpeed: this.engine ? this.engine.client.uploadSpeed : 0
        };
        const history = monitor ? monitor.getHistory() : [];
        return this.sendJson(res, 200, {
          success: true,
          speed: currentSpeed,
          history
        });
      }

      // GET /api/preferences
      if (pathname === '/api/preferences' && method === 'GET') {
        const prefs = this.options.getPreferences ? this.options.getPreferences() : {};
        return this.sendJson(res, 200, { success: true, preferences: prefs });
      }

      // POST /api/preferences
      if (pathname === '/api/preferences' && method === 'POST') {
        const body = await this.readBody(req);
        const updated = this.options.updatePreferences ? this.options.updatePreferences(body) : body;
        return this.sendJson(res, 200, { success: true, preferences: updated });
      }

      // POST /api/status-bar
      if (pathname === '/api/status-bar' && method === 'POST') {
        const body = await this.readBody(req);
        const enable = body.enable !== undefined ? Boolean(body.enable) : true;
        const result = this.options.toggleStatusBar ? this.options.toggleStatusBar(enable) : { showInStatusBar: enable };
        return this.sendJson(res, 200, { success: true, ...result });
      }

      return this.sendJson(res, 404, { success: false, error: `Endpoint ${method} ${pathname} not found` });
    } catch (err) {
      console.error('[Torrently Stream Server] API Error:', err);
      return this.sendJson(res, 500, { success: false, error: err.message });
    }
  }

  stop() {
    this.removePortFile();
    if (this.activeTranscodeProcesses) {
      for (const proc of this.activeTranscodeProcesses) {
        try { proc.kill('SIGKILL'); } catch (e) {}
      }
      this.activeTranscodeProcesses.clear();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = StreamServer;
