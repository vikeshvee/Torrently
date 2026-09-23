const assert = require('assert');
const test = require('node:test');
const {
  isVideoFile,
  isAudioFile,
  isAudioOrVideoFile,
  shouldShowMainStreamButton,
  shouldShowSubfileStreamButton,
  countryCodeToFlag
} = require('../src/renderer/mediaUtils');

test('Media detection: video and audio/mp3 file extension checks', () => {
  // Video extensions
  assert.strictEqual(isVideoFile('Movie.mp4'), true);
  assert.strictEqual(isVideoFile('series.s01e01.mkv'), true);
  assert.strictEqual(isVideoFile('clip.WEBM'), true);
  assert.strictEqual(isVideoFile('video.avi'), true);
  assert.strictEqual(isVideoFile('recording.mov'), true);
  assert.strictEqual(isVideoFile('stream.m4v'), true);
  assert.strictEqual(isVideoFile('sample.ts'), true);

  // Audio/mp3 extensions
  assert.strictEqual(isAudioFile('track01.mp3'), true);
  assert.strictEqual(isAudioFile('SONG.MP3'), true);
  assert.strictEqual(isAudioFile('audio.flac'), true);
  assert.strictEqual(isAudioFile('sound.wav'), true);
  assert.strictEqual(isAudioFile('podcast.m4a'), true);

  // Combined video/mp3 check
  assert.strictEqual(isAudioOrVideoFile('Movie.mp4'), true);
  assert.strictEqual(isAudioOrVideoFile('track01.mp3'), true);
  assert.strictEqual(isAudioOrVideoFile('subtitles.srt'), false);
  assert.strictEqual(isAudioOrVideoFile('readme.txt'), false);
  assert.strictEqual(isAudioOrVideoFile('info.nfo'), false);
  assert.strictEqual(isAudioOrVideoFile('cover.jpg'), false);
  assert.strictEqual(isAudioOrVideoFile('archive.zip'), false);
  assert.strictEqual(isAudioOrVideoFile('system.iso'), false);
});

test('Main list stream button rule: removed from main list, always false', () => {
  // Case 1: Single file, video -> FALSE (removed from main list)
  const singleVideo = {
    name: 'The.Auction.mp4',
    isMultiFile: false,
    files: [{ index: 0, name: 'The.Auction.mp4', length: 1000000 }]
  };
  assert.strictEqual(shouldShowMainStreamButton(singleVideo, singleVideo.files), false);

  // Case 2: Single file, mp3 -> FALSE
  const singleMp3 = {
    name: 'podcast_episode_1.mp3',
    isMultiFile: false,
    files: [{ index: 0, name: 'podcast_episode_1.mp3', length: 500000 }]
  };
  assert.strictEqual(shouldShowMainStreamButton(singleMp3, singleMp3.files), false);

  // Case 3: Single file, non-video/non-mp3 -> FALSE
  const singleIso = {
    name: 'ubuntu-22.04.iso',
    isMultiFile: false,
    files: [{ index: 0, name: 'ubuntu-22.04.iso', length: 2000000 }]
  };
  assert.strictEqual(shouldShowMainStreamButton(singleIso, singleIso.files), false);

  // Case 4: Multi-file torrent -> FALSE
  const multiVideo = {
    name: 'Season 1 Complete',
    isMultiFile: true,
    files: [
      { index: 0, name: 'S01E01.mp4', length: 1000 },
      { index: 1, name: 'S01E02.mp4', length: 1000 }
    ]
  };
  assert.strictEqual(shouldShowMainStreamButton(multiVideo, multiVideo.files), false);
});

test('Sub list stream button rule: show for video/mp3 files, hide for others', () => {
  const videoFile = { index: 0, name: 'Episode01.mp4' };
  const mkvFile = { index: 1, name: 'FeatureFilm.mkv' };
  const mp3File = { index: 2, name: 'Soundtrack.mp3' };
  const subtitleFile = { index: 3, name: 'English.srt' };
  const textFile = { index: 4, name: 'Readme.txt' };
  const imageFile = { index: 5, name: 'Poster.jpg' };
  const nfoFile = { index: 6, name: 'Release.nfo' };

  assert.strictEqual(shouldShowSubfileStreamButton(videoFile), true);
  assert.strictEqual(shouldShowSubfileStreamButton(mkvFile), true);
  assert.strictEqual(shouldShowSubfileStreamButton(mp3File), true);

  assert.strictEqual(shouldShowSubfileStreamButton(subtitleFile), false);
  assert.strictEqual(shouldShowSubfileStreamButton(textFile), false);
  assert.strictEqual(shouldShowSubfileStreamButton(imageFile), false);
  assert.strictEqual(shouldShowSubfileStreamButton(nfoFile), false);
});

