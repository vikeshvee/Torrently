const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTorrentMetadata } = require('./bencode');
const { expandPath } = require('./paths');
const geoIp = require('./geoIp');

/**
 * Tier-1 High-Speed Public Trackers list.
 * Injected automatically into every torrent & magnet link to discover 3x-10x more active seeders.
 */
const TIER1_TRACKERS = [
  'udp://tracker.opentrackers.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'http://tracker.openbittorrent.com:80/announce'
];

/**
 * Detects if a property is a read-only getter on the prototype chain (e.g. WebTorrent's Torrent or File).
 */
function hasPrototypeGetter(obj, prop) {
  if (!obj) return false;
  let proto = Object.getPrototypeOf(obj);
  while (proto && proto !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc && typeof desc.get === 'function' && typeof desc.set !== 'function') {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Safely sets a metric property on Torrent or File instances without overwriting or breaking WebTorrent live prototype getters.
 */
function setMetric(obj, prop, val) {
  if (!obj) return;
  if (hasPrototypeGetter(obj, prop)) {
    // Delete any stale own property that may have shadowed the prototype getter
    try { delete obj[prop]; } catch (e) {}
    obj[`_disk_${prop}`] = val;
    return;
  }
  try {
    obj[prop] = val;
  } catch (e) {
    obj[`_disk_${prop}`] = val;
  }
}

function getMetric(obj, prop, fallback = 0) {
  if (!obj) return fallback;
  const liveVal = (typeof obj[prop] === 'number' && !isNaN(obj[prop])) ? obj[prop] : null;
  const diskVal = (typeof obj[`_disk_${prop}`] === 'number' && !isNaN(obj[`_disk_${prop}`])) ? obj[`_disk_${prop}`] : null;
  const legacyVal = (typeof obj[`_${prop}`] === 'number' && !isNaN(obj[`_${prop}`])) ? obj[`_${prop}`] : null;

  // If live WebTorrent bitfield is active, liveVal is authoritative for progress and downloaded
  const hasLiveBitfield = Boolean(
    (obj.bitfield && obj.pieces) ||
    (obj._torrent && obj._torrent.bitfield && obj._torrent.pieces)
  );

  if (hasLiveBitfield && liveVal !== null && (prop === 'downloaded' || prop === 'progress')) {
    return liveVal;
  }

  if (liveVal !== null && diskVal !== null) {
    return Math.max(liveVal, diskVal);
  }
  if (liveVal !== null) return liveVal;
  if (diskVal !== null) return diskVal;
  if (legacyVal !== null) return legacyVal;
  return fallback;
}

/**
 * Sanitizes and trims pasted torrent links, stripping surrounding brackets, quotes, and trailing sentence punctuation.
 */
function sanitizeTorrentInput(input) {
  if (!input) return '';
  if (Buffer.isBuffer(input)) return input;
  if (input && typeof input === 'object' && input.type === 'Buffer' && Array.isArray(input.data)) {
    return Buffer.from(input.data);
  }
  if (typeof input === 'string') {
    let s = input.trim();
    // Strip surrounding quotes, brackets, and markdown backticks
    s = s.replace(/^[<"'\s`]+|[>"'\s`]+$/g, '').trim();

    // If string contains a magnet URI anywhere, extract the full magnet URI
    const magnetMatch = s.match(/(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s<>"`]*)/i);
    if (magnetMatch) {
      let uri = magnetMatch[1];
      // Strip trailing sentence punctuation like .,;:
      uri = uri.replace(/[.,;:]+$/, '');
      return uri;
    }


    // Strip trailing punctuation from hash or URL
    s = s.replace(/[.,;:]+$/, '').trim();
    return s;
  }
  return input;
}

/**
 * Resolves base download directory and target path without duplicate folder nesting.
 */
function resolveTorrentPaths(inputPath, defaultDir, torrentName, isMultiFile) {
  const expanded = expandPath(inputPath || defaultDir);
  let baseFolder = expanded;

  const baseName = path.basename(expanded);
  if (torrentName && (baseName === torrentName || baseName === torrentName.replace(/\.[^/.]+$/, '') + '_Bundle')) {
    baseFolder = path.dirname(expanded);
  } else {
    try {
      if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
        baseFolder = path.dirname(expanded);
      }
    } catch (e) {}
  }

  try {
    fs.mkdirSync(baseFolder, { recursive: true });
  } catch (e) {}

  // For both single and multi-file, WebTorrent places content at baseFolder/torrentName.
  let targetPath = torrentName ? path.join(baseFolder, torrentName) : baseFolder;

  return { baseFolder, targetPath };
}



/**
 * Validates if input is a valid WebTorrent source (Buffer, magnet URI, 40-hex infoHash, 32-base32 infoHash, or HTTP URL)
 */
function isValidWebTorrentInput(input) {
  const sanitized = sanitizeTorrentInput(input);
  if (!sanitized) return false;
  if (Buffer.isBuffer(sanitized)) return true;
  if (typeof sanitized === 'string') {
    if (sanitized.startsWith('magnet:?')) return true;
    if (/^[0-9a-fA-F]{40}$/.test(sanitized)) return true;
    if (/^[2-7a-zA-Z]{32}$/.test(sanitized)) return true;
    if (sanitized.startsWith('http://') || sanitized.startsWith('https://')) return true;
  }
  return false;
}

/**
 * Extracts a clean, human-readable torrent display name from magnet URIs or filenames.
 */
function extractTorrentName(torrentInput, fallback = 'BitTorrent Download') {
  if (typeof torrentInput !== 'string') return fallback;
  const input = sanitizeTorrentInput(torrentInput);
  if (input.startsWith('magnet:?')) {
    const match = input.match(/dn=([^&]+)/);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1].replace(/\+/g, ' '));
        return decoded.replace(/[/\\?%*:|"<>]/g, '_').trim() || fallback;
      } catch (e) {
        return match[1].replace(/\+/g, ' ').replace(/[/\\?%*:|"<>]/g, '_').trim();
      }
    }
    const xtMatch = input.match(/xt=urn:btih:([^&]+)/i);
    if (xtMatch) {
      return `Magnet_${xtMatch[1].substring(0, 10)}`;
    }
    return 'Magnet Download';
  }
  if (input.endsWith('.torrent') || input.includes('/') || input.includes('\\')) {
    return path.basename(input).replace('.torrent', '');
  }
  if (/^[0-9a-fA-F]{40}$/.test(input) || /^[2-7a-zA-Z]{32}$/.test(input)) {
    return `Torrent_${input.substring(0, 10)}`;
  }
  return fallback;
}

/**
 * TorrentEngine - High-Speed Accelerated BitTorrent Swarm Engine.
 * Robust, non-blocking, with throttled progress updates and file metadata preservation.
 */
class TorrentEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.torrents = new Map();
    this.client = null;
    this.disableClient = options.disableClient || false;
    this.disableState = options.disableState || false;
    this.stateFilePath = options.stateFilePath || path.join(__dirname, '../../torrently-state.json');
    this.downloadDir = expandPath(options.downloadDir || path.join(__dirname, '../../Downloads'));
    this._saveStateTimer = null;
    this._isLoadingState = false;
  }

  async init() {
    if (!this.disableClient) {
      try {
        const WebTorrent = (await import('webtorrent')).default;
        this.client = new WebTorrent({
          maxConns: 150,
          dht: true
        });
        this.bindClientEvents();
      } catch (err) {
        console.warn('[TorrentEngine] WebTorrent engine initialization note:', err.message);
      }
    }

    if (!this.disableState) {
      await this.loadState();
    }
  }

  bindClientEvents() {
    if (!this.client) return;
    this.client.on('error', (err) => {
      console.warn('[TorrentEngine Client Error Note]:', err.message);
    });
  }

  destroy() {
    if (this._saveStateTimer) {
      clearTimeout(this._saveStateTimer);
      this._saveStateTimer = null;
    }
    if (!this.disableState) {
      this.saveState();
    }
    if (this.streamServer) {
      try {
        this.streamServer.stop();
      } catch (e) {}
    }
    if (this.client) {
      try {
        if (typeof this.client.destroy === 'function') {
          this.client.destroy();
        }
      } catch (e) {}
    }
  }

  async loadState() {
    if (this._isLoadingState) return;
    this._isLoadingState = true;
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const savedTorrents = JSON.parse(raw);
        if (Array.isArray(savedTorrents)) {
          for (const saved of savedTorrents) {
            if (saved.torrentId || saved.infoHash) {
              let source = saved.torrentId;
              if (saved.torrentIdEncoding === 'base64' && typeof source === 'string') {
                try { source = Buffer.from(source, 'base64'); } catch (e) {}
              } else if (source && typeof source === 'object' && source.type === 'Buffer' && Array.isArray(source.data)) {
                source = Buffer.from(source.data);
              }
              if (!source || (typeof source !== 'string' && !Buffer.isBuffer(source))) {
                source = saved.infoHash ? `magnet:?xt=urn:btih:${saved.infoHash}&dn=${encodeURIComponent(saved.name || 'download')}` : '';
              }

              if (source) {
                try {
                  await this.addTorrent(source, {
                    infoHash: saved.infoHash,
                    downloadDir: saved.downloadDir,
                    downloadPath: saved.downloadPath,
                    name: saved.name,
                    length: saved.length || 0,
                    downloaded: saved.downloaded || 0,
                    uploaded: saved.uploaded || 0,
                    progress: saved.progress || 0,
                    paused: Boolean(saved.paused),
                    file_wanted: saved.file_wanted,
                    file_priorities: saved.file_priorities,
                    isMultiFile: Boolean(saved.isMultiFile || (saved.files && saved.files.length > 1)),
                    files: saved.files,
                    isMyTorrent: Boolean(saved.isMyTorrent || saved.createdByUser),
                    createdByUser: Boolean(saved.createdByUser || saved.isMyTorrent),
                    magnetURI: saved.magnetURI || '',
                    torrentFileBase64: saved.torrentFileBase64 || null,
                    blockedPeers: saved.blockedPeers || []
                  });
                } catch (err) {
                  console.warn('[TorrentEngine] Error restoring torrent on startup:', err.message);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[TorrentEngine] State loading note:', err.message);
    } finally {
      this._isLoadingState = false;
      if (!this.disableState) {
        this.saveState();
      }
    }
  }

  scheduleSaveState() {
    if (this.disableState || this._isLoadingState) return;
    if (this._saveStateTimer) return;
    this._saveStateTimer = setTimeout(() => {
      this._saveStateTimer = null;
      this.saveState();
    }, 2000);
  }

  saveState() {
    if (this._isLoadingState || this.disableState) return;
    try {
      const data = Array.from(this.torrents.values()).map(t => {
        let savedSource = '';
        let encoding = 'string';
        if (Buffer.isBuffer(t.torrentId)) {
          savedSource = t.torrentId.toString('base64');
          encoding = 'base64';
        } else if (typeof t.torrentId === 'string' && t.torrentId.length > 0) {
          savedSource = t.torrentId;
          encoding = 'string';
        } else if (t.infoHash) {
          savedSource = `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.name || 'download')}`;
          encoding = 'string';
        }

        const dl = getMetric(t, 'downloaded', 0);
        const prog = getMetric(t, 'progress', 0);
        const len = t.length || 0;

        let tfBase64 = t.torrentFileBase64 || null;
        if (!tfBase64 && t.torrentFile) {
          tfBase64 = Buffer.from(t.torrentFile).toString('base64');
        }

        return {
          infoHash: t.infoHash,
          torrentId: savedSource,
          torrentIdEncoding: encoding,
          name: t.name,
          length: len,
          pieceLength: t.pieceLength || 524288,
          downloaded: dl,
          uploaded: t.uploaded || (typeof t.uploaded === 'number' ? t.uploaded : 0),
          downloadDir: this.downloadDir,
          downloadPath: t.downloadPath || path.join(this.downloadDir, t.name || ''),
          isMultiFile: Boolean(t.isMultiFile || (t.files && t.files.length > 1)),
          progress: prog,
          paused: Boolean(t.paused),
          file_wanted: t.file_wanted || [],
          file_priorities: t.file_priorities || [],
          files: this.getFormattedFiles(t),
          isMyTorrent: Boolean(t.isMyTorrent || t.createdByUser),
          createdByUser: Boolean(t.createdByUser || t.isMyTorrent),
          magnetURI: t.magnetURI || '',
          torrentFileBase64: tfBase64,
          blockedPeers: Array.from(t.blockedPeers || [])
        };
      });

      fs.writeFileSync(this.stateFilePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.warn('[TorrentEngine] State save note:', err.message);
    }
  }

  addTorrent(torrentIdInput, options = {}) {
    let torrentInput = sanitizeTorrentInput(torrentIdInput);
    if (!torrentInput) {
      return Promise.reject(new Error('Invalid torrent input'));
    }

    const saveFolder = expandPath(options.downloadPath || this.downloadDir);
    try {
      fs.mkdirSync(saveFolder, { recursive: true });
    } catch (e) {}

    let parsedMeta = null;

    if (typeof torrentInput === 'string' && fs.existsSync(torrentInput)) {
      try {
        parsedMeta = parseTorrentMetadata(torrentInput);
        torrentInput = fs.readFileSync(torrentInput);
      } catch (e) {
        console.warn('Bencode buffer reading note:', e.message);
      }
    }

    let torrentName = options.name || (parsedMeta ? parsedMeta.name : extractTorrentName(torrentInput));
    torrentName = torrentName.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'BitTorrent Download';

    const isMultiFile = options.isMultiFile || (parsedMeta ? parsedMeta.isMultiFile : false);

    // Resolve base folder and target path without duplicate folder nesting
    const { baseFolder, targetPath } = resolveTorrentPaths(options.downloadPath, this.downloadDir, torrentName, isMultiFile);

    // Extract real infoHash if available from options, parsedMeta, or magnet input
    let targetInfoHash = (options.infoHash || (parsedMeta && parsedMeta.infoHash) || '').toLowerCase();
    if (!targetInfoHash && typeof torrentInput === 'string') {
      if (torrentInput.startsWith('magnet:?')) {
        const m = torrentInput.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (m) targetInfoHash = m[1].toLowerCase();
      } else if (/^[0-9a-fA-F]{40}$/.test(torrentInput)) {
        targetInfoHash = torrentInput.toLowerCase();
      }
    }

    // Check for duplicate torrent - if exists, resume from where finished
    let existingTorrent = null;
    if (targetInfoHash && this.torrents.has(targetInfoHash)) {
      existingTorrent = this.torrents.get(targetInfoHash);
    }
    if (!existingTorrent) {
      for (const t of this.torrents.values()) {
        if (targetInfoHash && t.infoHash && t.infoHash.toLowerCase() === targetInfoHash) {
          existingTorrent = t;
          break;
        }
        if (t.torrentId && t.torrentId === torrentInput) {
          existingTorrent = t;
          break;
        }
        if (t.name && torrentName && t.name === torrentName && t.downloadPath === targetPath) {
          existingTorrent = t;
          break;
        }
      }
    }

    if (existingTorrent) {
      console.log(`[TorrentEngine] Duplicate torrent detected for "${existingTorrent.name}" (${existingTorrent.infoHash}). Resuming from existing data.`);
      this.checkDiskFiles(existingTorrent);

      if (this.client && typeof this.client.get === 'function') {
        const wt = this.client.get(existingTorrent.infoHash);
        if (wt && typeof wt.rescanFiles === 'function') {
          try {
            wt.rescanFiles(() => {
              if (typeof wt.downloaded === 'number' && wt.downloaded > 0) setMetric(existingTorrent, 'downloaded', wt.downloaded);
              if (typeof wt.progress === 'number' && wt.progress > 0) setMetric(existingTorrent, 'progress', wt.progress);
            });
          } catch (e) {}
        }
      }

      if (getMetric(existingTorrent, 'progress', 0) < 1.0) {
        this.resumeTorrent(existingTorrent.infoHash);
      } else {
        this.emit('torrent-done', this.formatTorrentMeta(existingTorrent));
      }

      this.emit('torrent-progress', this.formatTorrentProgress(existingTorrent));
      if (!this.disableState) this.scheduleSaveState();
      return Promise.resolve(this.formatTorrentMeta(existingTorrent));
    }

    const tempHash = targetInfoHash || options.infoHash || Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    const rawFiles = (options.files && Array.isArray(options.files) && options.files.length > 0)
      ? options.files
      : (parsedMeta ? parsedMeta.files : [{ index: 0, name: torrentName, path: torrentName, length: options.length || 0 }]);
    const fileWanted = options.file_wanted || rawFiles.map(f => f.wanted !== false);
    const filePriorities = options.file_priorities || rawFiles.map(f => f.priority || 'normal');
    const initialProgress = options.progress !== undefined ? options.progress : 0;
    const initialDownloaded = options.downloaded !== undefined
      ? options.downloaded
      : (initialProgress >= 1 ? (options.length || (parsedMeta ? parsedMeta.length : 0)) : 0);

    const initialTorrent = {
      infoHash: tempHash,
      torrentId: torrentInput,
      name: torrentName,
      length: options.length || (parsedMeta ? parsedMeta.length : 0),
      pieceLength: parsedMeta ? parsedMeta.pieceLength : 524288,
      downloaded: initialDownloaded,
      initialDownloaded: initialDownloaded,
      initialProgress: initialProgress,
      uploaded: options.uploaded || 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      seeders: 0,
      leechers: 0,
      progress: initialProgress,
      paused: options.paused || false,
      isMultiFile: isMultiFile,
      downloadPath: targetPath,
      verifying: false,
      file_wanted: fileWanted,
      file_priorities: filePriorities,
      files: rawFiles,
      parsedFiles: rawFiles,
      isMyTorrent: Boolean(options.isMyTorrent || options.createdByUser),
      createdByUser: Boolean(options.createdByUser || options.isMyTorrent),
      blockedPeers: new Set(options.blockedPeers || []),
      magnetURI: options.magnetURI || ''
    };

    // Scan disk files early so partial data on disk is synced before UI render
    this.checkDiskFiles(initialTorrent);

    // Store and emit 'torrent-added' immediately for instant UI responsiveness
    this.torrents.set(tempHash, initialTorrent);
    this.emit('torrent-added', this.formatTorrentMeta(initialTorrent));
    if (!this.disableState && !this._isLoadingState) {
      this.saveState();
    }

    // Connect to real WebTorrent swarm in background with Tier-1 public trackers
    if (this.client && isValidWebTorrentInput(torrentInput)) {
      try {
        const addOpts = {
          path: baseFolder,
          announce: TIER1_TRACKERS,
          maxWebConns: 20
        };

        const wtTorrent = this.client.add(torrentInput, addOpts);

        // Bind events immediately so wires and speeds are tracked right away
        this.bindTorrentEvents(wtTorrent);

        if (options.paused && typeof wtTorrent.pause === 'function') {
          try { wtTorrent.pause(); } catch (e) {}
        }

        const onReady = (t) => {
          if (tempHash !== t.infoHash) {
            this.torrents.delete(tempHash);
            this.emit('torrent-removed', { infoHash: tempHash });
          }

          t.torrentId = torrentInput;
          t.downloadPath = targetPath;
          if (options.name) t.name = options.name;
          if (options.uploaded) t.uploaded = options.uploaded;
          t.isMyTorrent = Boolean(options.isMyTorrent || options.createdByUser);
          t.createdByUser = Boolean(options.createdByUser || options.isMyTorrent);
          t.blockedPeers = new Set(options.blockedPeers || []);
          if (options.magnetURI) t.magnetURI = options.magnetURI;
          if (t.files && Array.isArray(t.files) && t.files.length > 0) {
            t.parsedFiles = t.files.map((f, idx) => ({
              index: idx,
              name: f.name || path.basename(f.path || '') || `File ${idx + 1}`,
              path: f.path || f.name || `File ${idx + 1}`,
              length: f.length || 0
            }));
            t.isMultiFile = t.files.length > 1;
          } else if (rawFiles && rawFiles.length > 0) {
            t.parsedFiles = rawFiles;
          }
          t.paused = Boolean(options.paused);
          t.file_wanted = fileWanted;
          t.file_priorities = filePriorities;

          // Check disk files and preserve verified downloaded bytes and progress
          this.checkDiskFiles(t);

          if (initialProgress >= 1.0 || (options && options.progress >= 1.0)) {
            t._disk_completed = true;
            setMetric(t, 'progress', 1.0);
            if (t.length) setMetric(t, 'downloaded', t.length);
            if (t.bitfield && t.pieces && Array.isArray(t.pieces)) {
              try {
                for (let i = 0; i < t.pieces.length; i++) {
                  t.bitfield.set(i, true);
                }
              } catch (e) {}
            }
            if (typeof t._markAllVerified === 'function') {
              try { t._markAllVerified(); } catch (e) {}
            }
          } else if (t._anyFileFound && typeof t.rescanFiles === 'function') {
            // Existing files found on disk for this torrent: rescan them using piece hashes to resume from where it left off!
            try {
              t.rescanFiles(() => {
                this.emit('torrent-progress', this.formatTorrentProgress(t));
                this.scheduleSaveState();
              });
            } catch (e) {}
          } else {
            const bestDownloaded = Math.max(getMetric(t, 'downloaded', 0), initialDownloaded);
            const bestProgress = Math.max(getMetric(t, 'progress', 0), initialProgress);
            if (bestDownloaded > getMetric(t, 'downloaded', 0)) setMetric(t, 'downloaded', bestDownloaded);
            if (bestProgress > getMetric(t, 'progress', 0)) setMetric(t, 'progress', bestProgress);
          }

          if (t.paused && typeof t.pause === 'function') {
            try { t.pause(); } catch (e) {}
          }

          // Transmission File Selection & Priority Configuration
          if (t.files && Array.isArray(t.files)) {
            t.files.forEach((f, i) => {
              const isWanted = fileWanted[i] !== undefined ? fileWanted[i] : true;
              if (isWanted) {
                if (typeof f.select === 'function') f.select();
              } else {
                if (typeof f.deselect === 'function') f.deselect();
              }
            });
          }

          this.torrents.set(t.infoHash, t);
          this.emit('torrent-added', this.formatTorrentMeta(t));
          if (!this.disableState && !this._isLoadingState) {
            this.saveState();
          }
        };


        wtTorrent.on('infoHash', () => {
          if (wtTorrent.infoHash && tempHash !== wtTorrent.infoHash) {
            this.torrents.delete(tempHash);
            this.emit('torrent-removed', { infoHash: tempHash });
            this.torrents.set(wtTorrent.infoHash, wtTorrent);
          }
        });

        if (wtTorrent.ready) {
          onReady(wtTorrent);
        } else {
          wtTorrent.on('ready', () => onReady(wtTorrent));
        }

        wtTorrent.on('metadata', () => {
          if (wtTorrent.files && Array.isArray(wtTorrent.files) && wtTorrent.files.length > 0) {
            wtTorrent.parsedFiles = wtTorrent.files.map((f, idx) => ({
              index: idx,
              name: f.name || path.basename(f.path || '') || `File ${idx + 1}`,
              path: f.path || f.name || `File ${idx + 1}`,
              length: f.length || 0
            }));
            wtTorrent.isMultiFile = wtTorrent.files.length > 1;
          }
          this.torrents.set(wtTorrent.infoHash, wtTorrent);
          this.checkDiskFiles(wtTorrent);
          if (wtTorrent._anyFileFound && typeof wtTorrent.rescanFiles === 'function' && !wtTorrent._disk_completed) {
            try {
              wtTorrent.rescanFiles(() => {
                this.emit('torrent-progress', this.formatTorrentProgress(wtTorrent));
                this.scheduleSaveState();
              });
            } catch (e) {}
          }
          this.emit('torrent-added', this.formatTorrentMeta(wtTorrent));
          this.emit('torrent-progress', this.formatTorrentProgress(wtTorrent));
          if (!this.disableState) this.scheduleSaveState();
        });

        wtTorrent.on('error', (err) => {
          console.warn('[WebTorrent Swarm Note]:', err.message);
        });
      } catch (err) {
        console.warn('[WebTorrent Add Note]:', err.message);
      }
    }

    return Promise.resolve(this.formatTorrentMeta(initialTorrent));
  }

  /**
   * High-performance throttled event listener binding.
   * Prevents IPC event flooding and synchronous file write bottlenecks.
   */
  bindTorrentEvents(t) {
    let lastEmit = 0;
    const emitProgressThrottled = () => {
      const now = Date.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;
      this.emit('torrent-progress', this.formatTorrentProgress(t));
      this.scheduleSaveState();
    };

    t.on('download', emitProgressThrottled);
    t.on('upload', emitProgressThrottled);
    t.on('wire', (wire) => {
      const ip = wire.remoteAddress || '';
      const ipOnly = ip.includes(':') ? ip.split(':')[0] : ip;
      const id = wire.peerId || '';
      if ((t.blockedPeers && (t.blockedPeers.has(ip) || t.blockedPeers.has(ipOnly) || t.blockedPeers.has(id))) ||
          (this.globalBlockedPeers && (this.globalBlockedPeers.has(ip) || this.globalBlockedPeers.has(ipOnly)))) {
        try {
          if (typeof wire.choke === 'function') wire.choke();
          if (typeof wire.destroy === 'function') wire.destroy();
        } catch (e) {}
        return;
      }
      emitProgressThrottled();
    });

    t.on('done', () => {
      this.emit('torrent-done', this.formatTorrentMeta(t));
      this.emit('torrent-progress', this.formatTorrentProgress(t));
      if (!this.disableState) this.saveState();
    });
  }

  pauseTorrent(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    torrent.paused = true;
    setMetric(torrent, 'downloadSpeed', 0);
    setMetric(torrent, 'uploadSpeed', 0);

    const wt = (this.client && typeof this.client.get === 'function') ? this.client.get(infoHash) : null;
    if (wt) {
      if (typeof wt.pause === 'function') {
        try { wt.pause(); } catch (e) {}
      }
    } else if (typeof torrent.pause === 'function') {
      try { torrent.pause(); } catch (e) {}
    }

    this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    if (!this.disableState) this.saveState();
    return true;
  }

  resumeTorrent(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    torrent.paused = false;

    let wt = (this.client && typeof this.client.get === 'function') ? this.client.get(infoHash) : null;
    if (!wt && this.client && isValidWebTorrentInput(torrent.torrentId || torrent.infoHash)) {
      try {
        const addOpts = {
          path: path.dirname(torrent.downloadPath || this.downloadDir),
          announce: TIER1_TRACKERS,
          maxWebConns: 20
        };
        wt = this.client.add(torrent.torrentId || torrent.infoHash, addOpts, (t) => {
          this.torrents.set(t.infoHash, t);
          this.bindTorrentEvents(t);
        });
      } catch (e) {}
    }

    if (wt) {
      if (typeof wt.resume === 'function') {
        try { wt.resume(); } catch (e) {}
      }
      if (wt.files && Array.isArray(wt.files)) {
        wt.files.forEach((f, i) => {
          const isWanted = torrent.file_wanted ? (torrent.file_wanted[i] !== false) : true;
          if (isWanted && typeof f.select === 'function') {
            try { f.select(); } catch (e) {}
          } else if (!isWanted && typeof f.deselect === 'function') {
            try { f.deselect(); } catch (e) {}
          }
        });
      }
      if (typeof wt.select === 'function' && wt.pieces && (!torrent.file_wanted || torrent.file_wanted.every(Boolean))) {
        try { wt.select(0, wt.pieces.length - 1, false); } catch (e) {}
      }
      if (wt.discovery) {
        try {
          if (wt.discovery.tracker && typeof wt.discovery.tracker.announce === 'function') {
            wt.discovery.tracker.announce();
          }
          if (wt.discovery.dht && typeof wt.discovery.dht.lookup === 'function') {
            wt.discovery.dht.lookup(wt.infoHash);
          }
        } catch (e) {}
      }
    } else if (typeof torrent.resume === 'function') {
      try { torrent.resume(); } catch (e) {}
    }

    this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    if (!this.disableState) this.saveState();
    return true;
  }

  removeTorrent(infoHash, deleteFiles = false) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    const downloadPath = torrent.downloadPath;

    if (this.client && typeof this.client.remove === 'function') {
      try {
        if (typeof this.client.get === 'function' && this.client.get(infoHash)) {
          this.client.remove(infoHash, { destroyStore: deleteFiles });
        }
      } catch (e) {
        console.warn('WebTorrent remove note:', e.message);
      }
    }

    if (deleteFiles && downloadPath) {
      try {
        const targetPath = expandPath(downloadPath);
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn('File deletion note:', err.message);
      }
    }

    const removed = this.torrents.delete(infoHash);
    if (removed) {
      this.emit('torrent-removed', { infoHash, deleteFiles });
      if (!this.disableState) this.saveState();
    }
    return removed;
  }

  setFileWanted(infoHash, fileIndex, wanted) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    if (!torrent.file_wanted) {
      torrent.file_wanted = [];
    }
    torrent.file_wanted[fileIndex] = Boolean(wanted);

    const files = (torrent.files && torrent.files.length > 0)
      ? torrent.files
      : (torrent.parsedFiles && torrent.parsedFiles.length > 0 ? torrent.parsedFiles : []);

    if (files && files[fileIndex]) {
      const f = files[fileIndex];
      f.wanted = Boolean(wanted);
      if (wanted) {
        if (typeof f.select === 'function') f.select();
      } else {
        if (typeof f.deselect === 'function') f.deselect();
        f.downloadSpeed = 0;
        f._smoothSpeed = 0;
      }
    }

    // Recalculate progress strictly based on checked files
    const formatted = this.formatTorrentProgress(torrent);
    if (formatted.progress >= 1.0 && formatted.length > 0) {
      torrent._disk_completed = true;
      this.emit('torrent-done', this.formatTorrentMeta(torrent));
    } else if (formatted.progress < 1.0) {
      torrent._disk_completed = false;
    }

    this.emit('torrent-progress', formatted);
    if (!this.disableState) this.scheduleSaveState();
    return true;
  }

  /**
   * Blocks a swarm peer/node from downloading or uploading data for this torrent.
   * Chokes and destroys any existing connections from this peer immediately.
   */
  blockPeer(infoHash, peerAddressOrId) {
    if (!peerAddressOrId) return false;
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    if (!torrent.blockedPeers) {
      torrent.blockedPeers = new Set();
    }

    const clean = String(peerAddressOrId).trim();
    const ipOnly = clean.includes(':') ? clean.split(':')[0] : clean;
    torrent.blockedPeers.add(clean);
    torrent.blockedPeers.add(ipOnly);

    if (!this.globalBlockedPeers) {
      this.globalBlockedPeers = new Set();
    }
    this.globalBlockedPeers.add(clean);
    this.globalBlockedPeers.add(ipOnly);

    // Drop and choke any active wires matching this peer
    if (torrent.wires && Array.isArray(torrent.wires)) {
      for (const wire of torrent.wires) {
        const rawAddr = wire.remoteAddress || '';
        const wIp = rawAddr.includes(':') ? rawAddr.split(':')[0] : rawAddr;
        const wId = wire.peerId || '';
        if (torrent.blockedPeers.has(rawAddr) || torrent.blockedPeers.has(wIp) || torrent.blockedPeers.has(wId)) {
          try {
            if (typeof wire.choke === 'function') wire.choke();
            if (typeof wire.destroy === 'function') wire.destroy();
          } catch (e) {}
        }
      }
    }

    if (!this.disableState) this.scheduleSaveState();
    this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    return true;
  }

  /**
   * Unblocks a previously blocked swarm peer/node.
   */
  unblockPeer(infoHash, peerAddressOrId) {
    if (!peerAddressOrId) return false;
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    const clean = String(peerAddressOrId).trim();
    const ipOnly = clean.includes(':') ? clean.split(':')[0] : clean;

    if (torrent.blockedPeers) {
      torrent.blockedPeers.delete(clean);
      torrent.blockedPeers.delete(ipOnly);
    }
    if (this.globalBlockedPeers) {
      this.globalBlockedPeers.delete(clean);
      this.globalBlockedPeers.delete(ipOnly);
    }

    if (!this.disableState) this.scheduleSaveState();
    this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    return true;
  }

  getBlockedPeers(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent || !torrent.blockedPeers) return [];
    return Array.from(torrent.blockedPeers);
  }

  isPeerBlocked(infoHash, peerIpOrId) {
    if (!peerIpOrId) return false;
    const clean = String(peerIpOrId).trim();
    const ipOnly = clean.includes(':') ? clean.split(':')[0] : clean;

    const torrent = this.torrents.get(infoHash);
    if (torrent && torrent.blockedPeers) {
      if (torrent.blockedPeers.has(clean) || torrent.blockedPeers.has(ipOnly)) return true;
    }
    if (this.globalBlockedPeers) {
      if (this.globalBlockedPeers.has(clean) || this.globalBlockedPeers.has(ipOnly)) return true;
    }
    return false;
  }

  /**
   * Creates a new torrent from a file or entire directory and seeds it on the network.
   */
  async createAndSeedTorrent(inputPath, options = {}) {
    if (!inputPath) throw new Error('File or folder path is required');
    const expandedPath = expandPath(inputPath);
    if (!fs.existsSync(expandedPath)) throw new Error(`Path does not exist: ${expandedPath}`);

    const stat = fs.statSync(expandedPath);
    const isDir = stat.isDirectory();
    const torrentName = options.name || path.basename(expandedPath);
    const trackers = (options.trackers && Array.isArray(options.trackers) && options.trackers.length > 0)
      ? options.trackers
      : TIER1_TRACKERS;

    const seedOpts = {
      name: torrentName,
      announce: trackers,
      comment: options.comment || 'Created with Torrently',
      createdBy: 'Torrently/1.0',
      private: Boolean(options.private)
    };

    if (options.pieceLength) {
      seedOpts.pieceLength = options.pieceLength;
    }

    const buildMagnet = (hash, name) => {
      let uri = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || 'download')}`;
      for (const tr of trackers) {
        uri += `&tr=${encodeURIComponent(tr)}`;
      }
      return uri;
    };

    if (this.client && typeof this.client.seed === 'function') {
      return new Promise((resolve, reject) => {
        let isSettled = false;

        const settleSuccess = (wtTorrent) => {
          if (isSettled) return;
          isSettled = true;
          try {
            wtTorrent.isMyTorrent = true;
            wtTorrent.createdByUser = true;
            wtTorrent.downloadPath = expandedPath;
            wtTorrent.blockedPeers = new Set(options.blockedPeers || []);
            wtTorrent._disk_completed = true;

            if (wtTorrent.torrentFile) {
              wtTorrent.torrentFileBase64 = Buffer.from(wtTorrent.torrentFile).toString('base64');
            }
            if (!wtTorrent.magnetURI || !wtTorrent.magnetURI.includes('&tr=')) {
              wtTorrent.magnetURI = buildMagnet(wtTorrent.infoHash, wtTorrent.name || torrentName);
            }

            setMetric(wtTorrent, 'progress', 1.0);
            if (wtTorrent.length) setMetric(wtTorrent, 'downloaded', wtTorrent.length);

            if (wtTorrent.files && Array.isArray(wtTorrent.files)) {
              wtTorrent.files.forEach((f) => {
                f._disk_completed = true;
                setMetric(f, 'progress', 1.0);
                if (f.length) setMetric(f, 'downloaded', f.length);
              });
            }

            this.torrents.set(wtTorrent.infoHash, wtTorrent);
            this.bindTorrentEvents(wtTorrent);
            this.emit('torrent-added', this.formatTorrentMeta(wtTorrent));
            if (!this.disableState) this.saveState();

            resolve(this.formatTorrentMeta(wtTorrent));
          } catch (err) {
            reject(err);
          }
        };

        try {
          const torrent = this.client.seed(expandedPath, seedOpts, (wtTorrent) => {
            settleSuccess(wtTorrent);
          });

          if (torrent) {
            torrent.once('error', (err) => {
              if (!isSettled) {
                isSettled = true;
                reject(err);
              }
            });
            torrent.once('ready', () => {
              settleSuccess(torrent);
            });
            torrent.once('metadata', () => {
              settleSuccess(torrent);
            });
          }
        } catch (err) {
          if (!isSettled) {
            isSettled = true;
            reject(err);
          }
        }
      });
    }

    // Mock / non-swarm fallback for tests and offline usage
    const mockHash = crypto.createHash('sha1').update(expandedPath + '_' + Date.now()).digest('hex');
    let totalSize = stat.size;
    let mockFiles = [];

    if (isDir) {
      const walkSync = (dir, root) => {
        let results = [];
        try {
          const list = fs.readdirSync(dir);
          list.forEach(file => {
            const full = path.join(dir, file);
            try {
              const s = fs.statSync(full);
              if (s.isDirectory()) {
                results = results.concat(walkSync(full, root));
              } else {
                results.push({
                  path: path.relative(root, full),
                  name: file,
                  length: s.size
                });
              }
            } catch (e) {}
          });
        } catch (e) {}
        return results;
      };
      mockFiles = walkSync(expandedPath, expandedPath);
      totalSize = mockFiles.reduce((acc, f) => acc + f.length, 0);
    } else {
      mockFiles = [{
        index: 0,
        name: torrentName,
        path: torrentName,
        length: totalSize
      }];
    }

    const mockTorrent = {
      infoHash: mockHash,
      name: torrentName,
      length: totalSize,
      pieceLength: 524288,
      downloadPath: expandedPath,
      isMyTorrent: true,
      createdByUser: true,
      paused: false,
      progress: 1.0,
      downloaded: totalSize,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      magnetURI: buildMagnet(mockHash, torrentName),
      blockedPeers: new Set(options.blockedPeers || []),
      files: mockFiles.map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length,
        progress: 1.0,
        downloaded: f.length,
        wanted: true
      })),
      _disk_completed: true
    };

    try {
      const createTorrentModule = await import('create-torrent');
      const createTorrent = createTorrentModule.default || createTorrentModule;
      const buf = await new Promise((res) => {
        createTorrent(expandedPath, seedOpts, (err, b) => res(b ? Buffer.from(b) : null));
      });
      if (buf) {
        mockTorrent.torrentFile = buf;
        mockTorrent.torrentFileBase64 = buf.toString('base64');
      }
    } catch (e) {}

    this.torrents.set(mockHash, mockTorrent);
    this.emit('torrent-added', this.formatTorrentMeta(mockTorrent));
    if (!this.disableState) this.saveState();
    return Promise.resolve(this.formatTorrentMeta(mockTorrent));
  }

  /**
   * Scans local files on disk and calculates exact verified bytes and progress.
   * If files are present on disk, resumes from existing data.
   * If any file was deleted or missing on disk, resets its metrics to 0 and clears verified status.
   */
  checkDiskFiles(torrent, isExplicitVerify = false) {
    if (this._isLoadingState) return;

    const basePath = expandPath(torrent.downloadPath || path.join(this.downloadDir, torrent.name || ''));
    const parentDir = path.dirname(basePath);
    const folderExists = fs.existsSync(basePath) || fs.existsSync(path.join(this.downloadDir, torrent.name || ''));

    const files = (torrent.files && torrent.files.length > 0)
      ? torrent.files
      : (torrent.parsedFiles && torrent.parsedFiles.length > 0 ? torrent.parsedFiles : []);

    let totalVerifiedBytes = 0;
    let anyFileFound = false;

    if (files.length > 1 || torrent.isMultiFile) {
      files.forEach((f) => {
        const relPath = f.path || f.name;
        const candidates = [
          path.join(basePath, relPath),
          path.join(basePath, path.basename(relPath)),
          path.join(parentDir, torrent.name || '', relPath),
          path.join(parentDir, relPath),
          path.join(this.downloadDir, torrent.name || '', relPath),
          path.join(this.downloadDir, relPath)
        ];

        let actualPath = null;
        for (const c of candidates) {
          try {
            if (fs.existsSync(c) && fs.statSync(c).isFile()) {
              actualPath = c;
              break;
            }
          } catch (e) {}
        }

        if (actualPath) {
          anyFileFound = true;
          const stat = fs.statSync(actualPath);
          const fLength = f.length || 0;

          let fileDownloaded = 0;
          const hasBitfield = Boolean(
            (torrent.bitfield && torrent.pieces) ||
            (f._torrent && f._torrent.bitfield && f._torrent.pieces)
          );

          if (hasBitfield) {
            // Live WebTorrent swarm: bitfield is the cryptographic ground truth!
            // Do NOT use stat.size because files on disk are preallocated or sparse.
            const liveDl = (typeof f.downloaded === 'number') ? f.downloaded : getMetric(f, 'downloaded', 0);
            fileDownloaded = Math.min(liveDl, fLength);
            if (fLength > 0 && fileDownloaded >= fLength) {
              f._disk_completed = true;
            }
          } else {
            // Offline / Mock / Loading state without live swarm:
            const isFileCompleted = Boolean(f._disk_completed || f.completed);
            const isTorrentCompleted = Boolean(torrent._disk_completed || torrent.completed || (getMetric(torrent, 'progress', 0) >= 1.0));

            if (fLength > 0 && stat.size < fLength) {
              fileDownloaded = Math.max(getMetric(f, 'downloaded', 0), stat.size);
            } else if (isFileCompleted || isTorrentCompleted) {
              fileDownloaded = fLength || stat.size;
              f._disk_completed = true;
            } else if (typeof getMetric(f, 'downloaded', null) === 'number' && getMetric(f, 'downloaded', 0) > 0) {
              fileDownloaded = Math.min(getMetric(f, 'downloaded', 0), stat.size);
            } else if (typeof torrent.progress === 'number' && torrent.progress > 0 && torrent.progress < 1.0) {
              // Partial torrent specified without per-file metrics: do not inflate unverified file to 100%
              fileDownloaded = 0;
            } else {
              fileDownloaded = Math.min(stat.size, fLength || stat.size);
            }
          }

          setMetric(f, 'downloaded', fileDownloaded);
          setMetric(f, 'progress', (fLength > 0) ? Math.min(1, fileDownloaded / fLength) : 0);
          totalVerifiedBytes += fileDownloaded;
        } else if (isExplicitVerify || folderExists) {
          // File was deleted or does NOT exist on disk!
          f._disk_completed = false;
          setMetric(f, 'downloaded', 0);
          setMetric(f, 'progress', 0);
          if (torrent.bitfield && typeof f._startPiece === 'number' && typeof f._endPiece === 'number') {
            try {
              for (let p = f._startPiece; p <= f._endPiece; p++) {
                torrent.bitfield.set(p, false);
                if (typeof torrent._markUnverified === 'function') {
                  torrent._markUnverified(p);
                }
              }
              if (f.done) f.done = false;
            } catch (e) {}
          }
        }
      });

      torrent._anyFileFound = anyFileFound;
      if (anyFileFound || isExplicitVerify || folderExists) {
        const totalLen = torrent.length || 0;
        const checkedFiles = files.filter((f, i) => {
          return torrent.file_wanted ? (torrent.file_wanted[i] !== false) : (f.wanted !== false);
        });
        const checkedLen = checkedFiles.reduce((acc, f) => acc + (f.length || 0), 0);
        const checkedVerified = checkedFiles.reduce((acc, f) => acc + (getMetric(f, 'downloaded', 0) || 0), 0);

        setMetric(torrent, 'downloaded', totalVerifiedBytes);
        const newProg = (totalLen > 0) ? Math.min(1, totalVerifiedBytes / totalLen) : 0;
        setMetric(torrent, 'progress', newProg);

        if ((torrent._disk_completed && totalVerifiedBytes === totalLen && totalLen > 0) ||
            (checkedFiles.length > 0 && checkedLen > 0 && checkedVerified >= checkedLen)) {
          torrent._disk_completed = true;
        } else if (newProg < 1.0 && checkedVerified < checkedLen) {
          torrent._disk_completed = false;
        }
      }
    } else {
      let filePath = basePath;
      if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
        const inner = path.join(basePath, torrent.name || 'download');
        if (fs.existsSync(inner)) filePath = inner;
      }
      if (!fs.existsSync(filePath)) {
        const candidates = [
          path.join(this.downloadDir, torrent.name || ''),
          path.join(parentDir, torrent.name || ''),
          path.join(this.downloadDir, path.basename(torrent.name || ''))
        ];
        for (const c of candidates) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) {
            filePath = c;
            break;
          }
        }
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        anyFileFound = true;
        const stat = fs.statSync(filePath);
        const tLength = torrent.length || 0;

        let singleDl = 0;
        const hasBitfield = Boolean(torrent.bitfield && torrent.pieces);

        if (hasBitfield) {
          // Live WebTorrent swarm: bitfield is authoritative!
          singleDl = (typeof torrent.downloaded === 'number') ? torrent.downloaded : getMetric(torrent, 'downloaded', 0);
          singleDl = Math.min(singleDl, tLength);
          if (tLength > 0 && singleDl >= tLength) {
            torrent._disk_completed = true;
          }
        } else {
          const isTorrentCompleted = Boolean(torrent._disk_completed || torrent.completed || (getMetric(torrent, 'progress', 0) >= 1.0));
          if (tLength > 0 && stat.size < tLength) {
            singleDl = Math.max(getMetric(torrent, 'downloaded', 0), stat.size);
          } else if (isTorrentCompleted) {
            singleDl = tLength || stat.size;
            torrent._disk_completed = true;
          } else if (typeof getMetric(torrent, 'downloaded', null) === 'number' && getMetric(torrent, 'downloaded', 0) > 0) {
            singleDl = Math.min(getMetric(torrent, 'downloaded', 0), stat.size);
          } else if (typeof torrent.progress === 'number' && torrent.progress > 0 && torrent.progress < 1.0) {
            singleDl = 0;
          } else {
            singleDl = Math.min(stat.size, tLength || stat.size);
          }
        }

        setMetric(torrent, 'downloaded', singleDl);
        const newProg = (tLength > 0) ? Math.min(1, singleDl / tLength) : 0;
        setMetric(torrent, 'progress', newProg);
        if (newProg < 1.0) {
          torrent._disk_completed = false;
        }

        if (files.length > 0) {
          files[0]._disk_completed = (newProg >= 1.0);
          setMetric(files[0], 'downloaded', singleDl);
          setMetric(files[0], 'progress', newProg);
        }
      } else if (isExplicitVerify || folderExists) {
        // Single file does NOT exist on disk or was deleted!
        torrent._disk_completed = false;
        setMetric(torrent, 'downloaded', 0);
        setMetric(torrent, 'progress', 0);
        if (files.length > 0) {
          files[0]._disk_completed = false;
          setMetric(files[0], 'downloaded', 0);
          setMetric(files[0], 'progress', 0);
        }
        if (torrent.bitfield && torrent.pieces && Array.isArray(torrent.pieces)) {
          try {
            for (let i = 0; i < torrent.pieces.length; i++) {
              torrent.bitfield.set(i, false);
              if (typeof torrent._markUnverified === 'function') {
                torrent._markUnverified(i);
              }
            }
          } catch (e) {}
        }
      }
      torrent._anyFileFound = anyFileFound;
    }
  }



  emitStatus(infoHash, statusText, buttonsDisabled = false) {
    const torrent = this.torrents.get(infoHash);
    if (torrent) {
      torrent.actionStatus = statusText;
      torrent.actionBusy = Boolean(buttonsDisabled);
      this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    }
    this.emit('torrent-action-status', {
      infoHash,
      status: statusText,
      buttonsDisabled: Boolean(buttonsDisabled)
    });
  }

  /**
   * Sets a new download location for a torrent:
   * Flow: New location -> Stop Torrent -> Verify data -> Update dbs -> Resume Torrent -> Enable pause/resume buttons -> Done
   */
  async setTorrentLocation(infoHash, newBaseDir) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;
    if (!newBaseDir) return false;

    const expandedNewBase = expandPath(newBaseDir);
    const wasPausedBefore = Boolean(torrent.paused);

    // Step 1: Stop Torrent
    this.emitStatus(infoHash, 'Stopping torrent...', true);
    this.pauseTorrent(infoHash);
    await new Promise(r => setTimeout(r, 400));

    // Step 2: Verify data (and move existing files if needed)
    this.emitStatus(infoHash, 'Verifying data...', true);
    torrent.verifying = true;

    try {
      const oldPath = torrent.downloadPath;
      const { baseFolder, targetPath: newTargetPath } = resolveTorrentPaths(
        expandedNewBase,
        this.downloadDir,
        torrent.name,
        torrent.isMultiFile
      );

      // Move files on disk if old path exists and differs from new path
      if (oldPath && fs.existsSync(oldPath) && oldPath !== newTargetPath) {
        try {
          fs.mkdirSync(path.dirname(newTargetPath), { recursive: true });
          if (!fs.existsSync(newTargetPath)) {
            try {
              fs.renameSync(oldPath, newTargetPath);
            } catch (err) {
              if (err.code === 'EXDEV') {
                fs.cpSync(oldPath, newTargetPath, { recursive: true });
                fs.rmSync(oldPath, { recursive: true, force: true });
              } else {
                throw err;
              }
            }
          }
        } catch (moveErr) {
          console.warn('[TorrentEngine] Note moving files to new location:', moveErr.message);
        }
      }

      torrent.downloadPath = newTargetPath;

      // Reconfigure WebTorrent client store path if active
      if (this.client && typeof this.client.get === 'function') {
        const wt = this.client.get(infoHash);
        if (wt) {
          try {
            if (typeof this.client.remove === 'function') {
              this.client.remove(infoHash, { destroyStore: false });
            }
          } catch (e) {}

          if (isValidWebTorrentInput(torrent.torrentId || torrent.infoHash)) {
            try {
              const addOpts = {
                path: baseFolder,
                announce: TIER1_TRACKERS,
                maxWebConns: 20
              };
              const newWt = this.client.add(torrent.torrentId || torrent.infoHash, addOpts);
              this.bindTorrentEvents(newWt);
            } catch (e) {}
          }
        }
      }

      // Verify files in new location
      this.checkDiskFiles(torrent);

      if (this.client && typeof this.client.get === 'function') {
        const wt = this.client.get(infoHash);
        if (wt && typeof wt.rescanFiles === 'function') {
          await new Promise((resolve) => {
            try {
              wt.rescanFiles((err) => {
                if (!err) {
                  if (typeof wt.downloaded === 'number') setMetric(torrent, 'downloaded', wt.downloaded);
                  if (typeof wt.progress === 'number') setMetric(torrent, 'progress', wt.progress);
                  if (wt.files && Array.isArray(wt.files)) {
                    wt.files.forEach((wf, i) => {
                      if (torrent.files && torrent.files[i]) {
                        setMetric(torrent.files[i], 'downloaded', wf.downloaded);
                        setMetric(torrent.files[i], 'progress', wf.progress);
                      }
                    });
                  }
                }
                resolve();
              });
            } catch (e) {
              resolve();
            }
          });
        }
      }
    } catch (err) {
      console.warn('[TorrentEngine] Verification error during set location:', err.message);
    } finally {
      torrent.verifying = false;
    }

    await new Promise(r => setTimeout(r, 400));

    // Step 3: Update dbs
    this.emitStatus(infoHash, 'Updating database...', true);
    if (!this.disableState) {
      this.saveState();
    }
    await new Promise(r => setTimeout(r, 400));

    // Step 4: Resume Torrent
    this.emitStatus(infoHash, 'Resuming torrent...', true);
    if (getMetric(torrent, 'progress', 0) >= 1.0) {
      setMetric(torrent, 'progress', 1.0);
      if (torrent.length) setMetric(torrent, 'downloaded', torrent.length);
      this.emit('torrent-done', this.formatTorrentMeta(torrent));
    } else if (!wasPausedBefore) {
      this.resumeTorrent(infoHash);
    } else {
      this.pauseTorrent(infoHash);
    }
    await new Promise(r => setTimeout(r, 400));

    // Step 5: Enable pause/resume buttons -> Done
    this.emitStatus(infoHash, 'Done', false);
    const clearTimer = setTimeout(() => {
      const t = this.torrents.get(infoHash);
      if (t && t.actionStatus === 'Done') {
        t.actionStatus = null;
        t.actionBusy = false;
        this.emit('torrent-progress', this.formatTorrentProgress(t));
        this.emit('torrent-action-status', { infoHash, status: null, buttonsDisabled: false });
      }
    }, 2500);
    if (clearTimer.unref) clearTimer.unref();

    return this.formatTorrentMeta(torrent);
  }

  /**
   * Re-checks and verifies local data on disk with observable step status:
   * Flow: Stop Torrent -> Verify data -> Update dbs -> Resume Torrent -> Enable pause/resume buttons -> Done
   */
  async verifyTorrent(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return false;

    const wasPausedBefore = Boolean(torrent.paused);

    // Step 1: Stop Torrent
    this.emitStatus(infoHash, 'Stopping torrent...', true);
    this.pauseTorrent(infoHash);
    await new Promise(r => setTimeout(r, 400));

    // Step 2: Verify data
    this.emitStatus(infoHash, 'Verifying data...', true);
    torrent.verifying = true;

    try {
      // 1. Remote location / swarm metadata sync: verify actual file count and sizes
      const wt = (this.client && typeof this.client.get === 'function') ? this.client.get(infoHash) : null;
      if (wt) {
        if (wt.files && Array.isArray(wt.files) && wt.files.length > 0) {
          torrent.files = wt.files;
          torrent.parsedFiles = wt.files.map((wf, idx) => ({
            index: idx,
            name: wf.name || path.basename(wf.path || '') || `File ${idx + 1}`,
            path: wf.path || wf.name || `File ${idx + 1}`,
            length: wf.length || 0
          }));
          if (wt.length) torrent.length = wt.length;
          if (wt.pieceLength) torrent.pieceLength = wt.pieceLength;
          torrent.isMultiFile = wt.files.length > 1;
        }
      } else if (torrent.torrentId && typeof torrent.torrentId === 'string' && fs.existsSync(torrent.torrentId)) {
        try {
          const meta = parseTorrentMetadata(torrent.torrentId);
          if (meta && meta.files && meta.files.length > 0) {
            torrent.parsedFiles = meta.files;
            torrent.length = meta.length;
            torrent.pieceLength = meta.pieceLength;
            torrent.isMultiFile = meta.files.length > 1;
          }
        } catch (e) {}
      }

      // 2. Scan and verify disk files (clears missing/deleted files to 0 bytes)
      this.checkDiskFiles(torrent, true);

      // 3. Rescan files with WebTorrent if active
      if (wt && typeof wt.rescanFiles === 'function') {
        await new Promise((resolve) => {
          try {
            wt.rescanFiles((err) => {
              if (!err) {
                const isAllDone = (typeof wt.progress === 'number' && wt.progress >= 1.0);
                torrent._disk_completed = isAllDone;
                if (typeof wt.downloaded === 'number') setMetric(torrent, 'downloaded', wt.downloaded);
                if (typeof wt.progress === 'number') setMetric(torrent, 'progress', wt.progress);
                if (wt.files && Array.isArray(wt.files)) {
                  wt.files.forEach((wf, i) => {
                    wf._disk_completed = (typeof wf.progress === 'number' && wf.progress >= 1.0);
                    if (torrent.files && torrent.files[i]) {
                      torrent.files[i]._disk_completed = wf._disk_completed;
                      setMetric(torrent.files[i], 'downloaded', wf.downloaded);
                      setMetric(torrent.files[i], 'progress', wf.progress);
                    }
                  });
                }
              }
              resolve();
            });
          } catch (e) {
            resolve();
          }
        });
      }

      // Final disk check to ensure accurate metrics and emit progress
      this.checkDiskFiles(torrent, true);
      this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    } catch (err) {
      console.warn('[TorrentEngine] Verification error note:', err.message);
    } finally {
      torrent.verifying = false;
    }

    await new Promise(r => setTimeout(r, 400));

    // Step 3: Update dbs
    this.emitStatus(infoHash, 'Updating database...', true);
    if (!this.disableState) {
      this.saveState();
    }
    await new Promise(r => setTimeout(r, 400));

    // Step 4: Resume Torrent
    this.emitStatus(infoHash, 'Resuming torrent...', true);
    if (getMetric(torrent, 'progress', 0) >= 1.0) {
      setMetric(torrent, 'progress', 1.0);
      if (torrent.length) setMetric(torrent, 'downloaded', torrent.length);
      this.emit('torrent-done', this.formatTorrentMeta(torrent));
      this.emit('torrent-progress', this.formatTorrentProgress(torrent));
    } else {
      // Resume torrent so it downloads the missing files!
      this.resumeTorrent(infoHash);
    }
    await new Promise(r => setTimeout(r, 400));

    // Step 5: Enable pause/resume buttons -> Done
    this.emitStatus(infoHash, 'Done', false);
    const clearTimer = setTimeout(() => {
      const t = this.torrents.get(infoHash);
      if (t && t.actionStatus === 'Done') {
        t.actionStatus = null;
        t.actionBusy = false;
        this.emit('torrent-progress', this.formatTorrentProgress(t));
        this.emit('torrent-action-status', { infoHash, status: null, buttonsDisabled: false });
      }
    }, 2500);
    if (clearTimer.unref) clearTimer.unref();

    return this.formatTorrentMeta(torrent);
  }

  /**
   * Retrieves active peer information for the floating inspector window.
   */
  getTorrentPeers(infoHash) {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return [];

    const blockedSet = torrent.blockedPeers || new Set();
    const globalBlocked = this.globalBlockedPeers || new Set();

    if (torrent.wires && Array.isArray(torrent.wires)) {
      return torrent.wires.map((wire, idx) => {
        const isSeeder = wire.isSeeder || (wire.peerPieces && typeof wire.peerPieces.isComplete === 'function' ? wire.peerPieces.isComplete() : false);
        const dlSpeed = typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0;
        const ulSpeed = typeof wire.uploadSpeed === 'function' ? wire.uploadSpeed() : 0;
        const rawAddr = wire.remoteAddress || '';
        const rawIpOnly = rawAddr.includes(':') ? rawAddr.split(':')[0] : rawAddr;
        const port = wire.remotePort || 6881;
        const address = rawAddr ? `${rawAddr}:${port}` : `Peer #${idx + 1}`;
        const clientName = wire.type || (wire.extendedMapping && wire.extendedMapping.ut_metadata ? 'BitTorrent Extension' : 'Standard BitTorrent');

        const isBlocked = blockedSet.has(rawAddr) || blockedSet.has(rawIpOnly) || blockedSet.has(address) || blockedSet.has(wire.peerId) ||
                          globalBlocked.has(rawAddr) || globalBlocked.has(rawIpOnly);
        const status = isBlocked ? 'Blocked' : (wire.peerChoking ? 'Choked' : (dlSpeed > 0 || ulSpeed > 0 ? (ulSpeed > 0 ? 'Uploading' : 'Downloading') : 'Connected'));

        const geo = geoIp.lookup(rawAddr || address);

        return {
          id: wire.peerId || `peer-${idx}`,
          address: address,
          ip: rawAddr || rawIpOnly,
          port: port,
          client: clientName,
          downloadSpeed: dlSpeed,
          uploadSpeed: ulSpeed,
          downloaded: wire.downloaded || 0,
          uploaded: wire.uploaded || 0,
          downloadedSoFar: wire.uploaded || 0, // In seeding mode, what this peer received from us
          isSeeder: isSeeder,
          status: status,
          isBlocked: isBlocked,
          countryCode: geo.countryCode,
          countryName: geo.countryName,
          flag: geo.flag
        };
      });
    }

    return [];
  }

  /**
   * Guarantees files metadata is always formatted and never empty.
   * Calculates accurate individual per-file download speed.
   */
  getFormattedFiles(t) {
    const rawFiles = (t.files && t.files.length > 0)
      ? t.files
      : (t.parsedFiles && t.parsedFiles.length > 0 ? t.parsedFiles : []);

    const now = Date.now();
    const isPaused = Boolean(t.paused);

    if (rawFiles.length > 0) {
      return rawFiles.map((f, idx) => {
        const length = f.length || 0;
        const downloaded = (typeof getMetric(f, 'downloaded', null) === 'number')
          ? getMetric(f, 'downloaded')
          : (getMetric(t, 'progress', 0) >= 1 ? length : Math.round(getMetric(t, 'progress', 0) * length));
        const prog = (typeof getMetric(f, 'progress', null) === 'number')
          ? getMetric(f, 'progress')
          : (length > 0 ? downloaded / length : getMetric(t, 'progress', 0));
        const wanted = t.file_wanted && t.file_wanted[idx] !== undefined ? t.file_wanted[idx] : true;

        // Accurate subfile downloading speed calculation
        let fileSpeed = 0;
        if (typeof f._lastSpeedDownloaded === 'number' && typeof f._lastSpeedTime === 'number') {
          const timeDelta = (now - f._lastSpeedTime) / 1000;
          if (timeDelta >= 0.4) {
            const bytesDelta = Math.max(0, downloaded - f._lastSpeedDownloaded);
            const rawRate = bytesDelta / timeDelta;
            fileSpeed = Math.round(rawRate);
            if (typeof f._smoothSpeed === 'number') {
              fileSpeed = Math.round(0.7 * fileSpeed + 0.3 * f._smoothSpeed);
            }
            f._smoothSpeed = fileSpeed;
            f._lastSpeedDownloaded = downloaded;
            f._lastSpeedTime = now;
          } else {
            fileSpeed = f._smoothSpeed || 0;
          }
        } else {
          f._lastSpeedDownloaded = downloaded;
          f._lastSpeedTime = now;
          f._smoothSpeed = 0;
          fileSpeed = 0;
        }

        if (isPaused || prog >= 1.0 || wanted === false) {
          fileSpeed = 0;
          f._smoothSpeed = 0;
        }

        return {
          index: idx,
          name: f.name || path.basename(f.path || '') || `File ${idx + 1}`,
          path: f.path || f.name || `File ${idx + 1}`,
          length: length,
          downloaded: downloaded,
          progress: Math.min(1, Math.max(0, prog)),
          downloadSpeed: fileSpeed,
          wanted: wanted
        };
      });
    }

    return [{
      index: 0,
      name: t.name || 'BitTorrent Download',
      path: t.name || 'BitTorrent Download',
      length: t.length || 0,
      downloaded: getMetric(t, 'downloaded', 0),
      progress: getMetric(t, 'progress', 0),
      downloadSpeed: t.paused ? 0 : (getMetric(t, 'downloadSpeed', 0)),
      wanted: true
    }];
  }

  formatTorrentMeta(t) {
    const formattedFiles = this.getFormattedFiles(t);
    const checkedFiles = formattedFiles.filter(f => f.wanted !== false);

    const totalFilesLen = t.length || formattedFiles.reduce((sum, f) => sum + (f.length || 0), 0);
    let checkedLen = totalFilesLen;
    let checkedDownloaded = getMetric(t, 'downloaded', 0);
    let progress = getMetric(t, 'progress', 0);

    if (formattedFiles.length > 0) {
      if (checkedFiles.length > 0) {
        checkedLen = checkedFiles.reduce((sum, f) => sum + (f.length || 0), 0);
        checkedDownloaded = checkedFiles.reduce((sum, f) => sum + (f.downloaded || 0), 0);
        progress = (checkedLen > 0) ? Math.min(1, checkedDownloaded / checkedLen) : 0;
      } else {
        checkedLen = 0;
        checkedDownloaded = 0;
        progress = 0;
      }
    } else if (totalFilesLen > 0 && checkedDownloaded > 0) {
      progress = Math.min(1, Math.max(progress, checkedDownloaded / totalFilesLen));
    }

    if (t._disk_completed || (checkedFiles.length > 0 && progress >= 1.0)) {
      progress = 1.0;
      checkedDownloaded = checkedLen;
    }

    const blockedList = Array.from(t.blockedPeers || []);

    return {
      infoHash: t.infoHash,
      name: t.name || 'BitTorrent Download',
      length: checkedLen,
      totalLength: totalFilesLen,
      checkedLength: checkedLen,
      checkedDownloaded: checkedDownloaded,
      pieceLength: t.pieceLength || 524288,
      downloaded: checkedDownloaded,
      uploaded: t.uploaded || (typeof t.uploaded === 'number' ? t.uploaded : 0),
      downloadSpeed: t.paused ? 0 : (t.numPeers > 0 ? (getMetric(t, 'downloadSpeed', 0)) : 0),
      uploadSpeed: t.paused ? 0 : (t.numPeers > 0 ? (getMetric(t, 'uploadSpeed', 0)) : 0),
      numPeers: t.numPeers || 0,
      seeders: t.numPeers || 0,
      leechers: 0,
      progress: progress,
      paused: Boolean(t.paused),
      isMultiFile: (formattedFiles && formattedFiles.length > 1) || (t.files && t.files.length > 1) || false,
      downloadPath: t.downloadPath || path.join(this.downloadDir, t.name || ''),
      verifying: Boolean(t.verifying),
      actionStatus: t.actionStatus || null,
      actionBusy: Boolean(t.actionBusy),
      file_wanted: t.file_wanted || [],
      file_priorities: t.file_priorities || [],
      files: formattedFiles,
      isMyTorrent: Boolean(t.isMyTorrent || t.createdByUser),
      createdByUser: Boolean(t.createdByUser || t.isMyTorrent),
      magnetURI: t.magnetURI || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.name || 'download')}` : ''),
      blockedPeers: blockedList
    };
  }

  formatTorrentProgress(t) {
    const formattedFiles = this.getFormattedFiles(t);
    const checkedFiles = formattedFiles.filter(f => f.wanted !== false);

    const totalFilesLen = t.length || formattedFiles.reduce((sum, f) => sum + (f.length || 0), 0);
    let checkedLen = totalFilesLen;
    let checkedDownloaded = getMetric(t, 'downloaded', 0);
    let progress = getMetric(t, 'progress', 0);

    if (formattedFiles.length > 0) {
      if (checkedFiles.length > 0) {
        checkedLen = checkedFiles.reduce((sum, f) => sum + (f.length || 0), 0);
        checkedDownloaded = checkedFiles.reduce((sum, f) => sum + (f.downloaded || 0), 0);
        progress = (checkedLen > 0) ? Math.min(1, checkedDownloaded / checkedLen) : 0;
      } else {
        checkedLen = 0;
        checkedDownloaded = 0;
        progress = 0;
      }
    } else if (totalFilesLen > 0 && checkedDownloaded > 0) {
      progress = Math.min(1, Math.max(progress, checkedDownloaded / totalFilesLen));
    }

    if (t._disk_completed || (checkedFiles.length > 0 && progress >= 1.0)) {
      progress = 1.0;
      checkedDownloaded = checkedLen;
    }

    const blockedList = Array.from(t.blockedPeers || []);

    return {
      infoHash: t.infoHash,
      name: t.name || 'BitTorrent Download',
      length: checkedLen,
      totalLength: totalFilesLen,
      checkedLength: checkedLen,
      checkedDownloaded: checkedDownloaded,
      downloaded: checkedDownloaded,
      uploaded: t.uploaded || (typeof t.uploaded === 'number' ? t.uploaded : 0),
      downloadSpeed: t.paused ? 0 : (t.numPeers > 0 ? (getMetric(t, 'downloadSpeed', 0)) : 0),
      uploadSpeed: t.paused ? 0 : (t.numPeers > 0 ? (getMetric(t, 'uploadSpeed', 0)) : 0),
      numPeers: t.numPeers || 0,
      seeders: t.numPeers || 0,
      leechers: 0,
      progress: progress,
      paused: Boolean(t.paused),
      isMultiFile: (formattedFiles && formattedFiles.length > 1) || (t.files && t.files.length > 1) || false,
      downloadPath: t.downloadPath || path.join(this.downloadDir, t.name || ''),
      verifying: Boolean(t.verifying),
      actionStatus: t.actionStatus || null,
      actionBusy: Boolean(t.actionBusy),
      files: formattedFiles,
      isMyTorrent: Boolean(t.isMyTorrent || t.createdByUser),
      createdByUser: Boolean(t.createdByUser || t.isMyTorrent),
      magnetURI: t.magnetURI || (t.infoHash ? `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.name || 'download')}` : ''),
      blockedPeers: blockedList
    };
  }

  getTorrents() {
    return Array.from(this.torrents.values()).map(t => this.formatTorrentMeta(t));
  }
}

TorrentEngine.TorrentEngine = TorrentEngine;
TorrentEngine.sanitizeTorrentInput = sanitizeTorrentInput;
TorrentEngine.extractTorrentName = extractTorrentName;
TorrentEngine.isValidWebTorrentInput = isValidWebTorrentInput;
TorrentEngine.setMetric = setMetric;
TorrentEngine.getMetric = getMetric;
TorrentEngine.hasPrototypeGetter = hasPrototypeGetter;
TorrentEngine.resolveTorrentPaths = resolveTorrentPaths;
TorrentEngine.prototype.setMetric = setMetric;
TorrentEngine.prototype.getMetric = getMetric;
TorrentEngine.prototype.hasPrototypeGetter = hasPrototypeGetter;
TorrentEngine.prototype.resolveTorrentPaths = resolveTorrentPaths;
TorrentEngine.prototype.createAndSeedTorrent = TorrentEngine.prototype.createAndSeedTorrent;
TorrentEngine.prototype.blockPeer = TorrentEngine.prototype.blockPeer;
TorrentEngine.prototype.unblockPeer = TorrentEngine.prototype.unblockPeer;
TorrentEngine.prototype.getBlockedPeers = TorrentEngine.prototype.getBlockedPeers;
TorrentEngine.prototype.isPeerBlocked = TorrentEngine.prototype.isPeerBlocked;
TorrentEngine.geoIp = geoIp;
TorrentEngine.prototype.geoIp = geoIp;

module.exports = TorrentEngine;
