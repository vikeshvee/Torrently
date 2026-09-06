// Media Detection and Stream Visibility Utilities for Torrently

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv',
  '3gp', 'ts', 'ogv', 'mpg', 'mpeg', 'vob'
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'mka'
]);

function getFileExtension(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const clean = filename.trim();
  const lastDot = clean.lastIndexOf('.');
  if (lastDot === -1 || lastDot === clean.length - 1) return '';
  return clean.slice(lastDot + 1).toLowerCase();
}

function isVideoFile(filename) {
  const ext = getFileExtension(filename);
  return VIDEO_EXTENSIONS.has(ext);
}

function isAudioFile(filename) {
  const ext = getFileExtension(filename);
  return AUDIO_EXTENSIONS.has(ext);
}

function isAudioOrVideoFile(filename) {
  const ext = getFileExtension(filename);
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
}

/**
 * Determines whether the Stream button should be displayed on the main torrent list card.
 * Rule: Removed from main list. Main card never shows play/stream button; stream buttons are kept exclusively in sub-list view.
 */
function shouldShowMainStreamButton(torrent, filesList) {
  return false;
}

/**
 * Determines whether an individual sub-list item (row in files accordion) should show a stream/play button.
 * Rule: Show stream or play button if the sub list item is a video or mp3/audio file, otherwise hide it.
 */
function shouldShowSubfileStreamButton(file) {
  if (!file) return false;
  const fileName = typeof file === 'string' ? file : (file.name || file.path || '');
  return isAudioOrVideoFile(fileName);
}

function countryCodeToFlag(countryCode) {
  if (!countryCode) return '🌐';
  const code = String(countryCode).trim().toUpperCase();
  if (code === 'LAN' || code === 'LOCAL' || code === 'LOOPBACK') return '🏠';
  if (code === 'XX' || code === 'UNKNOWN' || code.length !== 2) return '🌐';
  try {
    const offset = 0x1F1E6 - 65;
    return String.fromCodePoint(code.charCodeAt(0) + offset, code.charCodeAt(1) + offset);
  } catch (e) {
    return '🌐';
  }
}

const mediaUtils = {
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  getFileExtension,
  isVideoFile,
  isAudioFile,
  isAudioOrVideoFile,
  shouldShowMainStreamButton,
  shouldShowSubfileStreamButton,
  countryCodeToFlag
};

if (typeof window !== 'undefined') {
  window.mediaUtils = mediaUtils;
  window.countryCodeToFlag = countryCodeToFlag;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = mediaUtils;
}