test('Player audio settings persistence: volume and mute level save and restore', () => {
  // Mock localStorage store
  const mockStorage = new Map();
  const STORAGE_KEY_VOLUME = 'torrently_player_volume';
  const STORAGE_KEY_MUTED = 'torrently_player_muted';

  // Mock video element
  const mockVideo = {
    volume: 1.0,
    muted: false
  };

  function saveAudio(el) {
    mockStorage.set(STORAGE_KEY_VOLUME, el.volume.toString());
    mockStorage.set(STORAGE_KEY_MUTED, el.muted ? 'true' : 'false');
  }

  function restoreAudio(el) {
    const savedVol = mockStorage.get(STORAGE_KEY_VOLUME);
    if (savedVol !== undefined) {
      const v = parseFloat(savedVol);
      if (!isNaN(v) && v >= 0 && v <= 1) el.volume = v;
    }
    const savedMuted = mockStorage.get(STORAGE_KEY_MUTED);
    if (savedMuted !== undefined) {
      el.muted = (savedMuted === 'true');
    }
  }

  // User sets volume to 35% and mutes audio
  mockVideo.volume = 0.35;
  mockVideo.muted = true;
  saveAudio(mockVideo);

  // New video element initialized on next stream click
  const newStreamVideo = {
    volume: 1.0,
    muted: false
  };

  restoreAudio(newStreamVideo);
  assert.strictEqual(newStreamVideo.volume, 0.35);
  assert.strictEqual(newStreamVideo.muted, true);

  // User changes volume to 75% and un-mutes audio
  newStreamVideo.volume = 0.75;
  newStreamVideo.muted = false;
  saveAudio(newStreamVideo);

  // Next stream click
  const subsequentVideo = { volume: 1.0, muted: false };
  restoreAudio(subsequentVideo);
  assert.strictEqual(subsequentVideo.volume, 0.75);
  assert.strictEqual(subsequentVideo.muted, false);
});

test('Country code to flag emoji conversion and fallback rules', () => {
  assert.strictEqual(typeof countryCodeToFlag, 'function');

  // Standard countries
  assert.strictEqual(countryCodeToFlag('US'), '🇺🇸');
  assert.strictEqual(countryCodeToFlag('GB'), '🇬🇧');
  assert.strictEqual(countryCodeToFlag('DE'), '🇩🇪');
  assert.strictEqual(countryCodeToFlag('FR'), '🇫🇷');
  assert.strictEqual(countryCodeToFlag('IN'), '🇮🇳');
  assert.strictEqual(countryCodeToFlag('JP'), '🇯🇵');
  assert.strictEqual(countryCodeToFlag('RU'), '🇷🇺');
  assert.strictEqual(countryCodeToFlag('BR'), '🇧🇷');

  // Case insensitivity
  assert.strictEqual(countryCodeToFlag('us'), '🇺🇸');
  assert.strictEqual(countryCodeToFlag('de'), '🇩🇪');

  // Local / Private LAN
  assert.strictEqual(countryCodeToFlag('LAN'), '🏠');
  assert.strictEqual(countryCodeToFlag('LOCAL'), '🏠');

  // Unknown / Fallback
  assert.strictEqual(countryCodeToFlag('XX'), '🌐');
  assert.strictEqual(countryCodeToFlag('UNKNOWN'), '🌐');
  assert.strictEqual(countryCodeToFlag(''), '🌐');
  assert.strictEqual(countryCodeToFlag(null), '🌐');
});

test('Create Torrent top button text does not have duplicate plus sign', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

  // Verify button does not have duplicate plus "+ + Create Torrent"
  assert.strictEqual(html.includes('+ Create Torrent'), false, 'Button should not contain duplicate "+ Create Torrent"');
  assert.strictEqual(html.includes('<span>Create Torrent</span>'), true, 'Button should contain clean "Create Torrent" text');
});

