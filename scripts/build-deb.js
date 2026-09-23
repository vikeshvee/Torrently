const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('[Debian Build Prep] Ensuring Linux x64 native binaries...');

// 1. node-datachannel linux-x64 prebuild
try {
  const ndcDir = path.join(__dirname, '../node_modules/node-datachannel');
  if (fs.existsSync(ndcDir)) {
    execSync('npx prebuild-install -r napi --arch=x64 --platform=linux', { cwd: ndcDir, stdio: 'inherit' });
  }
} catch (e) {
  console.warn('[Debian Build Prep] node-datachannel prep warning:', e.message);
}

// 2. Remove host build folders from modules that supply prebuilds
const cleanupDirs = [
  'node_modules/utp-native/build',
  'node_modules/bufferutil/build',
  'node_modules/utf-8-validate/build'
];
for (const rel of cleanupDirs) {
  const abs = path.join(__dirname, '..', rel);
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { recursive: true, force: true });
  }
}

try {
  console.log('[Debian Build Prep] Packaging with electron-builder...');
  execSync('npx electron-builder --linux deb --x64 -c.npmRebuild=false', {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });
} finally {
  console.log('[Debian Build Prep] Restoring host native binaries...');
  try {
    const ndcDir = path.join(__dirname, '../node_modules/node-datachannel');
    if (fs.existsSync(ndcDir)) {
      execSync('npx prebuild-install -r napi', { cwd: ndcDir, stdio: 'ignore' });
    }
  } catch (e) {}
}
