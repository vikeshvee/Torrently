const http = require('http');
const fs = require('fs');
const path = require('path');
const { expandPath } = require('./paths');

class StreamServer {
  constructor(engine) {
    this.engine = engine;
    this.server = null;
    this.port = 8888;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Content-Type, Accept');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
        if (url.pathname.startsWith('/stream/')) {
          this.handleStreamRequest(req, res, url);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Torrently Stream Endpoint Not Found');
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
          console.log(`[Torrently Stream Server] Listening at http://127.0.0.1:${boundPort}`);
          resolve(boundPort);
        });
      };

      tryListen(this.port);
    });
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
    const infoHash = parts[1];
    const fileIndex = parseInt(parts[2] || '0', 10);

    const torrent = this.engine.torrents.get(infoHash);
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

    if (typeof file.createReadStream === 'function') {
      this.streamFromWebTorrentFile(req, res, file);
      return;
    }

    const diskPath = this.resolveDiskPath(torrent, file);
    if (diskPath && fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
      this.streamFromDisk(req, res, diskPath, file.name || torrent.name);
      return;
    }

    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('File not available yet. Wait for download to start.');
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

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = StreamServer;