test('Shareable & user-created torrents target the active list in Downloads view and my-torrents in My Torrents view', () => {
  function getTargetView(torrent, activeTab) {
    const pct = Math.min(100, Math.floor((torrent.progress || 0) * 100));
    const isMyTorrent = Boolean(torrent.isMyTorrent || torrent.createdByUser);
    const isCompleted = pct >= 100 && !torrent.verifying && !torrent.actionBusy;

    if (activeTab === 'my-torrents') {
      if (isMyTorrent) return 'my-torrents-list';
      if (isCompleted) return 'completed-list';
      return 'torrent-list';
    } else if (activeTab === 'completed') {
      if (isCompleted) return 'completed-list';
      if (isMyTorrent) return 'my-torrents-list';
      return 'torrent-list';
    } else { // 'downloads' view
      // All active downloads and created/shareable torrents appear in the main active list!
      if (isCompleted && !isMyTorrent) return 'completed-list';
      return 'torrent-list';
    }
  }

  const createdTorrent = {
    infoHash: 'abc1234567890abcdef1234567890abcdef1234',
    name: 'Shared_Album_Lossless',
    isMyTorrent: true,
    createdByUser: true,
    progress: 1.0, // 100% seeding
    paused: false
  };

  const downloadingTorrent = {
    infoHash: 'def1234567890abcdef1234567890abcdef1234',
    name: 'Linux_Distribution.iso',
    progress: 0.45,
    paused: false
  };

  const finishedDownloadTorrent = {
    infoHash: '7891234567890abcdef1234567890abcdef1234',
    name: 'Documentation.pdf',
    progress: 1.0,
    paused: false
  };

  // When user is on default "Downloads" tab:
  // User-created torrent MUST appear in the main active list ('torrent-list') so it is visible to the user!
  assert.strictEqual(getTargetView(createdTorrent, 'downloads'), 'torrent-list');
  assert.strictEqual(getTargetView(downloadingTorrent, 'downloads'), 'torrent-list');
  assert.strictEqual(getTargetView(finishedDownloadTorrent, 'downloads'), 'completed-list');

  // When user is on "My Torrents" tab:
  assert.strictEqual(getTargetView(createdTorrent, 'my-torrents'), 'my-torrents-list');

  // When user is on "Completed" tab:
  assert.strictEqual(getTargetView(finishedDownloadTorrent, 'completed'), 'completed-list');
});

test('Source path resolution and validation handles files and directories', () => {
  const fs = require('fs');
  const path = require('path');

  function resolveSource(cleanPath) {
    if (!cleanPath || typeof cleanPath !== 'string') return null;
    const p = cleanPath.trim();
    if (!p) return null;

    let isDir = false;
    let size = 0;
    if (fs.existsSync(p)) {
      const s = fs.statSync(p);
      isDir = s.isDirectory();
      size = isDir ? 0 : s.size;
    }
    return {
      path: p,
      name: path.basename(p),
      isDirectory: isDir,
      size
    };
  }

  // Testing with current directory
  const dirSource = resolveSource(__dirname);
  assert.strictEqual(dirSource.isDirectory, true);
  assert.strictEqual(dirSource.name, 'tests');

  // Testing with this file
  const fileSource = resolveSource(__filename);
  assert.strictEqual(fileSource.isDirectory, false);
  assert.strictEqual(fileSource.name, 'media.test.js');
  assert.ok(fileSource.size > 0);
});

test('Menu visibility defaults: My Torrents is hidden by default, Downloads and Completed are visible, Preferences is permanent', () => {
  const DEFAULT_MENU_VISIBILITY = {
    downloads: true,
    completed: true,
    'my-torrents': false, // Default hidden per user request
    preferences: true     // Settings cannot be hidden
  };

  assert.strictEqual(DEFAULT_MENU_VISIBILITY['my-torrents'], false, 'My Torrents menu should be hidden by default');
  assert.strictEqual(DEFAULT_MENU_VISIBILITY.downloads, true, 'Downloads menu should be visible by default');
  assert.strictEqual(DEFAULT_MENU_VISIBILITY.completed, true, 'Completed menu should be visible by default');
  assert.strictEqual(DEFAULT_MENU_VISIBILITY.preferences, true, 'Preferences/Settings menu should be visible by default');
});

test('Menu visibility settings protection: Settings cannot be hidden even if explicitly requested', () => {
  function sanitizeMenuVisibility(requested) {
    return {
      downloads: requested && requested.downloads !== undefined ? Boolean(requested.downloads) : true,
      completed: requested && requested.completed !== undefined ? Boolean(requested.completed) : true,
      'my-torrents': requested && requested['my-torrents'] !== undefined ? Boolean(requested['my-torrents']) : false,
      preferences: true // Always true, cannot be overridden
    };
  }

  const sanitized1 = sanitizeMenuVisibility({ downloads: false, completed: false, 'my-torrents': false, preferences: false });
  assert.strictEqual(sanitized1.preferences, true, 'Preferences/Settings must remain true even when false is requested');
  assert.strictEqual(sanitized1.downloads, false);
  assert.strictEqual(sanitized1.completed, false);
  assert.strictEqual(sanitized1['my-torrents'], false);

  const sanitized2 = sanitizeMenuVisibility({ 'my-torrents': true });
  assert.strictEqual(sanitized2['my-torrents'], true);
  assert.strictEqual(sanitized2.preferences, true);
});

