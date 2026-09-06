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

