// Torrently Light UI Controller & Transmission Swarm Wiring

document.addEventListener('DOMContentLoaded', async () => {
  let ipcRenderer = null;
  try {
    const electron = require('electron');
    ipcRenderer = electron.ipcRenderer;
  } catch (e) {
    console.warn('Running in standalone browser preview mode.');
  }

  let mUtils = window.mediaUtils;
  if (!mUtils) {
    try {
      mUtils = require('./mediaUtils');
    } catch (e) {
      console.warn('mediaUtils loaded from fallback');
    }
  }
  const isAudioOrVideoFile = mUtils ? mUtils.isAudioOrVideoFile : (fn) => /\.(mp4|m4v|mkv|webm|avi|mov|wmv|flv|3gp|ts|ogv|mpg|mpeg|vob|mp3|wav|flac|aac|ogg|m4a|wma|opus|mka)$/i.test(fn || '');
  const shouldShowMainStreamButton = mUtils ? mUtils.shouldShowMainStreamButton : (torrent, files) => {
    if (!torrent || torrent.isMultiFile) return false;
    const f = files || torrent.files || [];
    if (f.length > 1) return false;
    const target = (f.length === 1 && f[0] && f[0].name) ? f[0].name : (torrent.name || '');
    return isAudioOrVideoFile(target);
  };

  const torrentCardsMap = new Map();
  const torrentDataMap = new Map();
  const expandedTorrents = new Set();
  let defaultSavePath = '~/Downloads/Torrently';
  let pendingTorrentSource = null;
  let activeStreamUrl = null;
  let pendingRemoveHash = null;
  let activeInspectorHash = null;
  let inspectorInterval = null;
  let completionSoundEnabled = true;
  let completionNotifyEnabled = true;

  // Sanitizes and trims pasted torrent links, stripping surrounding brackets, quotes, and trailing sentence punctuation
  function sanitizeTorrentInput(input) {
    if (!input) return '';
    let s = String(input).trim();
    // Strip wrapping quotes, brackets, and markdown backticks
    s = s.replace(/^[<"'\s`]+|[>"'\s`]+$/g, '').trim();

    // If string contains a magnet URI anywhere, extract the full magnet URI
    const magnetMatch = s.match(/(magnet:\?xt=urn:btih:[a-zA-Z0-9]+[^\s<>"`]*)/i);
    if (magnetMatch) {
      let uri = magnetMatch[1];
      // Strip trailing punctuation like .,;: attached to sentence ends
      uri = uri.replace(/[.,;:]+$/, '');
      return uri;
    }


    // Strip trailing punctuation from hash or URL
    s = s.replace(/[.,;:]+$/, '').trim();
    return s;
  }


  // Extracts clean friendly display name from magnet links, hashes, or torrent paths
  function extractTorrentName(torrentInput, fallback = 'BitTorrent Download') {
    if (!torrentInput) return fallback;
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
      const base = input.split(/[/\\]/).pop();
      return base.replace('.torrent', '') || fallback;
    }
    if (/^[0-9a-fA-F]{40}$/.test(input) || /^[2-7a-zA-Z]{32}$/.test(input)) {
      return `Torrent_${input.substring(0, 10)}`;
    }
    return fallback;
  }

  // Synthesize gentle completion chime (587Hz -> 880Hz)
  function playCompletionChime() {
    if (!completionSoundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880.0, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.warn('Audio chime notice:', e);
    }
  }

  // Navigation Tab View Switching
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.getAttribute('data-tab');

      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      viewSections.forEach(sec => {
        sec.classList.remove('active');
        if (sec.id === `${targetTab}-view`) {
          sec.classList.add('active');
        }
      });
      checkEmptyState();
    });
  });

  function checkEmptyState() {
    const activeList = document.getElementById('torrent-list');
    if (activeList) {
      const activeCards = activeList.querySelectorAll('.torrent-card-compact');
      let emptyState = document.getElementById('empty-state');
      if (activeCards.length === 0) {
        if (!emptyState) {
          const emptyDiv = document.createElement('div');
          emptyDiv.className = 'empty-state';
          emptyDiv.id = 'empty-state';
          emptyDiv.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 40px; font-size: 13px;">No active downloads. Click <b>Add Magnet Link</b> or <b>Open .torrent</b> to begin.</p>`;
          activeList.appendChild(emptyDiv);
        }
      } else if (emptyState) {
        emptyState.remove();
      }
    }

    const compList = document.getElementById('completed-list');
    if (compList) {
      const compCards = compList.querySelectorAll('.torrent-card-compact');
      let compEmpty = document.getElementById('completed-empty-state');
      if (compCards.length === 0) {
        if (!compEmpty) {
          const emptyDiv = document.createElement('div');
          emptyDiv.className = 'empty-state';
          emptyDiv.id = 'completed-empty-state';
          emptyDiv.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 40px; font-size: 13px;">No completed downloads yet.</p>`;
          compList.appendChild(emptyDiv);
        }
      } else if (compEmpty) {
        compEmpty.remove();
      }
    }

    const myList = document.getElementById('my-torrents-list');
    const myEmpty = document.getElementById('my-torrents-empty');
    if (myList && myEmpty) {
      const myCards = myList.querySelectorAll('.torrent-card-compact');
      if (myCards.length === 0) {
        myEmpty.style.display = 'flex';
      } else {
        myEmpty.style.display = 'none';
      }
    }
  }

  // Refresh Action Button Handler
  const btnRefreshList = document.getElementById('btn-refresh-list');
  if (btnRefreshList) {
    btnRefreshList.addEventListener('click', async () => {
      if (ipcRenderer) {
        try {
          const torrents = await ipcRenderer.invoke('get-torrents');
          if (Array.isArray(torrents)) {
            const activeHashes = new Set(torrents.map(t => t.infoHash));
            torrentCardsMap.forEach((card, hash) => {
              if (!activeHashes.has(hash)) {
                card.remove();
                torrentCardsMap.delete(hash);
                torrentDataMap.delete(hash);
              }
            });
            torrents.forEach(t => renderTorrentCard(t));
            checkEmptyState();
          }
        } catch (e) {
          console.warn('Error refreshing torrent list:', e);
        }
      }
    });
  }

  // Magnet Modal Handler
  const magnetModal = document.getElementById('magnet-modal');
  const btnAddMagnet = document.getElementById('btn-add-magnet');
  const btnCloseMagnet = document.getElementById('btn-close-magnet');
  const btnCancelMagnet = document.getElementById('btn-cancel-magnet');
  const btnSubmitMagnetNext = document.getElementById('btn-submit-magnet-next');
  const magnetInput = document.getElementById('magnet-input');

  // Transmission-Exact Open Torrent Elements
  const addPromptModal = document.getElementById('add-prompt-modal');
  const btnClosePrompt = document.getElementById('btn-close-prompt');
  const btnCancelPrompt = document.getElementById('btn-cancel-prompt');
  const btnSubmitPrompt = document.getElementById('btn-submit-prompt');
  const promptSavePath = document.getElementById('prompt-save-path');
  const btnPromptBrowse = document.getElementById('btn-prompt-browse');
  const btnBrowseFolderDialog = document.getElementById('btn-browse-folder-dialog');
  const promptSourceText = document.getElementById('prompt-source-text');
  const promptFreeSpace = document.getElementById('prompt-free-space');
  const promptFileTreeContainer = document.getElementById('prompt-file-tree-container');
  const promptStartCheckbox = document.getElementById('prompt-start-checkbox');
  const promptTrashCheckbox = document.getElementById('prompt-trash-checkbox');
  const promptGlobalPriority = document.getElementById('prompt-global-priority');

  // Remove Options Modal Elements
  const removeModal = document.getElementById('remove-modal');
  const btnCloseRemove = document.getElementById('btn-close-remove');
  const btnCancelRemove = document.getElementById('btn-cancel-remove');
  const btnRemoveList = document.getElementById('btn-remove-list');
  const btnRemoveDelete = document.getElementById('btn-remove-delete');
  const removeTorrentTitle = document.getElementById('remove-torrent-title');

  // Floating Live Peers Modal Elements
  const peersModal = document.getElementById('peers-modal');
  const peersTorrentName = document.getElementById('peers-torrent-name');
  const peersCountBadge = document.getElementById('peers-count-badge');
  const peersTableBody = document.getElementById('peers-table-body');
  const btnClosePeers = document.getElementById('btn-close-peers');

  // Create Torrent Modal Elements
  const createTorrentModal = document.getElementById('create-torrent-modal');
  const btnCloseCreateModal = document.getElementById('btn-close-create-modal');
  const btnCancelCreate = document.getElementById('btn-cancel-create');
  const btnSubmitCreate = document.getElementById('btn-submit-create');
  const btnChooseCreateFile = document.getElementById('btn-choose-create-file');
  const btnChooseCreateFolder = document.getElementById('btn-choose-create-folder');
  const createSourcePreview = document.getElementById('create-source-preview');
  const createTorrentNameInput = document.getElementById('create-torrent-name');
  const createTorrentTrackersInput = document.getElementById('create-torrent-trackers');
  const createStartSeedingCheckbox = document.getElementById('create-start-seeding');
  const createPrivateCheckbox = document.getElementById('create-private-torrent');
  const btnCreateTorrentTop = document.getElementById('btn-create-torrent-top');
  const btnEmptyCreateFile = document.getElementById('btn-empty-create-file');
  const btnEmptyCreateFolder = document.getElementById('btn-empty-create-folder');
  const emptyPlusBtn = document.getElementById('empty-plus-btn');

  // Share Modal Elements
  const shareModal = document.getElementById('share-modal');
  const shareModalTitle = document.getElementById('share-modal-title');
  const shareModalSize = document.getElementById('share-modal-size');
  const shareModalFiles = document.getElementById('share-modal-files');
  const shareModalNodes = document.getElementById('share-modal-nodes');
  const shareSourceBadge = document.getElementById('share-source-badge');
  const shareMagnetInput = document.getElementById('share-magnet-input');
  const btnCopyShareMagnet = document.getElementById('btn-copy-share-magnet');
  const magnetCopyBadge = document.getElementById('magnet-copy-badge');
  const btnDownloadShareTorrent = document.getElementById('btn-download-share-torrent');
  const shareInfohashInput = document.getElementById('share-infohash-input');
  const btnCopyShareHash = document.getElementById('btn-copy-share-hash');
  const hashCopyBadge = document.getElementById('hash-copy-badge');
  const btnCloseShareModal = document.getElementById('btn-close-share-modal');
  const btnCloseShareDone = document.getElementById('btn-close-share-done');
  const btnTopShare = document.getElementById('btn-top-share');

  let activeShareInfoHash = null;
  let selectedCreateSource = null;

  const DEFAULT_SWARM_TRACKERS = [
    'udp://tracker.opentrackers.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://public.popcorn-tracker.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'http://tracker.openbittorrent.com:80/announce'
  ].join('\n');

  window.openShareModal = async function(infoHash) {
    activeShareInfoHash = infoHash;
    if (!shareModal) return;

    let t = torrentDataMap.get(infoHash);
    let shareInfo = null;
    if (ipcRenderer) {
      try {
        shareInfo = await ipcRenderer.invoke('get-torrent-share-info', infoHash);
      } catch (e) {}
    }

    const title = (shareInfo && shareInfo.name) || (t && t.name) || 'Torrent';
    const size = (shareInfo && shareInfo.totalSizeText) || (t && t.totalSizeText) || (t && formatBytes(t.length)) || '0 B';
    const filesCount = (shareInfo && shareInfo.filesCount) || (t && t.files && t.files.length) || 1;
    const isMulti = (shareInfo && shareInfo.isMultiFile) || (t && t.isMultiFile) || filesCount > 1;
    const nodesCount = (shareInfo && shareInfo.numPeers) || (t && t.numPeers) || 0;
    const isMy = (shareInfo && shareInfo.isMyTorrent) || (t && t.isMyTorrent);
    const magnet = (shareInfo && shareInfo.magnetURI) || (t && t.magnetURI) || `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;

    if (shareModalTitle) shareModalTitle.textContent = title;
    if (shareModalSize) shareModalSize.textContent = size;
    if (shareModalFiles) shareModalFiles.textContent = `${filesCount} ${filesCount === 1 ? 'file' : 'files'}${isMulti ? ' (Directory)' : ''}`;
    if (shareModalNodes) shareModalNodes.textContent = `${nodesCount} connected ${nodesCount === 1 ? 'node' : 'nodes'}`;
    if (shareSourceBadge) {
      shareSourceBadge.textContent = isMy ? 'SEEDING SOURCE' : 'ACTIVE TORRENT';
      shareSourceBadge.style.background = isMy ? '#D1FAE5' : '#E0F2FE';
      shareSourceBadge.style.color = isMy ? '#047857' : '#0369A1';
      shareSourceBadge.style.borderColor = isMy ? '#A7F3D0' : '#BAE6FD';
    }

    if (shareMagnetInput) shareMagnetInput.value = magnet;
    if (shareInfohashInput) shareInfohashInput.value = infoHash;
    if (magnetCopyBadge) magnetCopyBadge.style.display = 'none';
    if (hashCopyBadge) hashCopyBadge.style.display = 'none';

    shareModal.classList.add('active');
  };

  function closeShareModal() {
    if (shareModal) shareModal.classList.remove('active');
    activeShareInfoHash = null;
  }

  function openCreateTorrentModal(initialSourceType = null) {
    if (createTorrentModal) {
      createTorrentModal.classList.add('active');
      if (createTorrentTrackersInput && !createTorrentTrackersInput.value.trim()) {
        createTorrentTrackersInput.value = DEFAULT_SWARM_TRACKERS;
      }
      if (initialSourceType === 'file') {
        chooseCreateSource('file');
      } else if (initialSourceType === 'folder') {
        chooseCreateSource('folder');
      }
    }
  }

  function closeCreateTorrentModal() {
    if (createTorrentModal) {
      createTorrentModal.classList.remove('active');
    }
    selectedCreateSource = null;
    if (createSourcePreview) {
      createSourcePreview.innerHTML = '<span class="preview-placeholder">No source selected yet. Pick a single file or a directory containing all files and folders.</span>';
    }
    if (createTorrentNameInput) createTorrentNameInput.value = '';
    if (btnSubmitCreate) btnSubmitCreate.disabled = true;
  }

  async function chooseCreateSource(type) {
    if (!ipcRenderer) return;
    try {
      const source = await ipcRenderer.invoke('select-create-source', type);
      if (source && source.path) {
        selectedCreateSource = source;
        const typeBadge = source.isDirectory ? '<span class="source-badge">DIRECTORY</span>' : '<span class="source-badge">FILE</span>';
        const sizeInfo = source.isDirectory ? 'All sub-files & folders auto-included' : formatBytes(source.size);
        createSourcePreview.innerHTML = `
          <div class="source-selected-info">
            <div>
              ${typeBadge}
              <strong style="margin-left: 6px; color: #0F172A;">${source.name}</strong>
              <div style="font-size: 11px; color: #64748B; margin-top: 2px;">📁 ${source.path} (${sizeInfo})</div>
            </div>
          </div>
        `;
        if (createTorrentNameInput && !createTorrentNameInput.value.trim()) {
          createTorrentNameInput.value = source.name;
        }
        if (btnSubmitCreate) btnSubmitCreate.disabled = false;
      }
    } catch (err) {
      console.warn('Source selection note:', err);
    }
  }

  async function openMagnetModal() {
    magnetModal.classList.add('active');

    // Auto-detect and paste torrent/magnet link from clipboard
    let clipText = '';
    try {
      if (typeof require !== 'undefined') {
        const { clipboard } = require('electron');
        clipText = clipboard.readText() || '';
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        clipText = (await navigator.clipboard.readText()) || '';
      }
    } catch (e) {
      console.warn('Clipboard read note:', e.message);
    }

    if (clipText) {
      const sanitized = sanitizeTorrentInput(clipText);
      if (sanitized && (
        sanitized.startsWith('magnet:?') ||
        /^[0-9a-fA-F]{40}$/.test(sanitized) ||
        /^[2-7a-zA-Z]{32}$/.test(sanitized) ||
        sanitized.endsWith('.torrent') ||
        sanitized.startsWith('http://') ||
        sanitized.startsWith('https://')
      )) {
        magnetInput.value = sanitized;
        magnetInput.select();
      }
    }

    magnetInput.focus();
  }


  function closeMagnetModal() {
    magnetModal.classList.remove('active');
    magnetInput.value = '';
  }

  function getMediaIconSVG(fileName) {
    if (fileName && isAudioOrVideoFile(fileName)) {
      return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
    }
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }

  async function openPromptModal(torrentSource, torrentMeta = null) {
    pendingTorrentSource = sanitizeTorrentInput(torrentSource);
    const friendlyName = torrentMeta && torrentMeta.name
      ? torrentMeta.name
      : extractTorrentName(pendingTorrentSource);

    if (promptSourceText) {
      promptSourceText.textContent = friendlyName;
    }
    if (promptSavePath) promptSavePath.value = defaultSavePath;
    if (promptStartCheckbox) promptStartCheckbox.checked = true;
    if (promptTrashCheckbox) promptTrashCheckbox.checked = false;

    let parsed = torrentMeta;
    if (!parsed && ipcRenderer && typeof pendingTorrentSource === 'string' && (pendingTorrentSource.endsWith('.torrent') || pendingTorrentSource.startsWith('/'))) {
      try {
        parsed = await ipcRenderer.invoke('parse-torrent-file', pendingTorrentSource);
      } catch (e) {
        console.warn('Error fetching Bencode metadata:', e);
      }
    }

    const freeBytes = parsed && parsed.freeSpace ? parsed.freeSpace : 38150000000;
    if (promptFreeSpace) promptFreeSpace.textContent = `${formatBytes(freeBytes)} free`;

    renderTransmissionTable(parsed, pendingTorrentSource);
    addPromptModal.classList.add('active');

    if (btnSubmitPrompt) btnSubmitPrompt.focus();
  }

  function renderTransmissionTable(parsed, torrentSource) {
    if (!promptFileTreeContainer) return;

    let files = [];
    if (parsed && Array.isArray(parsed.files) && parsed.files.length > 0) {
      files = parsed.files;
    } else {
      const friendlyName = extractTorrentName(torrentSource);
      files = [{
        index: 0,
        name: friendlyName,
        length: parsed && parsed.length ? parsed.length : 0
      }];
    }

    let rowsHTML = '';
    files.forEach((f, idx) => {
      const displaySize = f.length && f.length > 0 ? formatBytes(f.length) : 'Fetching metadata...';
      rowsHTML += `
        <div class="transmission-table-row" data-index="${idx}">
          <span class="col-file" title="${f.name}">
            ${getMediaIconSVG()}
            <span>${f.name}</span>
          </span>
          <span class="col-size">${displaySize}</span>
          <span class="col-dl">
            <input type="checkbox" class="transmission-cb" data-file-idx="${idx}" checked>
          </span>
          <span class="col-prio">
            <select class="transmission-select row-prio" data-file-idx="${idx}" style="font-size: 10px; padding: 1px 4px;">
              <option value="normal" selected>Normal</option>
              <option value="high">High</option>
              <option value="low">Low</option>
            </select>
          </span>
        </div>
      `;
    });

    promptFileTreeContainer.innerHTML = rowsHTML;
  }

  function closePromptModal() {
    addPromptModal.classList.remove('active');
    pendingTorrentSource = null;
  }

  function openRemoveModal(infoHash, torrentName) {
    pendingRemoveHash = infoHash;
    if (removeTorrentTitle) {
      removeTorrentTitle.textContent = torrentName || 'Torrent';
      removeTorrentTitle.title = torrentName || 'Torrent';
    }
    if (removeModal) removeModal.classList.add('active');
  }

  function closeRemoveModal() {
    if (removeModal) removeModal.classList.remove('active');
    pendingRemoveHash = null;
  }

  // Floating Peers Inspector Controller
  async function refreshPeersInspector() {
    if (!activeInspectorHash || !ipcRenderer) return;
    try {
      const peers = await ipcRenderer.invoke('get-torrent-peers', activeInspectorHash);
      if (peersCountBadge) {
        peersCountBadge.textContent = `${peers.length} Peers`;
      }

      if (!peersTableBody) return;
      if (!Array.isArray(peers) || peers.length === 0) {
        peersTableBody.innerHTML = `<div class="peers-empty">Searching for peers in swarm...</div>`;
        return;
      }

      let html = '';
      peers.forEach(p => {
        const typeClass = p.isSeeder ? 'peer-type-seeder' : 'peer-type-leecher';
        const typeLabel = p.isSeeder ? 'Seeder' : 'Leecher';
        const dl = formatSpeed(p.downloadSpeed || 0);
        const ul = formatSpeed(p.uploadSpeed || 0);
        const transferredSoFar = formatBytes(p.downloadedSoFar || p.uploaded || 0);
        const dataTransferred = `${formatBytes(p.downloaded || 0)} / ${transferredSoFar}`;
        const flagEmoji = p.flag || (typeof countryCodeToFlag === 'function' ? countryCodeToFlag(p.countryCode) : '🌐');
        const countryTitle = p.countryName || p.countryCode || 'Unknown Location';
        const peerAddrOrIp = p.ip || p.address;

        const actionBtn = p.isBlocked
          ? `<button class="btn-peer-unblock" onclick="event.stopPropagation(); unblockPeerNode('${activeInspectorHash}', '${peerAddrOrIp}')" title="Unblock this node">Unblock</button>`
          : `<button class="btn-peer-block" onclick="event.stopPropagation(); blockPeerNode('${activeInspectorHash}', '${peerAddrOrIp}')" title="Block this node from transferring data">Block</button>`;

        html += `
          <div class="peer-row">
            <span class="peer-addr" title="${countryTitle} - ${p.address}">
              <span class="peer-flag" title="${countryTitle}">${flagEmoji}</span>
              <span class="peer-ip-text">${p.address}</span>
            </span>
            <span class="${typeClass}">${typeLabel}</span>
            <span>↓ ${dl}</span>
            <span>↑ ${ul}</span>
            <span title="Received / Downloaded so far by node">${dataTransferred}</span>
            <span>${p.status}</span>
            <span class="col-peer-action">${actionBtn}</span>
          </div>
        `;
      });
      peersTableBody.innerHTML = html;
    } catch (e) {
      console.warn('Error fetching peer details:', e);
    }
  }

  window.blockPeerNode = async function(infoHash, peerAddr) {
    if (!ipcRenderer || !infoHash || !peerAddr) return;
    try {
      await ipcRenderer.invoke('block-peer', { infoHash, peerAddress: peerAddr });
      await refreshPeersInspector();
    } catch (err) {
      console.warn('Block peer note:', err);
    }
  };

  window.unblockPeerNode = async function(infoHash, peerAddr) {
    if (!ipcRenderer || !infoHash || !peerAddr) return;
    try {
      await ipcRenderer.invoke('unblock-peer', { infoHash, peerAddress: peerAddr });
      await refreshPeersInspector();
    } catch (err) {
      console.warn('Unblock peer note:', err);
    }
  };

  window.openPeersInspector = function(infoHash, torrentName) {
    activeInspectorHash = infoHash;
    if (peersTorrentName) peersTorrentName.textContent = torrentName || 'Swarm Peers & Seeders';
    if (peersModal) peersModal.classList.add('active');

    refreshPeersInspector();

    if (inspectorInterval) clearInterval(inspectorInterval);
    inspectorInterval = setInterval(refreshPeersInspector, 1500);
  };

  function closePeersInspector() {
    activeInspectorHash = null;
    if (inspectorInterval) {
      clearInterval(inspectorInterval);
      inspectorInterval = null;
    }
    if (peersModal) peersModal.classList.remove('active');
  }

  if (btnClosePeers) btnClosePeers.addEventListener('click', closePeersInspector);

  if (btnAddMagnet) btnAddMagnet.addEventListener('click', openMagnetModal);
  if (btnCloseMagnet) btnCloseMagnet.addEventListener('click', closeMagnetModal);
  if (btnCancelMagnet) btnCancelMagnet.addEventListener('click', closeMagnetModal);

  if (btnSubmitMagnetNext) {
    btnSubmitMagnetNext.addEventListener('click', async () => {
      const rawVal = magnetInput.value;
      const val = sanitizeTorrentInput(rawVal);
      if (!val) {
        alert('Please enter a valid magnet link or torrent hash.');
        return;
      }
      if (!val.startsWith('magnet:?') && !/^[0-9a-fA-F]{40}$/.test(val) && !/^[2-7a-zA-Z]{32}$/.test(val) && !val.startsWith('http://') && !val.startsWith('https://')) {
        alert('Unrecognized torrent link. Please paste a link starting with magnet:? or a valid 40-character infoHash.');
        return;
      }
      closeMagnetModal();
      await openPromptModal(val);
    });
  }

  // Global clipboard paste support (Cmd+V / Ctrl+V anywhere on window)
  window.addEventListener('paste', async (e) => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    const pastedText = sanitizeTorrentInput(e.clipboardData.getData('text'));
    if (pastedText && (pastedText.startsWith('magnet:?') || /^[0-9a-fA-F]{40}$/.test(pastedText) || pastedText.endsWith('.torrent'))) {
      e.preventDefault();
      await openPromptModal(pastedText);
    }
  });

  // Open .torrent File Button
  const btnOpenFile = document.getElementById('btn-open-file');
  if (btnOpenFile) {
    btnOpenFile.addEventListener('click', async () => {
      if (ipcRenderer) {
        const filePath = await ipcRenderer.invoke('select-torrent-file');
        if (filePath) {
          await openPromptModal(filePath);
        }
      } else {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.torrent';
        fileInput.onchange = async (e) => {
          const file = e.target.files[0];
          if (file) {
            await openPromptModal(file.name);
          }
        };
        fileInput.click();
      }
    });
  }

  const handleBrowseFolder = async () => {
    if (ipcRenderer) {
      const chosenPath = await ipcRenderer.invoke('select-folder');
      if (chosenPath && promptSavePath) {
        promptSavePath.value = chosenPath;
      }
    }
  };

  if (btnPromptBrowse) btnPromptBrowse.addEventListener('click', handleBrowseFolder);
  if (btnBrowseFolderDialog) btnBrowseFolderDialog.addEventListener('click', handleBrowseFolder);

  if (btnClosePrompt) btnClosePrompt.addEventListener('click', closePromptModal);
  if (btnCancelPrompt) btnCancelPrompt.addEventListener('click', closePromptModal);

  if (btnSubmitPrompt) {
    btnSubmitPrompt.addEventListener('click', async () => {
      if (!pendingTorrentSource) return;

      const customPath = promptSavePath.value.trim() || defaultSavePath;
      const startImmediately = promptStartCheckbox ? promptStartCheckbox.checked : true;
      const moveToTrash = promptTrashCheckbox ? promptTrashCheckbox.checked : false;
      const priority = promptGlobalPriority ? promptGlobalPriority.value : 'normal';

      const fileWanted = [];
      const filePriorities = [];

      const rowCbs = promptFileTreeContainer.querySelectorAll('.transmission-cb');
      rowCbs.forEach(cb => {
        fileWanted.push(cb.checked);
      });

      const rowPrios = promptFileTreeContainer.querySelectorAll('.row-prio');
      rowPrios.forEach(sel => {
        filePriorities.push(sel.value);
      });

      const payload = {
        torrentId: pendingTorrentSource,
        downloadPath: customPath,
        paused: !startImmediately,
        moveToTrash: moveToTrash,
        priority: priority,
        file_wanted: fileWanted,
        file_priorities: filePriorities
      };

      closePromptModal();

      if (ipcRenderer) {
        await ipcRenderer.invoke('add-torrent', payload);
        // Instant screen refresh for updated torrent list
        const torrents = await ipcRenderer.invoke('get-torrents');
        if (Array.isArray(torrents)) {
          torrents.forEach(t => renderTorrentCard(t));
        }
        checkEmptyState();
      }
    });
  }

  // Remove Modal Handlers
  if (btnCloseRemove) btnCloseRemove.addEventListener('click', closeRemoveModal);

  if (btnRemoveList) {
    btnRemoveList.addEventListener('click', async () => {
      if (!pendingRemoveHash) return;
      const targetHash = pendingRemoveHash;
      closeRemoveModal();

      if (ipcRenderer) {
        await ipcRenderer.invoke('remove-torrent', { infoHash: targetHash, deleteFiles: false });
      } else {
        removeTorrentCardDOM(targetHash);
      }
    });
  }

  if (btnRemoveDelete) {
    btnRemoveDelete.addEventListener('click', async () => {
      if (!pendingRemoveHash) return;
      const targetHash = pendingRemoveHash;
      closeRemoveModal();

      if (ipcRenderer) {
        await ipcRenderer.invoke('remove-torrent', { infoHash: targetHash, deleteFiles: true });
      } else {
        removeTorrentCardDOM(targetHash);
      }
    });
  }

  // Preferences Management
  const prefSavePath = document.getElementById('pref-save-path');
  const prefDlLimit = document.getElementById('pref-dl-limit');
  const prefUlLimit = document.getElementById('pref-ul-limit');
  const prefMaxDownloads = document.getElementById('pref-max-downloads');
  const prefCompletionSound = document.getElementById('pref-completion-sound');
  const prefCompletionNotify = document.getElementById('pref-completion-notify');
  const btnBrowseFolder = document.getElementById('btn-browse-folder');
  const btnSavePrefs = document.getElementById('btn-save-prefs');

  if (ipcRenderer) {
    try {
      const prefs = await ipcRenderer.invoke('get-preferences');
      if (prefs) {
        if (prefs.savePath) {
          defaultSavePath = prefs.savePath;
          if (prefSavePath) prefSavePath.value = prefs.savePath;
        }
        if (prefDlLimit) prefDlLimit.value = prefs.downloadLimit || 0;
        if (prefUlLimit) prefUlLimit.value = prefs.uploadLimit || 0;
        if (prefMaxDownloads) prefMaxDownloads.value = prefs.maxDownloads || 3;

        if (prefs.playCompletionSound !== undefined) {
          completionSoundEnabled = !!prefs.playCompletionSound;
          if (prefCompletionSound) prefCompletionSound.checked = completionSoundEnabled;
        }
        if (prefs.showCompletionNotification !== undefined) {
          completionNotifyEnabled = !!prefs.showCompletionNotification;
          if (prefCompletionNotify) prefCompletionNotify.checked = completionNotifyEnabled;
        }
      }
    } catch (err) {
      console.warn('Error loading preferences:', err);
    }
  }

  if (btnBrowseFolder) {
    btnBrowseFolder.addEventListener('click', async () => {
      if (ipcRenderer) {
        const chosenPath = await ipcRenderer.invoke('select-folder');
        if (chosenPath && prefSavePath) {
          prefSavePath.value = chosenPath;
          defaultSavePath = chosenPath;
        }
      }
    });
  }

  if (btnSavePrefs) {
    btnSavePrefs.addEventListener('click', async () => {
      completionSoundEnabled = prefCompletionSound ? prefCompletionSound.checked : true;
      completionNotifyEnabled = prefCompletionNotify ? prefCompletionNotify.checked : true;

      const updated = {
        savePath: prefSavePath.value.trim(),
        downloadLimit: parseInt(prefDlLimit.value, 10) || 0,
        uploadLimit: parseInt(prefUlLimit.value, 10) || 0,
        maxDownloads: parseInt(prefMaxDownloads.value, 10) || 3,
        playCompletionSound: completionSoundEnabled,
        showCompletionNotification: completionNotifyEnabled
      };
      defaultSavePath = updated.savePath;

      if (ipcRenderer) {
        await ipcRenderer.invoke('save-preferences', updated);
      }
      alert('Preferences saved successfully!');
    });
  }

  // Media Player Modal
  const playerModal = document.getElementById('player-modal');
  const btnClosePlayer = document.getElementById('btn-close-player');
  const btnExternalVlc = document.getElementById('btn-external-vlc');
  const videoElement = document.getElementById('video-element');
  const playerTitle = document.getElementById('player-title');

  const STORAGE_KEY_VOLUME = 'torrently_player_volume';
  const STORAGE_KEY_MUTED = 'torrently_player_muted';

  function restoreVideoAudio(el) {
    if (!el) return;
    try {
      const savedVolume = localStorage.getItem(STORAGE_KEY_VOLUME);
      if (savedVolume !== null) {
        const vol = parseFloat(savedVolume);
        if (!isNaN(vol) && vol >= 0 && vol <= 1) {
          el.volume = vol;
        }
      }
      const savedMuted = localStorage.getItem(STORAGE_KEY_MUTED);
      if (savedMuted !== null) {
        el.muted = (savedMuted === 'true');
      }
    } catch (e) {}
  }

  function saveVideoAudio(el) {
    if (!el) return;
    try {
      localStorage.setItem(STORAGE_KEY_VOLUME, el.volume.toString());
      localStorage.setItem(STORAGE_KEY_MUTED, el.muted ? 'true' : 'false');
      if (ipcRenderer) {
        ipcRenderer.invoke('save-player-audio-settings', { volume: el.volume, muted: el.muted }).catch(() => {});
      }
    } catch (e) {}
  }

  if (videoElement) {
    restoreVideoAudio(videoElement);
    videoElement.addEventListener('volumechange', () => saveVideoAudio(videoElement));
    videoElement.addEventListener('loadedmetadata', () => restoreVideoAudio(videoElement));
  }

  window.openPlayer = async function(streamUrl, title) {
    activeStreamUrl = streamUrl;
    if (ipcRenderer) {
      try {
        await ipcRenderer.invoke('open-player-window', { streamUrl, title });
        return;
      } catch (err) {
        console.warn('Could not open separate player window, falling back to overlay:', err);
      }
    }

    if (playerTitle) playerTitle.textContent = title || 'Torrent Media Stream';
    if (videoElement) {
      videoElement.onerror = null;
      videoElement.src = streamUrl;
      restoreVideoAudio(videoElement);
      videoElement.load();
      restoreVideoAudio(videoElement);
      videoElement.play().catch((err) => {
        console.warn('HTML5 Video play error:', err);
      });

      videoElement.onerror = () => {
        console.warn('Video format or codec error in HTML5 player. Directing to external VLC/IINA.');
      };
    }

    if (playerModal) playerModal.classList.add('active');
  };


  if (btnExternalVlc) {
    btnExternalVlc.addEventListener('click', async () => {
      if (!activeStreamUrl) return;
      if (ipcRenderer) {
        const opened = await ipcRenderer.invoke('open-external-player', activeStreamUrl);
        if (!opened) alert(`Stream link for VLC / IINA:\n${activeStreamUrl}`);
      } else {
        alert(`Stream link for VLC / IINA:\n${activeStreamUrl}`);
      }
    });
  }

  window.showInFolder = async function(filePath) {
    if (ipcRenderer) {
      await ipcRenderer.invoke('show-in-folder', filePath || defaultSavePath);
    } else {
      alert(`Opening folder location: ${filePath || defaultSavePath}`);
    }
  };

  window.togglePauseTorrent = async function(infoHash, isPaused) {
    const card = torrentCardsMap.get(infoHash);
    if (card) {
      const pauseBtn = card.querySelector(`#btn-pause-${infoHash}`);
      if (pauseBtn) {
        const nextPaused = !isPaused;
        pauseBtn.title = nextPaused ? 'Resume Torrent' : 'Pause Torrent';
        pauseBtn.onclick = () => togglePauseTorrent(infoHash, nextPaused);
        pauseBtn.innerHTML = nextPaused
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Resume</span>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>';
      }
    }

    if (ipcRenderer) {
      if (isPaused) {
        await ipcRenderer.invoke('resume-torrent', infoHash);
      } else {
        await ipcRenderer.invoke('pause-torrent', infoHash);
      }
    }
  };

  window.confirmRemoveTorrent = function(infoHash, name) {
    openRemoveModal(infoHash, name);
  };

  function initColumnResizers(accordion) {
    if (!accordion || accordion._resizersBound) return;
    accordion._resizersBound = true;

    const resizers = accordion.querySelectorAll('.col-resizer');
    resizers.forEach((resizer) => {
      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const colName = resizer.getAttribute('data-col');
        const headerCell = resizer.closest('.col-header');
        if (!headerCell) return;

        const startX = e.clientX;
        const startWidth = headerCell.getBoundingClientRect().width;
        resizer.classList.add('resizing');
        document.body.classList.add('resizing-columns');

        const minWidths = {
          name: 120,
          size: 60,
          prog: 80,
          status: 100
        };
        const minWidth = minWidths[colName] || 50;

        const onMouseMove = (moveEvent) => {
          const deltaX = moveEvent.clientX - startX;
          const newWidth = Math.max(minWidth, Math.round(startWidth + deltaX));
          accordion.style.setProperty(`--col-${colName}`, `${newWidth}px`);
        };

        const onMouseUp = () => {
          resizer.classList.remove('resizing');
          document.body.classList.remove('resizing-columns');
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  window.toggleFilesAccordion = function(infoHash) {
    const accordion = document.getElementById(`files-accordion-${infoHash}`);
    const btn = document.getElementById(`btn-files-toggle-${infoHash}`);
    if (!accordion) return;
    if (expandedTorrents.has(infoHash)) {
      expandedTorrents.delete(infoHash);
      accordion.classList.remove('expanded');
      if (btn) btn.innerHTML = btn.innerHTML.replace('▴', '▾');
    } else {
      expandedTorrents.add(infoHash);
      accordion.classList.add('expanded');
      if (btn) btn.innerHTML = btn.innerHTML.replace('▾', '▴');
      initColumnResizers(accordion);
    }
  };

  window.toggleFileWanted = async function(infoHash, fileIndex, wanted) {
    if (ipcRenderer) {
      await ipcRenderer.invoke('set-file-wanted', { infoHash, fileIndex, wanted });
    }
  };

  window.setLocationTorrent = async function(infoHash) {
    if (!ipcRenderer) return;
    const card = torrentCardsMap.get(infoHash);
    const locBtn = card ? card.querySelector(`#btn-location-${infoHash}`) : null;
    if (locBtn && locBtn.disabled) return;

    try {
      const chosenPath = await ipcRenderer.invoke('select-folder');
      if (!chosenPath) return;

      // Immediately disable buttons for responsiveness
      const pauseBtn = card ? card.querySelector(`#btn-pause-${infoHash}`) : null;
      const verifyBtn = card ? card.querySelector(`#btn-verify-${infoHash}`) : null;
      if (locBtn) locBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = true;
      if (verifyBtn) verifyBtn.disabled = true;

      await ipcRenderer.invoke('set-torrent-location', {
        infoHash,
        newLocation: chosenPath
      });
    } catch (err) {
      console.warn('Set location error:', err);
    }
  };

  window.verifyLocalTorrent = async function(infoHash) {
    if (!ipcRenderer) return;
    const card = torrentCardsMap.get(infoHash);
    const verifyBtn = card ? card.querySelector(`#btn-verify-${infoHash}`) : null;
    const pauseBtn = card ? card.querySelector(`#btn-pause-${infoHash}`) : null;
    const locBtn = card ? card.querySelector(`#btn-location-${infoHash}`) : null;

    if (verifyBtn) verifyBtn.disabled = true;
    if (pauseBtn) pauseBtn.disabled = true;
    if (locBtn) locBtn.disabled = true;

    try {
      await ipcRenderer.invoke('verify-torrent', infoHash);
    } catch (err) {
      console.warn('Verify local data note:', err);
    }
  };

  function closePlayerModal() {
    if (videoElement) {
      try {
        videoElement.pause();
        videoElement.src = '';
      } catch (e) {}
    }
    if (playerModal) {
      playerModal.classList.remove('active');
    }
  }

  if (btnClosePlayer) {
    btnClosePlayer.addEventListener('click', closePlayerModal);
  }

  function closeAllModals() {
    closeRemoveModal();
    closePromptModal();
    closeMagnetModal();
    closePeersInspector();
    closePlayerModal();
    closeCreateTorrentModal();
    closeShareModal();
  }

  // Close all open dialogs on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.code === 'Escape') {
      closeAllModals();
    }
  });

  // Close modals when clicking outside modal content
  [magnetModal, addPromptModal, removeModal, playerModal, createTorrentModal, shareModal].forEach((overlay) => {
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          closeAllModals();
        }
      });
    }
  });

  // Create Torrent Dialog Triggers
  if (btnCreateTorrentTop) btnCreateTorrentTop.addEventListener('click', () => openCreateTorrentModal());
  if (btnTopShare) btnTopShare.addEventListener('click', () => openCreateTorrentModal());
  if (btnEmptyCreateFile) btnEmptyCreateFile.addEventListener('click', () => openCreateTorrentModal('file'));
  if (btnEmptyCreateFolder) btnEmptyCreateFolder.addEventListener('click', () => openCreateTorrentModal('folder'));
  if (emptyPlusBtn) emptyPlusBtn.addEventListener('click', () => openCreateTorrentModal());

  if (btnCloseCreateModal) btnCloseCreateModal.addEventListener('click', closeCreateTorrentModal);
  if (btnCancelCreate) btnCancelCreate.addEventListener('click', closeCreateTorrentModal);
  if (btnChooseCreateFile) btnChooseCreateFile.addEventListener('click', () => chooseCreateSource('file'));
  if (btnChooseCreateFolder) btnChooseCreateFolder.addEventListener('click', () => chooseCreateSource('folder'));

  if (btnCloseShareModal) btnCloseShareModal.addEventListener('click', closeShareModal);
  if (btnCloseShareDone) btnCloseShareDone.addEventListener('click', closeShareModal);

  if (btnCopyShareMagnet) {
    btnCopyShareMagnet.addEventListener('click', () => {
      const magnet = shareMagnetInput ? shareMagnetInput.value : '';
      if (!magnet) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(magnet).then(() => {
          if (magnetCopyBadge) magnetCopyBadge.style.display = 'inline';
          setTimeout(() => { if (magnetCopyBadge) magnetCopyBadge.style.display = 'none'; }, 3000);
        }).catch(() => {
          prompt('Copy Magnet Link:', magnet);
        });
      } else {
        prompt('Copy Magnet Link:', magnet);
      }
    });
  }

  if (btnCopyShareHash) {
    btnCopyShareHash.addEventListener('click', () => {
      const hash = shareInfohashInput ? shareInfohashInput.value : '';
      if (!hash) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(hash).then(() => {
          if (hashCopyBadge) hashCopyBadge.style.display = 'inline';
          setTimeout(() => { if (hashCopyBadge) hashCopyBadge.style.display = 'none'; }, 3000);
        }).catch(() => {
          prompt('Copy InfoHash:', hash);
        });
      } else {
        prompt('Copy InfoHash:', hash);
      }
    });
  }

  if (btnDownloadShareTorrent) {
    btnDownloadShareTorrent.addEventListener('click', () => {
      if (activeShareInfoHash) {
        window.exportTorrentFile(activeShareInfoHash);
      }
    });
  }

  // Drag and Drop files or folders directly into the create source selector
  const createSourceSelector = document.querySelector('.create-source-selector');
  if (createSourceSelector) {
    createSourceSelector.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      createSourceSelector.classList.add('drag-over');
    });
    createSourceSelector.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      createSourceSelector.classList.remove('drag-over');
    });
    createSourceSelector.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      createSourceSelector.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        const filePath = file.path;
        if (filePath) {
          try {
            let isDir = false;
            let fileSize = file.size || 0;
            if (typeof require !== 'undefined') {
              const fs = require('fs');
              const s = fs.statSync(filePath);
              isDir = s.isDirectory();
              if (!isDir) fileSize = s.size;
            }
            selectedCreateSource = {
              path: filePath,
              name: file.name,
              isDirectory: isDir,
              size: fileSize
            };
            const typeBadge = isDir ? '<span class="source-badge">DIRECTORY</span>' : '<span class="source-badge">FILE</span>';
            const sizeInfo = isDir ? 'All sub-files & folders auto-included' : formatBytes(fileSize);
            createSourcePreview.innerHTML = `
              <div class="source-selected-info">
                <div>
                  ${typeBadge}
                  <strong style="margin-left: 6px; color: #0F172A;">${file.name}</strong>
                  <div style="font-size: 11px; color: #64748B; margin-top: 2px;">📁 ${filePath} (${sizeInfo})</div>
                </div>
              </div>
            `;
            if (createTorrentNameInput && !createTorrentNameInput.value.trim()) {
              createTorrentNameInput.value = file.name;
            }
            if (btnSubmitCreate) btnSubmitCreate.disabled = false;
          } catch (err) {
            console.warn('Drop error:', err);
          }
        }
      }
    });
  }

  if (btnSubmitCreate) {
    btnSubmitCreate.addEventListener('click', async () => {
      if (!selectedCreateSource || !selectedCreateSource.path || !ipcRenderer) return;

      const sourcePath = selectedCreateSource.path;
      const name = (createTorrentNameInput && createTorrentNameInput.value.trim())
        ? createTorrentNameInput.value.trim()
        : selectedCreateSource.name;
      const trackersText = createTorrentTrackersInput ? createTorrentTrackersInput.value : '';
      const trackers = trackersText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('#'));
      const startSeeding = createStartSeedingCheckbox ? createStartSeedingCheckbox.checked : true;
      const isPrivate = createPrivateCheckbox ? createPrivateCheckbox.checked : false;

      btnSubmitCreate.disabled = true;
      btnSubmitCreate.innerHTML = '<span>Creating & Seeding...</span>';

      try {
        const created = await ipcRenderer.invoke('create-torrent', {
          sourcePath,
          name,
          trackers,
          private: isPrivate,
          paused: !startSeeding
        });

        closeCreateTorrentModal();

        // Switch to "My Torrents" tab automatically
        const myTabNav = document.querySelector('.nav-item[data-tab="my-torrents"]');
        if (myTabNav) myTabNav.click();

        if (created) {
          renderTorrentCard(created);
          // Automatically open the Share Modal for immediate 1-click Magnet & .torrent access!
          openShareModal(created.infoHash);
        }
      } catch (err) {
        alert(`Could not create torrent:\n${err.message || err}`);
      } finally {
        if (btnSubmitCreate) {
          btnSubmitCreate.disabled = false;
          btnSubmitCreate.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg><span>Create & Start Seeding</span>';
        }
      }
    });
  }

  // Network Speed Test Handler
  const netMeter = document.getElementById('network-speed-meter');
  const netSpeedVal = document.getElementById('global-net-speed');

  if (netMeter && netSpeedVal) {
    netMeter.addEventListener('click', async () => {
      if (!ipcRenderer || netSpeedVal.classList.contains('testing')) return;
      netSpeedVal.classList.add('testing');
      netSpeedVal.textContent = 'Testing...';

      try {
        const result = await ipcRenderer.invoke('run-network-speed-test');
        if (result && result.success) {
          netSpeedVal.textContent = `${result.speedMbps} Mbps (${result.latencyMs}ms)`;
          netSpeedVal.title = `Latency: ${result.latencyMs}ms | Throughput: ${result.speedMbps} Mbps`;
        } else {
          netSpeedVal.textContent = 'Speed Test';
        }
      } catch (e) {
        netSpeedVal.textContent = 'Speed Test';
      } finally {
        netSpeedVal.classList.remove('testing');
      }
    });
  }

  window.copyMagnetLink = function(infoHash) {
    const t = torrentDataMap.get(infoHash);
    const magnet = t ? (t.magnetURI || `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(t.name || 'download')}`) : `magnet:?xt=urn:btih:${infoHash}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(magnet).then(() => {
        alert('Magnet link copied to clipboard!');
      }).catch(() => {
        prompt('Copy Magnet Link:', magnet);
      });
    } else {
      prompt('Copy Magnet Link:', magnet);
    }
  };

  window.exportTorrentFile = async function(infoHash) {
    if (!ipcRenderer) return;
    try {
      const t = torrentDataMap.get(infoHash);
      const res = await ipcRenderer.invoke('export-torrent-file', {
        infoHash,
        defaultName: t ? t.name : 'download'
      });
      if (res) {
        alert('.torrent file successfully saved!');
      }
    } catch (err) {
      console.warn('Export .torrent error:', err);
    }
  };

  // Helper Formatters
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/s';
  }

  function removeTorrentCardDOM(infoHash) {
    const card = torrentCardsMap.get(infoHash);
    if (card) {
      card.remove();
      torrentCardsMap.delete(infoHash);
      torrentDataMap.delete(infoHash);
      expandedTorrents.delete(infoHash);
      if (activeInspectorHash === infoHash) {
        closePeersInspector();
      }
      updateCounts();
      checkEmptyState();
    }
  }

  // Render High-Performance Smooth Torrent Item Layout with Fine-Grained Node Updates
  function renderTorrentCard(t) {
    const activeList = document.getElementById('torrent-list');
    const completedList = document.getElementById('completed-list');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.remove();

    // Merge incoming data with existing data to ensure files & metadata are preserved
    const prev = torrentDataMap.get(t.infoHash) || {};
    let filesList = [];
    if (t.files && Array.isArray(t.files) && t.files.length > 1) {
      filesList = t.files;
    } else if (prev.files && Array.isArray(prev.files) && prev.files.length > 1) {
      if (t.files && Array.isArray(t.files) && t.files.length > 0) {
        filesList = prev.files.map(pf => {
          const match = t.files.find(tf => tf.index === pf.index || tf.name === pf.name);
          return match ? { ...pf, ...match } : pf;
        });
      } else {
        filesList = prev.files;
      }
    } else if (t.files && Array.isArray(t.files) && t.files.length > 0) {
      filesList = t.files;
    } else if (prev.files && Array.isArray(prev.files) && prev.files.length > 0) {
      filesList = prev.files;
    }

    const merged = { ...prev, ...t, files: filesList };
    torrentDataMap.set(t.infoHash, merged);

    const pct = Math.min(100, Math.floor((merged.progress || 0) * 100));
    const downloadedText = formatBytes(merged.downloaded || 0);
    const totalText = merged.length && merged.length > 0 ? formatBytes(merged.length) : 'Fetching metadata...';
    const downSpeedText = merged.paused ? '0 B/s' : formatSpeed(merged.downloadSpeed || 0);
    const upSpeedText = merged.paused ? '0 B/s' : formatSpeed(merged.uploadSpeed || 0);
    const singleFileIdx = (filesList.length === 1 && filesList[0].index !== undefined) ? filesList[0].index : 0;
    const streamUrl = merged.streamUrl || `http://127.0.0.1:8888/stream/${merged.infoHash}/${singleFileIdx}`;
    const saveLocation = merged.downloadPath || `${defaultSavePath}/${merged.name}`;
    const seeders = merged.seeders !== undefined ? merged.seeders : 0;
    const leechers = merged.leechers !== undefined ? merged.leechers : 0;
    const showMainStream = shouldShowMainStreamButton(merged, filesList);

    const isBusy = Boolean(merged.actionBusy);
    const actionStatus = merged.actionStatus || (merged.verifying ? 'Verifying data...' : null);

    // Compute Micro Piece Grid (12 segments)
    const segments = 12;
    const activeSegments = Math.floor((pct / 100) * segments);
    let pieceSegmentsHTML = '';
    for (let i = 0; i < segments; i++) {
      if (merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) {
        pieceSegmentsHTML += `<div class="micro-piece verifying"></div>`;
      } else if (i < activeSegments) {
        pieceSegmentsHTML += `<div class="micro-piece done"></div>`;
      } else if (i === activeSegments && pct < 100 && !merged.paused) {
        pieceSegmentsHTML += `<div class="micro-piece downloading"></div>`;
      } else {
        pieceSegmentsHTML += `<div class="micro-piece"></div>`;
      }
    }

    const statusText = actionStatus
      ? actionStatus
      : (merged.verifying
        ? 'Verifying data...'
        : (merged.paused
          ? 'Paused'
          : (pct >= 100
            ? 'Seeding'
            : (seeders === 0 && (merged.downloadSpeed || 0) === 0
              ? 'Connecting to Peers (0 Peers)...'
              : `Downloading (↓ ${downSpeedText})`))));

    const isMyTorrent = Boolean(merged.isMyTorrent || merged.createdByUser);

    function getSubfileStatusHTML(f) {
      const isWanted = f.wanted !== false;
      const subPct = Math.min(100, Math.round((f.progress || 0) * 100));
      if (!isWanted) {
        return '<span class="subfile-status status-skipped">Skipped</span>';
      }
      if (subPct >= 100) {
        return '<span class="subfile-status status-completed">Completed</span>';
      }
      if (merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) {
        return '<span class="subfile-status status-verifying">Verifying...</span>';
      }
      if (merged.paused) {
        return '<span class="subfile-status status-paused">Paused</span>';
      }
      const fileSpeed = (typeof f.downloadSpeed === 'number') ? f.downloadSpeed : 0;
      const fileSpeedText = formatSpeed(fileSpeed);
      return `<span class="subfile-status status-downloading">Downloading (↓ ${fileSpeedText})</span>`;
    }

    let card = torrentCardsMap.get(merged.infoHash);

    // Fast-path: Update existing DOM nodes without destroying innerHTML
    if (card) {
      const pctEl = card.querySelector('.compact-pct');
      if (pctEl) pctEl.textContent = actionStatus === 'Done' ? '100%' : (isBusy ? '...' : pct + '%');

      const barFill = card.querySelector('.compact-bar-fill');
      if (barFill) barFill.style.width = pct + '%';

      const pathEl = card.querySelector('.compact-path');
      if (pathEl) {
        pathEl.textContent = `📁 ${saveLocation}`;
        pathEl.title = `📁 ${saveLocation} (Click to set new location)`;
      }

      const pieceGrid = card.querySelector('.micro-piece-grid');
      if (pieceGrid) {
        pieceGrid.innerHTML = pieceSegmentsHTML;
        pieceGrid.title = statusText;
      }

      const metricsEl = card.querySelector('.compact-metrics');
      if (metricsEl) {
        const actionBadgeHTML = actionStatus
          ? `<span class="action-status-badge">${actionStatus}</span>`
          : '';
        const downSpeedHTML = `<span>${merged.paused ? 'PAUSED' : '↓ ' + downSpeedText}</span>`;

        let metricsHTML = '';
        if (isMyTorrent) {
          metricsHTML = `
            <span class="badge-my-torrent">★ SEEDING SOURCE</span>
            <span class="my-torrent-connected-nodes" title="Connected downloading nodes">👥 ${merged.numPeers || 0} Nodes</span>
            <span>↑ ${upSpeedText}</span>
            <span title="Transferred so far to swarm">⬆ ${formatBytes(merged.uploaded || 0)} transferred</span>
            <span>${totalText}</span>
          `;
        } else {
          metricsHTML = `
            <span title="Seeders / Leechers" style="color: #0F172A; font-weight: 700;">🟢 ${seeders} / 🔵 ${leechers}</span>
            ${actionBadgeHTML}
            ${downSpeedHTML}
            <span>↑ ${upSpeedText}</span>
            <span>${downloadedText} / ${totalText}</span>
          `;
        }
        metricsEl.innerHTML = metricsHTML;
      }

      const locBtn = card.querySelector(`#btn-location-${merged.infoHash}`);
      if (locBtn) {
        locBtn.disabled = Boolean(isBusy);
      }

      const verifyBtn = card.querySelector(`#btn-verify-${merged.infoHash}`);
      if (verifyBtn) {
        verifyBtn.disabled = Boolean(isBusy || merged.verifying);
        const span = verifyBtn.querySelector('span');
        if (span) span.textContent = (merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) ? 'Verifying...' : 'Verify';
      }

      const pauseBtn = card.querySelector(`#btn-pause-${merged.infoHash}`);
      if (pauseBtn) {
        pauseBtn.disabled = Boolean(isBusy);
        pauseBtn.title = merged.paused ? 'Resume Torrent' : 'Pause Torrent';
        pauseBtn.onclick = () => togglePauseTorrent(merged.infoHash, Boolean(merged.paused));
        pauseBtn.innerHTML = merged.paused
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Resume</span>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>';
      }

      // Ensure main card has no stream button (stream buttons are kept exclusively in sub-list for playable files)
      const actionsEl = card.querySelector('.compact-actions');
      if (actionsEl) {
        const existingStreamBtn = actionsEl.querySelector('.btn-main-stream');
        if (existingStreamBtn) {
          existingStreamBtn.remove();
        }
      }

      // Update per-file progress inside accordion
      let accordion = card.querySelector('.torrent-files-accordion');
      const existingRowCount = accordion ? accordion.querySelectorAll('.subfile-row').length : 0;
      if (filesList.length > 0 && (!accordion || existingRowCount !== filesList.length)) {
        card.remove();
        torrentCardsMap.delete(merged.infoHash);
        renderTorrentCard(merged);
        return;
      }
      if (accordion) {
        initColumnResizers(accordion);
      }

      const toggleBtn = card.querySelector(`#btn-files-toggle-${merged.infoHash}`);
      if (toggleBtn && filesList.length > 0) {
        const isExp = expandedTorrents.has(merged.infoHash);
        toggleBtn.innerHTML = `📁 Files (${filesList.length}) ${isExp ? '▴' : '▾'}`;
      }

      const accordionBody = card.querySelector('.files-accordion-body');
      if (accordionBody && filesList.length > 0) {
        filesList.forEach((f) => {
          const row = card.querySelector(`.subfile-row[data-file-idx="${f.index}"]`);
          if (row) {
            const isWanted = f.wanted !== false;
            const subPct = Math.min(100, Math.round((f.progress || 0) * 100));
            const subStatus = getSubfileStatusHTML(f);

            const fill = row.querySelector('.subfile-progress-fill');
            if (fill) fill.style.width = subPct + '%';

            const label = row.querySelector('.subfile-progress-label');
            if (label) label.textContent = subPct + '%';

            const statusCell = row.querySelector('.subfile-status-cell');
            if (statusCell) statusCell.innerHTML = subStatus;

            if (isWanted) row.classList.remove('deselected');
            else row.classList.add('deselected');
          }
        });
      }

      const myTorrentsList = document.getElementById('my-torrents-list');
      if (isMyTorrent && myTorrentsList) {
        if (card.parentNode !== myTorrentsList) {
          myTorrentsList.prepend(card);
        }
      } else if (pct >= 100 && !merged.verifying && !isBusy) {
        if (completedList && card.parentNode !== completedList) {
          completedList.prepend(card);
        }
      } else {
        if (activeList && card.parentNode !== activeList) {
          activeList.prepend(card);
        }
      }
      updateCounts();
      checkEmptyState();
      return;
    }

    // New card construction
    card = document.createElement('div');
    card.className = 'torrent-card-compact';
    card.id = `card-${merged.infoHash}`;
    torrentCardsMap.set(merged.infoHash, card);

    const isExpanded = expandedTorrents.has(merged.infoHash);
    let filesHTML = '';
    let filesToggleBtn = '';

    if (filesList.length > 0) {
      filesToggleBtn = `
        <button class="btn btn-secondary btn-sm" id="btn-files-toggle-${merged.infoHash}" onclick="toggleFilesAccordion('${merged.infoHash}')" title="Expand / Collapse File List">
          📁 Files (${filesList.length}) ${isExpanded ? '▴' : '▾'}
        </button>
      `;

      let rowsHTML = '';
      filesList.forEach((f) => {
        const isWanted = f.wanted !== false;
        const subPct = Math.min(100, Math.round((f.progress || 0) * 100));
        const subStatus = getSubfileStatusHTML(f);

        const isFileMedia = isAudioOrVideoFile(f.name);
        const fileStreamUrl = `http://127.0.0.1:8888/stream/${merged.infoHash}/${f.index}`;
        const escapedSubName = f.name.replace(/'/g, "\\'");

        const subStreamBtn = isFileMedia
          ? `<button class="btn btn-primary btn-xs subfile-play-btn" onclick="event.stopPropagation(); openPlayer('${fileStreamUrl}', '${escapedSubName}')" title="Play / Stream ${escapedSubName}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span>Stream</span>
            </button>`
          : '';

        rowsHTML += `
          <div class="subfile-row ${isWanted ? '' : 'deselected'}" data-file-idx="${f.index}">
            <input type="checkbox" class="subfile-checkbox" ${isWanted ? 'checked' : ''} onchange="toggleFileWanted('${merged.infoHash}', ${f.index}, this.checked)" title="Include / Skip File">
            <span class="subfile-name" title="${f.name}">
              ${getMediaIconSVG(f.name)}
              <span>${f.name}</span>
            </span>
            <span class="subfile-size">${formatBytes(f.length)}</span>
            <div class="subfile-progress-box" title="${subPct}% completed">
              <div class="subfile-progress-fill" style="width: ${subPct}%;"></div>
              <span class="subfile-progress-label">${subPct}%</span>
            </div>
            <span class="subfile-status-cell">${subStatus}</span>
            <div class="subfile-action-cell">
              ${subStreamBtn}
            </div>
          </div>
        `;
      });

      filesHTML = `
        <div class="torrent-files-accordion ${isExpanded ? 'expanded' : ''}" id="files-accordion-${merged.infoHash}">
          <div class="files-accordion-header">
            <span class="col-header col-h-check"></span>
            <span class="col-header col-h-name" data-col="name">
              <span>File Name</span>
              <div class="col-resizer" data-col="name" title="Drag to resize column"></div>
            </span>
            <span class="col-header col-h-size" data-col="size">
              <span>Size</span>
              <div class="col-resizer" data-col="size" title="Drag to resize column"></div>
            </span>
            <span class="col-header col-h-prog" data-col="prog">
              <span>Progress</span>
              <div class="col-resizer" data-col="prog" title="Drag to resize column"></div>
            </span>
            <span class="col-header col-h-status" data-col="status">
              <span>Status</span>
              <div class="col-resizer" data-col="status" title="Drag to resize column"></div>
            </span>
            <span class="col-header col-h-action" style="text-align: right; justify-content: flex-end;">Action</span>
          </div>
          <div class="files-accordion-body">
            ${rowsHTML}
          </div>
        </div>
      `;
    }

    const initialActionBadgeHTML = actionStatus
      ? `<span class="action-status-badge">${actionStatus}</span>`
      : '';
    const initialDownSpeedHTML = `<span>${merged.paused ? 'PAUSED' : '↓ ' + downSpeedText}</span>`;

    const myTorrentBadgeHTML = isMyTorrent
      ? '<span class="badge-my-torrent">★ MY SEED</span> '
      : '';

    const myTorrentActionsHTML = isMyTorrent
      ? `
        <button class="btn btn-secondary btn-sm" onclick="copyMagnetLink('${merged.infoHash}')" title="Copy Magnet Link for sharing">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Magnet</span>
        </button>
        <button class="btn btn-secondary btn-sm" onclick="exportTorrentFile('${merged.infoHash}')" title="Save .torrent file to disk">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>.torrent</span>
        </button>
      `
      : '';

    let initialMetricsHTML = '';
    if (isMyTorrent) {
      initialMetricsHTML = `
        <span class="badge-my-torrent">★ SEEDING SOURCE</span>
        <span class="my-torrent-connected-nodes" title="Connected downloading nodes">👥 ${merged.numPeers || 0} Nodes</span>
        <span>↑ ${upSpeedText}</span>
        <span title="Transferred so far to swarm">⬆ ${formatBytes(merged.uploaded || 0)} transferred</span>
        <span>${totalText}</span>
      `;
    } else {
      initialMetricsHTML = `
        <span title="Seeders / Leechers" style="color: #0F172A; font-weight: 700;">🟢 ${seeders} / 🔵 ${leechers}</span>
        ${initialActionBadgeHTML}
        ${initialDownSpeedHTML}
        <span>↑ ${upSpeedText}</span>
        <span>${downloadedText} / ${totalText}</span>
      `;
    }

    card.innerHTML = `
      <!-- Top Row: Icon, Title, Location & Actions -->
      <div class="compact-row-main">
        <div class="compact-title-group">
          <div class="compact-media-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="compact-info">
            <h3 class="compact-name" title="${merged.name}">${myTorrentBadgeHTML}${merged.name}</h3>
            <span class="compact-path clickable" onclick="setLocationTorrent('${merged.infoHash}')" title="📁 ${saveLocation} (Click to set new location)">📁 ${saveLocation}</span>
          </div>
        </div>

        <div class="compact-actions">
          ${filesToggleBtn}
          <button class="btn btn-secondary btn-sm btn-share-card" onclick="openShareModal('${merged.infoHash}')" title="Share this torrent (Get Magnet Link & Export .torrent)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span>Share</span>
          </button>
          ${myTorrentActionsHTML}
          <button class="btn btn-secondary btn-sm" id="btn-location-${merged.infoHash}" onclick="setLocationTorrent('${merged.infoHash}')" title="Set New Location" ${isBusy ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span>Location</span>
          </button>
          <button class="btn btn-secondary btn-sm" onclick="openPeersInspector('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Inspect & Manage Connected Nodes">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span>Nodes (${seeders})</span>
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-verify-${merged.infoHash}" onclick="verifyLocalTorrent('${merged.infoHash}')" title="Re-check & Verify Local Data on Disk" ${isBusy || merged.verifying ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 12 14 15 10"/></svg>
            <span>${(merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) ? 'Verifying...' : 'Verify'}</span>
          </button>
          <button class="btn btn-secondary btn-sm btn-pause-resume" id="btn-pause-${merged.infoHash}" onclick="togglePauseTorrent('${merged.infoHash}', ${merged.paused || false})" title="${merged.paused ? 'Resume Torrent' : 'Pause Torrent'}" ${isBusy ? 'disabled' : ''}>
            ${merged.paused 
              ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Resume</span>'
              : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>'
            }
          </button>
          <button class="btn btn-secondary btn-sm" onclick="showInFolder('${saveLocation.replace(/'/g, "\\'")}')" title="See in file manager">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <span>Folder</span>
          </button>
          <button class="btn btn-secondary btn-sm btn-remove-torrent" onclick="confirmRemoveTorrent('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Remove Torrent Options" style="padding: 5px 8px; color: #DC2626; border-color: #FCA5A5;">
            &times;
          </button>
        </div>
      </div>

      <!-- Bottom Row: Micro Progress Bar, Piece Grid & Swarm Seeders/Leechers Metrics -->
      <div class="compact-row-sub">
        <div class="compact-progress-container">
          <span class="compact-pct">${actionStatus === 'Done' ? '100%' : (isBusy ? '...' : pct + '%')}</span>
          <div class="compact-bar-bg">
            <div class="compact-bar-fill" style="width: ${pct}%;"></div>
          </div>
        </div>

        <div class="micro-piece-grid" title="${statusText}">
          ${pieceSegmentsHTML}
        </div>

        <div class="compact-metrics">
          ${initialMetricsHTML}
        </div>
      </div>

      <!-- Expandable Multi-File Inspector Accordion -->
      ${filesHTML}
    `;

    const newAccordion = card.querySelector('.torrent-files-accordion');
    if (newAccordion) {
      initColumnResizers(newAccordion);
    }

    const myTorrentsList = document.getElementById('my-torrents-list');
    if (isMyTorrent && myTorrentsList) {
      if (card.parentNode !== myTorrentsList) {
        myTorrentsList.prepend(card);
      }
    } else if (pct >= 100 && !merged.verifying) {
      if (completedList && card.parentNode !== completedList) {
        completedList.prepend(card);
      }
    } else {
      if (activeList && card.parentNode !== activeList) {
        activeList.prepend(card);
      }
    }

    updateCounts();
    checkEmptyState();
  }

  function updateCounts() {
    let activeCount = 0;
    let completedCount = 0;
    let myTorrentsCount = 0;
    let totalDlSpeed = 0;
    let totalUlSpeed = 0;

    torrentCardsMap.forEach((card, infoHash) => {
      const t = torrentDataMap.get(infoHash) || {};
      const pctElem = card.querySelector('.compact-pct');
      const pctStr = pctElem ? pctElem.textContent : '0%';
      const pct = parseInt(pctStr, 10) || 0;
      if (pct >= 100) {
        completedCount++;
      } else {
        activeCount++;
      }

      if (t.isMyTorrent || t.createdByUser) {
        myTorrentsCount++;
      }

      if (!t.paused) {
        totalDlSpeed += (t.downloadSpeed || 0);
        totalUlSpeed += (t.uploadSpeed || 0);
      }
    });

    const dlBadge = document.getElementById('download-count');
    const compBadge = document.getElementById('completed-count');
    const myBadge = document.getElementById('my-torrents-count');
    if (dlBadge) dlBadge.textContent = activeCount;
    if (compBadge) compBadge.textContent = completedCount;
    if (myBadge) myBadge.textContent = myTorrentsCount;

    const globalDl = document.getElementById('global-dl-speed');
    const globalUl = document.getElementById('global-ul-speed');
    if (globalDl) globalDl.textContent = formatSpeed(totalDlSpeed);
    if (globalUl) globalUl.textContent = formatSpeed(totalUlSpeed);
  }

  // IPC Event Listeners
  if (ipcRenderer) {
    ipcRenderer.on('torrent-added', (event, torrent) => {
      renderTorrentCard(torrent);
      checkEmptyState();
    });

    ipcRenderer.on('torrent-done', (event, torrent) => {
      playCompletionChime();
      renderTorrentCard(torrent);
    });

    ipcRenderer.on('torrent-progress', (event, progress) => {
      renderTorrentCard(progress);
    });

    ipcRenderer.on('torrent-removed', (event, data) => {
      removeTorrentCardDOM(data.infoHash);
    });

    ipcRenderer.on('torrent-action-status', (event, data) => {
      const { infoHash, status, buttonsDisabled } = data;
      const prev = torrentDataMap.get(infoHash) || {};
      const updated = {
        ...prev,
        infoHash,
        actionStatus: status,
        actionBusy: Boolean(buttonsDisabled)
      };
      torrentDataMap.set(infoHash, updated);
      renderTorrentCard(updated);
    });

    ipcRenderer.on('open-torrent-file', async (event, filePath) => {
      if (!filePath) return;
      if (typeof filePath === 'string' && filePath.startsWith('magnet:?')) {
        const magnetInput = document.getElementById('magnet-input');
        if (magnetInput) magnetInput.value = filePath;
        openMagnetModal();
      } else {
        await openPromptModal(filePath);
      }
    });

    try {
      const torrents = await ipcRenderer.invoke('get-torrents');
      if (Array.isArray(torrents)) {
        torrents.forEach(t => renderTorrentCard(t));
      }
      checkEmptyState();
    } catch (e) {
      console.warn('Error querying initial torrents:', e);
    }
  }
});