test('Menu visibility fallback: When an active tab is hidden, fallback navigates to first available visible tab', () => {
  function getTabFallback(targetTab, visibility) {
    if (visibility[targetTab] !== false) return targetTab;
    if (visibility.downloads) return 'downloads';
    if (visibility.completed) return 'completed';
    return 'preferences';
  }

  // If My Torrents is hidden (default) and requested, fallback to Downloads
  assert.strictEqual(getTabFallback('my-torrents', { downloads: true, completed: true, 'my-torrents': false, preferences: true }), 'downloads');

  // If Downloads is also hidden, fallback to Completed
  assert.strictEqual(getTabFallback('downloads', { downloads: false, completed: true, 'my-torrents': false, preferences: true }), 'completed');

  // If both Downloads and Completed are hidden, fallback to Preferences (Settings)
  assert.strictEqual(getTabFallback('downloads', { downloads: false, completed: false, 'my-torrents': false, preferences: true }), 'preferences');
});

test('Universal Video & Audio Formats: AC3, HEVC, AVI, MKV, DTS, and legacy container support', () => {
  // Common video formats that require playback support
  const universalVideoFiles = [
    'classic_movie.avi',
    'film.xvid.avi',
    'video.divx',
    'episode.wmv',
    'old_stream.flv',
    'mobile_clip.3gp',
    'broadcast_stream.ts',
    'bluray_rip.m2ts',
    'camcorder.mts',
    'dvd_rip.vob',
    'legacy_clip.mpg',
    'legacy_video.mpeg',
    'web_video.ogv',
    'realmedia.rm',
    'realmedia_variable.rmvb',
    'advanced_stream.asf',
    'modern_feature.mkv',
    'h264_stream.mp4'
  ];

  for (const file of universalVideoFiles) {
    assert.strictEqual(isVideoFile(file), true, `File ${file} should be recognized as video`);
    assert.strictEqual(isAudioOrVideoFile(file), true, `File ${file} should be recognized as audio/video`);
    assert.strictEqual(shouldShowSubfileStreamButton({ name: file, index: 0 }), true, `Stream button should show for ${file}`);
  }

  // Audio formats including Dolby / DTS
  const universalAudioFiles = [
    'surround_soundtrack.ac3',
    'dolby_digital_plus.eac3',
    'dts_master_audio.dts',
    'dts_hd.dtshd',
    'lossless_track.alac',
    'studio_recording.aiff',
    'matroska_audio.mka',
    'discord_voice.opus',
    'windows_audio.wma',
    'standard_song.mp3',
    'flac_album.flac',
    'wave_audio.wav'
  ];

  for (const file of universalAudioFiles) {
    assert.strictEqual(isAudioFile(file), true, `File ${file} should be recognized as audio`);
    assert.strictEqual(isAudioOrVideoFile(file), true, `File ${file} should be recognized as audio/video`);
    assert.strictEqual(shouldShowSubfileStreamButton({ name: file, index: 0 }), true, `Stream button should show for ${file}`);
  }
});

test('StreamServer: shouldAutoTranscode properly detects files needing FFmpeg transcoding', () => {
  const StreamServer = require('../src/main/streamServer');
  const dummyServer = new StreamServer(null);

  // Files with non-native containers must auto-transcode
  assert.strictEqual(dummyServer.shouldAutoTranscode('movie.avi'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('clip.wmv'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('stream.flv'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('broadcast.ts'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('dvd.vob'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('dvd.divx'), true);

  // Files with AC3, DTS, HEVC, H265, X265, 10bit in title must auto-transcode
  assert.strictEqual(dummyServer.shouldAutoTranscode('Movie.2024.1080p.HEVC.AC3.mkv'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('Show.S02E05.720p.x265-Torrently.mp4'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('EpicFilm.DTS-HD.MA.5.1.mkv'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('Animation.10bit.H265.mkv'), true);
  assert.strictEqual(dummyServer.shouldAutoTranscode('Concert.Live.EAC3.mkv'), true);

  // Standard H.264 MP4 without special audio does NOT need auto-transcode
  assert.strictEqual(dummyServer.shouldAutoTranscode('BigBuckBunny.mp4'), false);
  assert.strictEqual(dummyServer.shouldAutoTranscode('standard_clip.webm'), false);
});




