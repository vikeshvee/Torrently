const os = require('os');
const path = require('path');

function expandPath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  const trimmed = inputPath.trim();
  if (trimmed.startsWith('~')) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    return path.resolve(path.join(homeDir, trimmed.slice(1)));
  }
  return path.resolve(trimmed);
}

module.exports = { expandPath };
