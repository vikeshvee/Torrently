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

  if (typeof process !== 'undefined' && process.env && process.env.TORRENTLY_DEV_SANDBOX === '1') {
    const brandText = document.querySelector('.brand-text');
    if (brandText) {
      brandText.innerHTML = `
        <span class="brand-title">Torrently <span style="font-size: 10px; color: #0284C7; font-weight: 700; background: #E0F2FE; padding: 2px 6px; border-radius: 4px; vertical-align: middle;">SANDBOX</span></span>
        <span class="brand-badge" style="background: #0F172A; color: #38BDF8;">TEST NAMESPACE</span>
      `;
    }
  }

  // Sanitizes and trims pasted torrent links, stripping surrounding brackets, quotes, and trailing sentence punctuation
  function sanitizeTorrentInput(input) {
    if (!input) return '';
    let s = String(input).trim();
    // Strip wrapping quotes, brackets, and markdown backticks
    s = s.replace(/^[<"'\s`]+|[>"'\s`]+$/g, '').trim();

    // If string contains a magnet URI anywhere, extract the full magnet URI
    const magnetMatch = s.match(/(magnet:\?[^\s<>"`]+)/i);
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
  let currentActiveTab = 'downloads';
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');

  function syncTorrentsToActiveView(tab = currentActiveTab) {
    const activeList = document.getElementById('torrent-list');
    const completedList = document.getElementById('completed-list');
    const myTorrentsList = document.getElementById('my-torrents-list');

    torrentCardsMap.forEach((card, infoHash) => {
      const t = torrentDataMap.get(infoHash) || {};
      const pct = Math.min(100, Math.floor((t.progress || 0) * 100));
      const isMyTorrent = Boolean(t.isMyTorrent || t.createdByUser);
      const isCompleted = pct >= 100 && !t.verifying && !t.actionBusy;

      let targetList = activeList;
      if (tab === 'my-torrents') {
        if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
        else if (isCompleted && completedList) targetList = completedList;
        else targetList = activeList;
      } else if (tab === 'completed') {
        if (isCompleted && completedList) targetList = completedList;
        else if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
        else targetList = activeList;
      } else {
        // 'downloads' tab or default: user-created torrents appear in activeList as active seeding torrents!
        if (isCompleted && !isMyTorrent && completedList) {
          targetList = completedList;
        } else {
          targetList = activeList;
        }
      }

      if (targetList && card.parentNode !== targetList) {
        targetList.prepend(card);
      }
    });
  }

  const STORAGE_KEY_MENU_VISIBILITY = 'torrently_menu_visibility';
  const DEFAULT_MENU_VISIBILITY = {
    downloads: true,
    completed: true,
    'my-torrents': false, // Default hidden per user request
    preferences: true     // Settings cannot be hidden
  };

  function getStoredMenuVisibility() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_MENU_VISIBILITY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          downloads: parsed.downloads !== undefined ? Boolean(parsed.downloads) : true,
          completed: parsed.completed !== undefined ? Boolean(parsed.completed) : true,
          'my-torrents': parsed['my-torrents'] !== undefined ? Boolean(parsed['my-torrents']) : false,
          preferences: true // Settings cannot be hidden
        };
      }
    } catch (e) {}
    return { ...DEFAULT_MENU_VISIBILITY };
  }

  let currentMenuVisibility = getStoredMenuVisibility();

  function applyMenuVisibility(visibility) {
    currentMenuVisibility = {
      downloads: visibility && visibility.downloads !== undefined ? Boolean(visibility.downloads) : true,
      completed: visibility && visibility.completed !== undefined ? Boolean(visibility.completed) : true,
      'my-torrents': visibility && visibility['my-torrents'] !== undefined ? Boolean(visibility['my-torrents']) : false,
      preferences: true // Settings can never be hidden
    };

    const tabs = ['downloads', 'completed', 'my-torrents', 'preferences'];
    tabs.forEach(tab => {
      const isVisible = currentMenuVisibility[tab] !== false;
      const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
      if (navItem) {
        if (isVisible) {
          navItem.style.display = 'flex';
          navItem.classList.remove('nav-item-hidden');
        } else {
          navItem.style.display = 'none';
          navItem.classList.add('nav-item-hidden');
        }
      }
    });

    // If currently active tab is hidden, navigate to first visible tab
    if (currentMenuVisibility[currentActiveTab] === false) {
      const fallbackTab = currentMenuVisibility.downloads 
        ? 'downloads' 
        : (currentMenuVisibility.completed ? 'completed' : 'preferences');
      switchNavTab(fallbackTab);
    }

    if (typeof syncMenuVisibilityCheckboxes === 'function') {
      syncMenuVisibilityCheckboxes();
    }
  }
  window.applyMenuVisibility = applyMenuVisibility;
  window.getMenuVisibility = () => ({ ...currentMenuVisibility });

  function switchNavTab(targetTab) {
    if (!targetTab) return;
    // If target tab is hidden, fallback to first visible tab
    if (currentMenuVisibility && currentMenuVisibility[targetTab] === false) {
      targetTab = currentMenuVisibility.downloads 
        ? 'downloads' 
        : (currentMenuVisibility.completed ? 'completed' : 'preferences');
    }
    currentActiveTab = targetTab;

    navItems.forEach(n => {
      if (n.getAttribute('data-tab') === targetTab) {
        n.classList.add('active');
      } else {
        n.classList.remove('active');
      }
    });

    viewSections.forEach(sec => {
      sec.classList.remove('active');
      if (sec.id === `${targetTab}-view`) {
        sec.classList.add('active');
      }
    });
    syncTorrentsToActiveView(currentActiveTab);
    checkEmptyState();
  }
  window.switchNavTab = switchNavTab;

  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.getAttribute('data-tab');
      switchNavTab(targetTab);
    });
  });

  // Apply saved/default menu visibility immediately on load
  applyMenuVisibility(currentMenuVisibility);

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
          emptyDiv.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 40px; font-size: 13px;">No active downloads. Click <b>Add Magnet Link</b>, <b>Open .torrent</b>, or <b>Share Files</b> to begin.</p>`;
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
      let myTotal = 0;
      torrentDataMap.forEach(t => {
        if (t.isMyTorrent || t.createdByUser) myTotal++;
      });
      if (myTotal === 0) {
        myEmpty.style.display = 'flex';
      } else {
        myEmpty.style.display = 'none';
      }
    }
  }

  // Screen Loading Indicator Handlers
  const screenLoadingIndicator = document.getElementById('screen-loading-indicator');
  const screenLoadingText = document.getElementById('screen-loading-text');

  function showScreenLoading(text = 'Refreshing torrents...') {
    if (screenLoadingIndicator) {
      if (screenLoadingText) screenLoadingText.textContent = text;
      screenLoadingIndicator.style.display = 'inline-flex';
    }
  }

  function hideScreenLoading() {
    if (screenLoadingIndicator) {
      screenLoadingIndicator.style.display = 'none';
    }
  }

  // Refresh Action Button Handler
  const btnRefreshList = document.getElementById('btn-refresh-list');
  if (btnRefreshList) {
    btnRefreshList.addEventListener('click', async () => {
      showScreenLoading('Refreshing torrent list...');
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
        } finally {
          setTimeout(hideScreenLoading, 300);
        }
      } else {
        setTimeout(hideScreenLoading, 300);
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
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://public.popcorn-tracker.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'http://tracker.openbittorrent.com:80/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce',
    'wss://tracker.fastcast.nz'
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

    const trackerCountEl = document.getElementById('share-trackers-count');
    if (trackerCountEl) {
      const announceCount = (shareInfo && Array.isArray(shareInfo.announce)) ? shareInfo.announce.length : 14;
      trackerCountEl.textContent = `${announceCount} Trackers Injected`;
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
      createSourcePreview.innerHTML = '<span class="preview-placeholder">No source selected yet. Pick a single file, directory, or drag & drop here.</span>';
    }
    const pathInput = document.getElementById('create-source-path-input');
    if (pathInput) pathInput.value = '';
    if (createTorrentNameInput) createTorrentNameInput.value = '';
    if (btnSubmitCreate) btnSubmitCreate.disabled = true;
  }

  function setChosenCreateSource(targetPath, explicitIsDir = null) {
    if (!targetPath || typeof targetPath !== 'string') return;
    const cleanPath = targetPath.trim();
    if (!cleanPath) return;

    let isDir = false;
    let fileSize = 0;
    let fileName = '';

    try {
      if (typeof require !== 'undefined') {
        const fs = require('fs');
        const path = require('path');
        if (fs.existsSync(cleanPath)) {
          const stat = fs.statSync(cleanPath);
          isDir = stat.isDirectory();
          fileSize = isDir ? 0 : stat.size;
          fileName = path.basename(cleanPath);
        } else {
          isDir = Boolean(explicitIsDir);
          fileName = path.basename(cleanPath);
        }
      } else {
        isDir = Boolean(explicitIsDir);
        fileName = cleanPath.split(/[/\\]/).pop() || cleanPath;
      }
    } catch (e) {
      isDir = Boolean(explicitIsDir);
      fileName = cleanPath.split(/[/\\]/).pop() || cleanPath;
    }

    selectedCreateSource = {
      path: cleanPath,
      name: fileName,
      isDirectory: isDir,
      size: fileSize
    };

    const typeBadge = isDir ? '<span class="source-badge">DIRECTORY</span>' : '<span class="source-badge">FILE</span>';
    const sizeInfo = isDir ? 'All sub-files & folders auto-included' : formatBytes(fileSize);

    if (createSourcePreview) {
      createSourcePreview.innerHTML = `
        <div class="source-selected-info">
          <div>
            ${typeBadge}
            <strong style="margin-left: 6px; color: var(--text-primary);">${fileName}</strong>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">📁 ${cleanPath} (${sizeInfo})</div>
          </div>
        </div>
      `;
    }

    const pathInput = document.getElementById('create-source-path-input');
    if (pathInput) pathInput.value = cleanPath;

    if (createTorrentNameInput && !createTorrentNameInput.value.trim()) {
      createTorrentNameInput.value = fileName;
    }
    if (btnSubmitCreate) btnSubmitCreate.disabled = false;
  }

  async function chooseCreateSource(type) {
    let source = null;
    if (ipcRenderer) {
      try {
        source = await ipcRenderer.invoke('select-create-source', type);
      } catch (err) {
        console.warn('IPC select-create-source note:', err);
      }
    }
    if (source && source.path) {
      setChosenCreateSource(source.path, source.isDirectory);
      return;
    }
    // Direct DOM fallback if dialog was canceled or unavailable
    const hiddenFile = document.getElementById('hidden-create-file');
    const hiddenFolder = document.getElementById('hidden-create-folder');
    if (type === 'folder' && hiddenFolder) {
      hiddenFolder.click();
    } else if (hiddenFile) {
      hiddenFile.click();
    }
  }

  async function openMagnetModal(presetUrl = '') {
    magnetModal.classList.add('active');

    if (presetUrl) {
      magnetInput.value = sanitizeTorrentInput(presetUrl);
      magnetInput.select();
      magnetInput.focus();
      return;
    }

    // Always reset input first: if clipboard has valid torrent/magnet data populate it, else leave empty
    magnetInput.value = '';
    let clipText = '';
    try {
      if (typeof require !== 'undefined') {
        const { clipboard } = require('electron');
        clipText = (clipboard && clipboard.readText()) || '';
      } else if (navigator.clipboard && navigator.clipboard.readText) {
        clipText = (await navigator.clipboard.readText()) || '';
      }
    } catch (e) {
      console.warn('Clipboard read note:', e.message);
    }

    if (clipText) {
      const sanitized = sanitizeTorrentInput(clipText.trim());
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
        const tData = torrentDataMap.get(activeInspectorHash);
        const isMy = tData && (tData.isMyTorrent || tData.createdByUser);
        if (isMy) {
          peersTableBody.innerHTML = `
            <div class="peers-empty" style="padding: 24px 16px; text-align: center; color: var(--text-muted); line-height: 1.6;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-color); margin-bottom: 6px;">🟢 Seeding to Worldwide Swarm</div>
              <div>Your files are actively announced to 14 global trackers and the DHT network.</div>
              <div style="font-size: 11px; margin-top: 6px;">Waiting for downloading peers to connect. Anyone with your Magnet URI or .torrent file will appear here.</div>
            </div>`;
        } else {
          peersTableBody.innerHTML = `<div class="peers-empty">Searching for peers in swarm...</div>`;
        }
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

  if (magnetInput) {
    magnetInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (btnSubmitMagnetNext) btnSubmitMagnetNext.click();
      } else if (e.key === 'Escape') {
        closeMagnetModal();
      }
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
        const added = await ipcRenderer.invoke('add-torrent', payload);
        if (added && added.infoHash && !payload.paused) {
          added.paused = false;
          added._lastUserPauseToggle = 0;
          const targetHash = added.infoHash.toLowerCase();
          const existing = torrentDataMap.get(added.infoHash) || torrentDataMap.get(targetHash);
          if (existing) {
            existing.paused = false;
            existing._lastUserPauseToggle = 0;
          }
        }
        // Switch to Downloads tab automatically so user immediately sees the newly added torrent
        if (typeof window.switchNavTab === 'function') {
          window.switchNavTab('downloads');
        }
        // Instant screen refresh for updated torrent list
        const torrents = await ipcRenderer.invoke('get-torrents');
        if (Array.isArray(torrents)) {
          torrents.forEach(t => {
            if (added && added.infoHash && t.infoHash && t.infoHash.toLowerCase() === added.infoHash.toLowerCase() && !payload.paused) {
              t.paused = false;
              t._lastUserPauseToggle = 0;
            }
            renderTorrentCard(t);
          });
        }
        if (added && added.infoHash) {
          const card = document.getElementById(`card-${added.infoHash}`);
          if (card) {
            card.classList.add('card-just-added');
            setTimeout(() => card.classList.remove('card-just-added'), 3000);
          }
        }
        checkEmptyState();
      }
    });
  }

  if (addPromptModal) {
    addPromptModal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        if (btnSubmitPrompt) btnSubmitPrompt.click();
      } else if (e.key === 'Escape') {
        closePromptModal();
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

  function syncMenuVisibilityCheckboxes() {
    const elDownloads = document.getElementById('pref-menu-downloads');
    const elCompleted = document.getElementById('pref-menu-completed');
    const elMyTorrents = document.getElementById('pref-menu-my-torrents');
    const elPreferences = document.getElementById('pref-menu-preferences');
    if (elDownloads) elDownloads.checked = currentMenuVisibility.downloads !== false;
    if (elCompleted) elCompleted.checked = currentMenuVisibility.completed !== false;
    if (elMyTorrents) elMyTorrents.checked = currentMenuVisibility['my-torrents'] === true;
    if (elPreferences) {
      elPreferences.checked = true;
      elPreferences.disabled = true;
    }
  }
  syncMenuVisibilityCheckboxes();

  function onMenuVisibilityToggled() {
    const elDownloads = document.getElementById('pref-menu-downloads');
    const elCompleted = document.getElementById('pref-menu-completed');
    const elMyTorrents = document.getElementById('pref-menu-my-torrents');
    const updated = {
      downloads: elDownloads ? elDownloads.checked : true,
      completed: elCompleted ? elCompleted.checked : true,
      'my-torrents': elMyTorrents ? elMyTorrents.checked : false,
      preferences: true // Settings cannot be hidden
    };
    applyMenuVisibility(updated);
    try {
      localStorage.setItem(STORAGE_KEY_MENU_VISIBILITY, JSON.stringify(currentMenuVisibility));
    } catch (e) {}
    if (ipcRenderer) {
      ipcRenderer.invoke('save-preferences', { menuVisibility: currentMenuVisibility }).catch(() => {});
    }
  }

  const prefMenuDownloads = document.getElementById('pref-menu-downloads');
  const prefMenuCompleted = document.getElementById('pref-menu-completed');
  const prefMenuMyTorrents = document.getElementById('pref-menu-my-torrents');
  const prefMenuPreferences = document.getElementById('pref-menu-preferences');
  const prefStatusBar = document.getElementById('pref-status-bar');
  const prefSidebarSpeed = document.getElementById('pref-sidebar-speed');
  const sidebarNetworkSummary = document.getElementById('sidebar-network-summary');

  function updateSidebarSpeedVisibility(visible) {
    if (sidebarNetworkSummary) {
      sidebarNetworkSummary.style.display = visible ? 'block' : 'none';
    }
    if (prefSidebarSpeed) {
      prefSidebarSpeed.checked = Boolean(visible);
    }
  }

  if (prefMenuDownloads) prefMenuDownloads.addEventListener('change', onMenuVisibilityToggled);
  if (prefMenuCompleted) prefMenuCompleted.addEventListener('change', onMenuVisibilityToggled);
  if (prefMenuMyTorrents) prefMenuMyTorrents.addEventListener('change', onMenuVisibilityToggled);

  if (prefStatusBar) {
    prefStatusBar.addEventListener('change', async () => {
      if (ipcRenderer) {
        try {
          await ipcRenderer.invoke('toggle-status-bar-speed', prefStatusBar.checked);
        } catch (e) {}
      }
    });
  }

  if (prefSidebarSpeed) {
    prefSidebarSpeed.addEventListener('change', () => {
      const isVisible = prefSidebarSpeed.checked;
      updateSidebarSpeedVisibility(isVisible);
      if (ipcRenderer) {
        ipcRenderer.invoke('save-preferences', { showSidebarSpeed: isVisible }).catch(() => {});
      }
    });
  }

  window.openNetworkSpeedWindow = function() {
    if (ipcRenderer) {
      ipcRenderer.invoke('open-network-monitor-window').catch(() => {});
    }
  };

  // CLI Preferences & Management
  const prefEnableCli = document.getElementById('pref-enable-cli');
  const prefCliStatusText = document.getElementById('pref-cli-status-text');
  const cliManualModal = document.getElementById('cli-manual-modal');
  const cliStatusBanner = document.getElementById('cli-status-banner');
  const cliStatusTitle = document.getElementById('cli-status-title');
  const cliStatusSubtitle = document.getElementById('cli-status-subtitle');
  const btnToggleCliInstall = document.getElementById('btn-toggle-cli-install');

  let currentCliStatus = { installed: false, path: null, targetDir: '' };

  async function updateCliStatusUI() {
    if (!ipcRenderer) return;
    try {
      currentCliStatus = await ipcRenderer.invoke('get-cli-status');
      const isInstalled = Boolean(currentCliStatus && currentCliStatus.installed);

      if (prefEnableCli) prefEnableCli.checked = isInstalled;
      if (prefCliStatusText) {
        prefCliStatusText.innerHTML = isInstalled
          ? `<span style="color: #16A34A; font-weight: 600;">● Active</span> <code style="font-size: 11px; background: var(--bg-hover, #F1F5F9); padding: 1px 4px; border-radius: 3px; font-family: monospace;">${currentCliStatus.path}</code>`
          : `<span style="color: #94A3B8;">○ Not installed</span> (target: ${currentCliStatus.targetDir || '/opt/homebrew/bin'})`;
      }

      if (cliStatusBanner) {
        if (isInstalled) {
          cliStatusBanner.classList.add('installed');
          cliStatusBanner.classList.remove('uninstalled');
          if (cliStatusTitle) cliStatusTitle.textContent = 'CLI Command Active in Terminal';
          if (cliStatusSubtitle) cliStatusSubtitle.innerHTML = `Installed at <code style="font-family: monospace;">${currentCliStatus.path}</code> (${currentCliStatus.inPath ? 'In PATH' : 'Available'})`;
          if (btnToggleCliInstall) {
            btnToggleCliInstall.textContent = 'Uninstall CLI';
            btnToggleCliInstall.style.color = '#DC2626';
          }
        } else {
          cliStatusBanner.classList.remove('installed');
          cliStatusBanner.classList.add('uninstalled');
          if (cliStatusTitle) cliStatusTitle.textContent = 'CLI Command Not Installed';
          if (cliStatusSubtitle) cliStatusSubtitle.textContent = `Click below to install 'torrently' to ${currentCliStatus.targetDir || '/opt/homebrew/bin'}`;
          if (btnToggleCliInstall) {
            btnToggleCliInstall.textContent = 'Install CLI Command';
            btnToggleCliInstall.style.color = '#2563EB';
          }
        }
      }
    } catch (e) {
      console.warn('Could not update CLI status UI:', e);
    }
  }

  if (prefEnableCli) {
    prefEnableCli.addEventListener('change', async () => {
      if (!ipcRenderer) return;
      try {
        if (prefEnableCli.checked) {
          await ipcRenderer.invoke('install-cli');
        } else {
          await ipcRenderer.invoke('uninstall-cli');
        }
        await updateCliStatusUI();
      } catch (err) {
        console.warn('CLI toggle error:', err);
      }
    });
  }

  window.openCliManual = function() {
    if (cliManualModal) {
      cliManualModal.classList.add('active');
      updateCliStatusUI();
    }
  };

  window.closeCliManual = function() {
    if (cliManualModal) {
      cliManualModal.classList.remove('active');
    }
  };

  window.toggleCliInstallation = async function() {
    if (!ipcRenderer) return;
    try {
      if (currentCliStatus && currentCliStatus.installed) {
        await ipcRenderer.invoke('uninstall-cli');
      } else {
        await ipcRenderer.invoke('install-cli');
      }
      await updateCliStatusUI();
    } catch (err) {
      alert('CLI Operation Failed: ' + err.message);
    }
  };

  window.copyCliCommand = function(text, btn) {
    navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.color = '#10B981';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.color = '';
      }, 1500);
    }
  };

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
        if (prefs.showInStatusBar !== undefined && prefStatusBar) {
          prefStatusBar.checked = Boolean(prefs.showInStatusBar);
        }
        if (prefSidebarSpeed) {
          updateSidebarSpeedVisibility(Boolean(prefs.showSidebarSpeed));
        }
        if (prefs.enableCli !== undefined && prefEnableCli) {
          prefEnableCli.checked = Boolean(prefs.enableCli);
        }
        if (prefs.menuVisibility) {
          applyMenuVisibility(prefs.menuVisibility);
          try {
            localStorage.setItem(STORAGE_KEY_MENU_VISIBILITY, JSON.stringify(currentMenuVisibility));
          } catch (e) {}
        }
        updateCliStatusUI();
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
        showCompletionNotification: completionNotifyEnabled,
        showInStatusBar: prefStatusBar ? prefStatusBar.checked : false,
        showSidebarSpeed: prefSidebarSpeed ? prefSidebarSpeed.checked : false,
        enableCli: prefEnableCli ? prefEnableCli.checked : true,
        menuVisibility: {
          downloads: prefMenuDownloads ? prefMenuDownloads.checked : true,
          completed: prefMenuCompleted ? prefMenuCompleted.checked : true,
          'my-torrents': prefMenuMyTorrents ? prefMenuMyTorrents.checked : false,
          preferences: true
        }
      };
      defaultSavePath = updated.savePath;
      applyMenuVisibility(updated.menuVisibility);
      try {
        localStorage.setItem(STORAGE_KEY_MENU_VISIBILITY, JSON.stringify(currentMenuVisibility));
      } catch (e) {}

      if (ipcRenderer) {
        await ipcRenderer.invoke('save-preferences', updated);
      }
      updateCliStatusUI();
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
        console.warn('Could not open separate player window:', err);
      }
    }
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
    if (!infoHash) return;
    const targetHash = infoHash.toLowerCase();

    // Find card and existing data case-insensitively
    let card = torrentCardsMap.get(infoHash) || torrentCardsMap.get(targetHash);
    let prev = torrentDataMap.get(infoHash) || torrentDataMap.get(targetHash);
    if (!card) {
      for (const [k, v] of torrentCardsMap.entries()) {
        if (k && k.toLowerCase() === targetHash) {
          card = v;
          break;
        }
      }
    }
    if (!prev) {
      for (const [k, v] of torrentDataMap.entries()) {
        if (k && k.toLowerCase() === targetHash) {
          prev = v;
          break;
        }
      }
    }

    const currentPaused = prev ? Boolean(prev.paused) : Boolean(isPaused);
    const nextPaused = !currentPaused;

    // Immediately update local data and render so UI responds without delay
    if (prev) {
      prev.paused = nextPaused;
      prev._lastUserPauseToggle = Date.now();
      if (nextPaused) {
        prev.downloadSpeed = 0;
        prev.uploadSpeed = 0;
      }
      renderTorrentCard(prev);
    } else if (card) {
      const pauseBtn = card.querySelector(`#btn-pause-${infoHash}`) || card.querySelector('.btn-pause-resume');
      if (pauseBtn) {
        pauseBtn.classList.toggle('is-paused', nextPaused);
        pauseBtn.title = nextPaused ? 'Resume Torrent' : 'Pause Torrent';
        pauseBtn.onclick = () => togglePauseTorrent(infoHash, nextPaused);
        pauseBtn.innerHTML = nextPaused
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>Resume</span>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span>Pause</span>';
      }
    }

    if (ipcRenderer) {
      try {
        if (currentPaused) {
          await ipcRenderer.invoke('resume-torrent', infoHash);
        } else {
          await ipcRenderer.invoke('pause-torrent', infoHash);
        }
      } catch (err) {
        console.error('Error toggling pause state:', err);
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

  function formatETA(seconds) {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds > 86400 * 30) return '> 30d';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  let currentSubfileSizeMode = 'total'; // 'total', 'remaining', 'both'

  window.cycleSubfileSizeMode = function() {
    if (currentSubfileSizeMode === 'total') {
      currentSubfileSizeMode = 'remaining';
    } else if (currentSubfileSizeMode === 'remaining') {
      currentSubfileSizeMode = 'both';
    } else {
      currentSubfileSizeMode = 'total';
    }
    document.querySelectorAll('.subfile-size').forEach(el => {
      const length = parseInt(el.getAttribute('data-length') || '0', 10);
      const downloaded = parseInt(el.getAttribute('data-downloaded') || '0', 10);
      el.textContent = formatSubfileSizeText(length, downloaded);
    });
  };

  function formatSubfileSizeText(length, downloaded) {
    const remaining = Math.max(0, length - downloaded);
    if (currentSubfileSizeMode === 'remaining') {
      return remaining === 0 ? '0 B left' : `${formatBytes(remaining)} left`;
    }
    if (currentSubfileSizeMode === 'both') {
      return `${formatBytes(downloaded)} / ${formatBytes(length)}`;
    }
    return formatBytes(length);
  }

  window.handleCardRowClick = function(event, infoHash) {
    if (event.target.closest('button, input, select, a, .clickable, .subfile-play-btn, .action-status-badge, .status-icon-clean, .compact-path, .clickable-peer-count')) {
      return;
    }
    const tData = torrentDataMap.get(infoHash);
    if (tData && tData.files && tData.files.length > 0) {
      toggleFilesAccordion(infoHash);
    }
  };

  window.toggleFilesAccordion = function(infoHash) {
    const accordion = document.getElementById(`files-accordion-${infoHash}`);
    const pill = document.getElementById(`files-pill-${infoHash}`);
    if (!accordion) return;
    if (expandedTorrents.has(infoHash)) {
      expandedTorrents.delete(infoHash);
      accordion.classList.remove('expanded');
      if (pill) pill.innerHTML = pill.innerHTML.replace('▴', '▾');
    } else {
      expandedTorrents.add(infoHash);
      accordion.classList.add('expanded');
      if (pill) pill.innerHTML = pill.innerHTML.replace('▾', '▴');
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

  // README & Release Notes Modal
  const readmeModal = document.getElementById('readme-modal');
  const btnCloseReadme = document.getElementById('btn-close-readme');

  window.openReadmeModal = function() {
    if (readmeModal) readmeModal.classList.add('active');
  };

  window.closeReadmeModal = function() {
    if (readmeModal) readmeModal.classList.remove('active');
  };

  if (btnCloseReadme) {
    btnCloseReadme.addEventListener('click', closeReadmeModal);
  }

  function closeAllModals() {
    closeRemoveModal();
    closePromptModal();
    closeMagnetModal();
    closePeersInspector();
    closePlayerModal();
    closeCreateTorrentModal();
    closeShareModal();
    closeCliManual();
    closeReadmeModal();
  }

  // Close all open dialogs on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.code === 'Escape') {
      closeAllModals();
    }
  });

  // Close modals when clicking outside modal content
  [magnetModal, addPromptModal, removeModal, playerModal, createTorrentModal, shareModal, cliManualModal, readmeModal].forEach((overlay) => {
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

  const btnApplySourcePath = document.getElementById('btn-apply-source-path');
  const createSourcePathInput = document.getElementById('create-source-path-input');
  if (btnApplySourcePath && createSourcePathInput) {
    btnApplySourcePath.addEventListener('click', () => {
      if (createSourcePathInput.value.trim()) {
        setChosenCreateSource(createSourcePathInput.value.trim());
      }
    });
    createSourcePathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (createSourcePathInput.value.trim()) {
          setChosenCreateSource(createSourcePathInput.value.trim());
        }
      }
    });
    createSourcePathInput.addEventListener('change', () => {
      if (createSourcePathInput.value.trim()) {
        setChosenCreateSource(createSourcePathInput.value.trim());
      }
    });
  }

  const hiddenCreateFile = document.getElementById('hidden-create-file');
  if (hiddenCreateFile) {
    hiddenCreateFile.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const f = e.target.files[0];
        setChosenCreateSource(f.path || f.name, false);
      }
    });
  }

  const hiddenCreateFolder = document.getElementById('hidden-create-folder');
  if (hiddenCreateFolder) {
    hiddenCreateFolder.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const f = e.target.files[0];
        setChosenCreateSource(f.path || f.name, true);
      }
    });
  }

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
            if (typeof require !== 'undefined') {
              const fs = require('fs');
              const s = fs.statSync(filePath);
              isDir = s.isDirectory();
            }
            setChosenCreateSource(filePath, isDir);
          } catch (err) {
            setChosenCreateSource(filePath, false);
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

        // Switch to "My Torrents" tab if visible, otherwise switch to Downloads tab
        if (currentMenuVisibility && currentMenuVisibility['my-torrents']) {
          switchNavTab('my-torrents');
        } else {
          switchNavTab('downloads');
        }

        if (created) {
          renderTorrentCard(created);
          const card = document.getElementById(`card-${created.infoHash}`);
          if (card) {
            card.classList.add('card-just-added');
            setTimeout(() => card.classList.remove('card-just-added'), 3000);
          }
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

  // Live Network Speed & Separate Monitor Window Handler
  const netMeter = document.getElementById('network-speed-meter');
  const netSpeedVal = document.getElementById('global-net-speed');

  if (netMeter) {
    netMeter.addEventListener('click', async () => {
      if (ipcRenderer) {
        try {
          await ipcRenderer.invoke('open-network-monitor-window');
        } catch (err) {
          console.warn('Failed to open network monitor window:', err);
        }
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

    let isPaused = (t.paused !== undefined) ? Boolean(t.paused) : Boolean(prev.paused);
    if (prev._lastUserPauseToggle && (Date.now() - prev._lastUserPauseToggle < 2500)) {
      // Respect recent user pause/resume click over stale in-flight IPC updates
      isPaused = Boolean(prev.paused);
    }

    const merged = { ...prev, ...t, files: filesList, paused: isPaused };
    if (isPaused) {
      merged.downloadSpeed = 0;
      merged.uploadSpeed = 0;
    }
    torrentDataMap.set(t.infoHash, merged);

    const pct = Math.min(100, Math.floor((merged.progress || 0) * 100));
    const downloadedText = formatBytes(merged.downloaded || 0);
    const totalText = merged.length && merged.length > 0 ? formatBytes(merged.length) : 'Fetching metadata...';
    const downSpeedText = isPaused ? '0 B/s' : formatSpeed(merged.downloadSpeed || 0);
    const upSpeedText = isPaused ? '0 B/s' : formatSpeed(merged.uploadSpeed || 0);
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

    const totalRemainingBytes = Math.max(0, (merged.length || 0) - (merged.downloaded || 0));
    let combinedEta = '';
    if (!merged.paused && !merged.verifying && pct < 100 && (merged.downloadSpeed || 0) > 1024 && totalRemainingBytes > 0) {
      const combinedSec = Math.ceil(totalRemainingBytes / merged.downloadSpeed);
      combinedEta = formatETA(combinedSec);
    }
    const combinedPctText = actionStatus === 'Done' ? '100%' : (isBusy ? '...' : (combinedEta ? `${pct}% (${combinedEta})` : `${pct}%`));

    function getSubfileStatusHTML(f) {
      const isWanted = f.wanted !== false;
      const isDone = Boolean(f.isDone || (f.progress || 0) >= 1.0 || (f.length > 0 && (f.downloaded || 0) >= f.length));
      if (isDone) {
        return '<span class="subfile-status status-completed">Completed</span>';
      }
      if (!isWanted) {
        return '<span class="subfile-status status-skipped">Skipped</span>';
      }
      if (merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) {
        return '<span class="subfile-status status-verifying">Verifying...</span>';
      }
      if (merged.paused) {
        return '<span class="subfile-status status-clean-pause">⏸ Paused</span>';
      }
      const fileSpeed = (typeof f.downloadSpeed === 'number') ? f.downloadSpeed : (merged.downloadSpeed ? (merged.downloadSpeed / Math.max(1, filesList.filter(x => x.wanted !== false && !x.isDone).length)) : 0);
      const remainingBytes = Math.max(0, f.length - (f.downloaded !== undefined ? f.downloaded : Math.round(f.length * (f.progress || 0))));
      let etaStr = '';
      if (fileSpeed > 1024 && remainingBytes > 0) {
        const fileEtaSec = Math.ceil(remainingBytes / fileSpeed);
        const formattedEta = formatETA(fileEtaSec);
        if (formattedEta) etaStr = ` • ${formattedEta}`;
      }
      const fileSpeedText = formatSpeed(fileSpeed);
      return `<span class="subfile-status status-downloading card-downloading-text">Downloading (↓ ${fileSpeedText}${etaStr})</span>`;
    }

    let card = torrentCardsMap.get(merged.infoHash);

    // Fast-path: Update existing DOM nodes without destroying innerHTML
    if (card) {
      const pctEl = card.querySelector('.compact-pct');
      if (pctEl) pctEl.textContent = combinedPctText;

      const barFill = card.querySelector('.compact-bar-fill');
      if (barFill) barFill.style.width = pct + '%';

      const pathEl = card.querySelector('.compact-path');
      if (pathEl) {
        pathEl.textContent = `📁 ${saveLocation}`;
        pathEl.title = `📁 ${saveLocation} (Click to set new location)`;
      }

      const filesPill = card.querySelector(`#files-pill-${merged.infoHash}`);
      if (filesPill && filesList.length > 0) {
        const isExp = expandedTorrents.has(merged.infoHash);
        filesPill.innerHTML = `📁 ${filesList.length} files ${isExp ? '▴' : '▾'}`;
      }

      const metricsEl = card.querySelector('.compact-metrics');
      if (metricsEl) {
        const actionBadgeHTML = actionStatus
          ? `<span class="action-status-badge">${actionStatus}</span>`
          : '';
        const isDownloading = !merged.paused && !merged.verifying && pct < 100;
        const downSpeedHTML = `<span class="${isDownloading ? 'card-downloading-text' : ''}">${merged.paused ? '<span class="status-icon-clean" title="Paused">⏸ Paused</span>' : (pct >= 100 ? '<span class="status-icon-clean" title="Completed">✓ Done</span>' : '↓ ' + downSpeedText + (combinedEta ? ` • ${combinedEta} left` : ''))}</span>`;

        let metricsHTML = '';
        if (isMyTorrent) {
          const seedingBadgeText = merged.paused ? '⏸ Paused' : '🟢 Seeding';
          metricsHTML = `
            <span class="status-icon-clean">${seedingBadgeText}</span>
            <span class="clickable-peer-count" onclick="event.stopPropagation(); openPeersInspector('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Click to view and manage connected peers/nodes">👥 ${merged.numPeers || 0} Nodes</span>
            <span>↑ ${upSpeedText}</span>
            <span title="Transferred so far to swarm">⬆ ${formatBytes(merged.uploaded || 0)} transferred</span>
            <span>${totalText}</span>
          `;
        } else {
          metricsHTML = `
            <span class="clickable-peer-count" onclick="event.stopPropagation(); openPeersInspector('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Click to view and manage connected peers/nodes">🟢 ${seeders} Seeds / 🔵 ${leechers} Peers</span>
            ${actionBadgeHTML}
            ${downSpeedHTML}
            <span>↑ ${upSpeedText}</span>
            <span>${downloadedText} / ${totalText}</span>
          `;
        }
        metricsEl.innerHTML = metricsHTML;
      }

      const nameEl = card.querySelector('.compact-name');
      if (nameEl && isMyTorrent) {
        let badgeEl = nameEl.querySelector('.badge-my-torrent');
        if (!badgeEl) {
          badgeEl = document.createElement('span');
          nameEl.prepend(badgeEl);
        }
        badgeEl.className = merged.paused ? 'badge-my-torrent badge-paused' : 'badge-my-torrent';
        badgeEl.textContent = merged.paused ? '⏸ PAUSED' : '🟢 MY SEED';
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
        pauseBtn.classList.toggle('is-paused', Boolean(merged.paused));
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

      const accordionBody = card.querySelector('.files-accordion-body');
      if (accordionBody && filesList.length > 0) {
        filesList.forEach((f) => {
          const row = card.querySelector(`.subfile-row[data-file-idx="${f.index}"]`);
          if (row) {
            const isWanted = f.wanted !== false;
            const isDone = Boolean(f.isDone || (f.progress || 0) >= 1.0 || (f.length > 0 && (f.downloaded || 0) >= f.length));
            const subPct = isDone ? 100 : Math.min(99, Math.floor((f.progress || 0) * 100));
            const subStatus = getSubfileStatusHTML(f);

            const fill = row.querySelector('.subfile-progress-fill');
            if (fill) fill.style.width = subPct + '%';

            const label = row.querySelector('.subfile-progress-label');
            if (label) label.textContent = subPct + '%';

            const statusCell = row.querySelector('.subfile-status-cell');
            if (statusCell) statusCell.innerHTML = subStatus;

            const sizeCell = row.querySelector('.subfile-size');
            if (sizeCell) {
              const downloadedBytes = (f.downloaded !== undefined) ? f.downloaded : (isDone ? f.length : Math.round(f.length * (f.progress || 0)));
              sizeCell.setAttribute('data-length', f.length);
              sizeCell.setAttribute('data-downloaded', downloadedBytes);
              sizeCell.textContent = formatSubfileSizeText(f.length, downloadedBytes);
            }

            if (isWanted) row.classList.remove('deselected');
            else row.classList.add('deselected');
          }
        });
      }

      const myTorrentsList = document.getElementById('my-torrents-list');
      const isCompleted = pct >= 100 && !merged.verifying && !isBusy;
      let targetList = activeList;
      if (currentActiveTab === 'my-torrents') {
        if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
        else if (isCompleted && completedList) targetList = completedList;
        else targetList = activeList;
      } else if (currentActiveTab === 'completed') {
        if (isCompleted && completedList) targetList = completedList;
        else if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
        else targetList = activeList;
      } else {
        // 'downloads' tab or default: user-created / shareable torrents appear in activeList as active seeding torrents!
        if (isCompleted && !isMyTorrent && completedList) {
          targetList = completedList;
        } else {
          targetList = activeList;
        }
      }
      if (targetList && card.parentNode !== targetList) {
        targetList.prepend(card);
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

    const filesPillHTML = filesList.length > 0 ? `
      <span class="files-summary-pill clickable" id="files-pill-${merged.infoHash}" onclick="event.stopPropagation(); toggleFilesAccordion('${merged.infoHash}')" title="Click to view file list (${filesList.length} files)">
        📁 ${filesList.length} files ${isExpanded ? '▴' : '▾'}
      </span>
    ` : '';

    if (filesList.length > 0) {
      let rowsHTML = '';
      filesList.forEach((f) => {
        const isWanted = f.wanted !== false;
        const isDone = Boolean(f.isDone || (f.progress || 0) >= 1.0 || (f.length > 0 && (f.downloaded || 0) >= f.length));
        const subPct = isDone ? 100 : Math.min(99, Math.floor((f.progress || 0) * 100));
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

        const fileDownloaded = (f.downloaded !== undefined) ? f.downloaded : (isDone ? f.length : Math.round(f.length * (f.progress || 0)));

        rowsHTML += `
          <div class="subfile-row ${isWanted ? '' : 'deselected'}" data-file-idx="${f.index}">
            <input type="checkbox" class="subfile-checkbox" ${isWanted ? 'checked' : ''} onchange="toggleFileWanted('${merged.infoHash}', ${f.index}, this.checked)" title="Include / Skip File">
            <span class="subfile-name" title="${f.name}">
              ${getMediaIconSVG(f.name)}
              <span>${f.name}</span>
            </span>
            <span class="subfile-size clickable" data-length="${f.length}" data-downloaded="${fileDownloaded}" onclick="event.stopPropagation(); cycleSubfileSizeMode();" title="Click to cycle size format: Total, Remaining, or Both">
              ${formatSubfileSizeText(f.length, fileDownloaded)}
            </span>
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
    const isDownloading = !merged.paused && !merged.verifying && pct < 100;
    const initialDownSpeedHTML = `<span class="${isDownloading ? 'card-downloading-text' : ''}">${merged.paused ? '<span class="status-icon-clean" title="Paused">⏸ Paused</span>' : (pct >= 100 ? '<span class="status-icon-clean" title="Completed">✓ Done</span>' : '↓ ' + downSpeedText + (combinedEta ? ` • ${combinedEta} left` : ''))}</span>`;

    const myTorrentBadgeHTML = isMyTorrent
      ? (merged.paused 
          ? '<span class="badge-my-torrent badge-paused">⏸ PAUSED</span> '
          : '<span class="badge-my-torrent">🟢 MY SEED</span> ')
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
      const seedingBadgeText = merged.paused ? '⏸ Paused' : '🟢 Seeding';
      initialMetricsHTML = `
        <span class="status-icon-clean">${seedingBadgeText}</span>
        <span class="clickable-peer-count" onclick="event.stopPropagation(); openPeersInspector('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Click to view and manage connected peers/nodes">👥 ${merged.numPeers || 0} Nodes</span>
        <span>↑ ${upSpeedText}</span>
        <span title="Transferred so far to swarm">⬆ ${formatBytes(merged.uploaded || 0)} transferred</span>
        <span>${totalText}</span>
      `;
    } else {
      initialMetricsHTML = `
        <span class="clickable-peer-count" onclick="event.stopPropagation(); openPeersInspector('${merged.infoHash}', '${merged.name.replace(/'/g, "\\'")}')" title="Click to view and manage connected peers/nodes">🟢 ${seeders} Seeds / 🔵 ${leechers} Peers</span>
        ${initialActionBadgeHTML}
        ${initialDownSpeedHTML}
        <span>↑ ${upSpeedText}</span>
        <span>${downloadedText} / ${totalText}</span>
      `;
    }

    card.innerHTML = `
      <!-- Top Row: Icon, Title, Location & Actions -->
      <div class="compact-row-main" onclick="handleCardRowClick(event, '${merged.infoHash}')" title="${filesList.length > 0 ? 'Click row to expand / collapse file list' : ''}">
        <div class="compact-title-group">
          <div class="compact-media-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="compact-info">
            <h3 class="compact-name" title="${merged.name}">${myTorrentBadgeHTML}${merged.name}</h3>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="compact-path clickable" onclick="setLocationTorrent('${merged.infoHash}')" title="📁 ${saveLocation} (Click to set new location)">📁 ${saveLocation}</span>
              ${filesPillHTML}
            </div>
          </div>
        </div>

        <div class="compact-actions">
          <button class="btn btn-secondary btn-sm btn-share-card" onclick="openShareModal('${merged.infoHash}')" title="Share this torrent (Get Magnet Link & Export .torrent)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span>Share</span>
          </button>
          ${myTorrentActionsHTML}
          <button class="btn btn-secondary btn-sm" id="btn-location-${merged.infoHash}" onclick="setLocationTorrent('${merged.infoHash}')" title="Set New Location" ${isBusy ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <span>Location</span>
          </button>
          <button class="btn btn-secondary btn-sm" id="btn-verify-${merged.infoHash}" onclick="verifyLocalTorrent('${merged.infoHash}')" title="Re-check & Verify Local Data on Disk" ${isBusy || merged.verifying ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 11 12 14 15 10"/></svg>
            <span>${(merged.verifying || (actionStatus && actionStatus.includes('Verifying'))) ? 'Verifying...' : 'Verify'}</span>
          </button>
          <button class="btn btn-secondary btn-sm btn-pause-resume ${merged.paused ? 'is-paused' : ''}" id="btn-pause-${merged.infoHash}" onclick="togglePauseTorrent('${merged.infoHash}', ${Boolean(merged.paused)})" title="${merged.paused ? 'Resume Torrent' : 'Pause Torrent'}" ${isBusy ? 'disabled' : ''}>
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

      <!-- Bottom Row: Single Main Progress Bar & Swarm Metrics -->
      <div class="compact-row-sub">
        <div class="compact-progress-container">
          <span class="compact-pct">${combinedPctText}</span>
          <div class="compact-bar-bg">
            <div class="compact-bar-fill" style="width: ${pct}%;"></div>
          </div>
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
    const isCompleted = pct >= 100 && !merged.verifying;
    let targetList = activeList;
    if (currentActiveTab === 'my-torrents') {
      if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
      else if (isCompleted && completedList) targetList = completedList;
      else targetList = activeList;
    } else if (currentActiveTab === 'completed') {
      if (isCompleted && completedList) targetList = completedList;
      else if (isMyTorrent && myTorrentsList) targetList = myTorrentsList;
      else targetList = activeList;
    } else {
      // 'downloads' tab or default: user-created / shareable torrents appear in activeList as active seeding torrents!
      if (isCompleted && !isMyTorrent && completedList) {
        targetList = completedList;
      } else {
        targetList = activeList;
      }
    }
    if (targetList && card.parentNode !== targetList) {
      targetList.prepend(card);
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
      if (pct >= 100 && !t.isMyTorrent && !t.createdByUser) {
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
    ipcRenderer.on('engine-loading-state', (event, data) => {
      if (data && data.loading) {
        showScreenLoading('Loading and indexing torrents...');
      } else {
        hideScreenLoading();
      }
    });

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

    const handleIncomingTorrentFile = async (filePath) => {
      if (!filePath) return;
      const sanitized = sanitizeTorrentInput(filePath);
      if (!sanitized) return;
      await openPromptModal(sanitized);
    };

    ipcRenderer.on('open-torrent-file', async (event, filePath) => {
      await handleIncomingTorrentFile(filePath);
    });

    ipcRenderer.on('live-network-speed', (event, snapshot) => {
      const netSpeedVal = document.getElementById('global-net-speed');
      if (netSpeedVal && snapshot && snapshot.current) {
        const totalFormatted = formatSpeed(snapshot.current.total || 0);
        netSpeedVal.textContent = totalFormatted;
        const dlFormatted = formatSpeed(snapshot.current.down || 0);
        const ulFormatted = formatSpeed(snapshot.current.up || 0);
        const dlMbps = (snapshot.current.down * 8 / 1000000).toFixed(1);
        const ulMbps = (snapshot.current.up * 8 / 1000000).toFixed(1);
        netSpeedVal.title = `Live Network Speed:\n↓ ${dlFormatted} (${dlMbps} Mbps)  ↑ ${ulFormatted} (${ulMbps} Mbps)\nClick to open interactive speed graph & history`;
      }
      if (snapshot && snapshot.current) {
        const prefDl = document.getElementById('pref-live-dl-speed');
        const prefUl = document.getElementById('pref-live-ul-speed');
        const prefTotal = document.getElementById('pref-live-total-speed');
        if (prefDl) {
          const dlBits = (snapshot.current.down * 8 / 1000000).toFixed(1);
          prefDl.textContent = `${formatSpeed(snapshot.current.down || 0)} (${dlBits} Mbps)`;
        }
        if (prefUl) {
          const ulBits = (snapshot.current.up * 8 / 1000000).toFixed(1);
          prefUl.textContent = `${formatSpeed(snapshot.current.up || 0)} (${ulBits} Mbps)`;
        }
        if (prefTotal) {
          const totalBits = ((snapshot.current.total || 0) * 8 / 1000000).toFixed(1);
          prefTotal.textContent = `${formatSpeed(snapshot.current.total || 0)} (${totalBits} Mbps)`;
        }
      }
    });

    ipcRenderer.on('preferences-updated', (event, prefs) => {
      if (prefs) {
        if (prefStatusBar && prefs.showInStatusBar !== undefined) {
          prefStatusBar.checked = Boolean(prefs.showInStatusBar);
        }
        if (prefSidebarSpeed && prefs.showSidebarSpeed !== undefined) {
          updateSidebarSpeedVisibility(Boolean(prefs.showSidebarSpeed));
        }
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

    try {
      const pendingFiles = await ipcRenderer.invoke('get-pending-open-files');
      if (Array.isArray(pendingFiles)) {
        for (const file of pendingFiles) {
          await handleIncomingTorrentFile(file);
        }
      }
    } catch (e) {}

    try {
      const liveSnapshot = await ipcRenderer.invoke('get-live-network-speed');
      if (liveSnapshot && liveSnapshot.current) {
        const netSpeedVal = document.getElementById('global-net-speed');
        if (netSpeedVal) {
          netSpeedVal.textContent = formatSpeed(liveSnapshot.current.total || 0);
        }
        const prefDl = document.getElementById('pref-live-dl-speed');
        const prefUl = document.getElementById('pref-live-ul-speed');
        const prefTotal = document.getElementById('pref-live-total-speed');
        if (prefDl) {
          const dlBits = (liveSnapshot.current.down * 8 / 1000000).toFixed(1);
          prefDl.textContent = `${formatSpeed(liveSnapshot.current.down || 0)} (${dlBits} Mbps)`;
        }
        if (prefUl) {
          const ulBits = (liveSnapshot.current.up * 8 / 1000000).toFixed(1);
          prefUl.textContent = `${formatSpeed(liveSnapshot.current.up || 0)} (${ulBits} Mbps)`;
        }
        if (prefTotal) {
          const totalBits = ((liveSnapshot.current.total || 0) * 8 / 1000000).toFixed(1);
          prefTotal.textContent = `${formatSpeed(liveSnapshot.current.total || 0)} (${totalBits} Mbps)`;
        }
      }
    } catch (e) {}
  }
});
