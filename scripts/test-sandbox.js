#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 1. Create completely isolated test sandbox in /tmp
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'torrently-test-sandbox-'));
const sandboxHome = path.join(sandboxRoot, 'home');
const sandboxDotTorrently = path.join(sandboxHome, '.torrently');
const sandboxBin = path.join(sandboxHome, 'bin');
const sandboxDownloads = path.join(sandboxHome, 'Downloads');

fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(sandboxDotTorrently, { recursive: true });
fs.mkdirSync(sandboxBin, { recursive: true });
fs.mkdirSync(sandboxDownloads, { recursive: true });

// Copy test fixture state into sandboxed .torrently
const fixtureState = path.join(__dirname, '../torrently-state.json');
if (fs.existsSync(fixtureState)) {
  try {
    fs.copyFileSync(fixtureState, path.join(sandboxDotTorrently, 'torrently-state.json'));
  } catch (e) {}
}

console.log(' [36m[Torrently Test Sandbox] [0m Running in isolated sandbox: ' + sandboxRoot);
console.log(' [32m[Torrently Test Sandbox] [0m Live production app & ~/.torrently are fully protected.');

// 2. Isolated environment variables
const env = {
  ...process.env,
  HOME: sandboxHome,
  USERPROFILE: sandboxHome,
  TORRENTLY_TEST_SANDBOX: '1',
  NODE_ENV: 'test',
  PATH: sandboxBin + ':' + process.env.PATH
};

// 3. Arguments passed to test runner
const userArgs = process.argv.slice(2);
const finalArgs = userArgs.length > 0 ? userArgs : ['tests/*.test.js'];

const child = spawn(process.execPath, ['--test', ...finalArgs], {
  cwd: path.resolve(__dirname, '..'),
  env: env,
  stdio: 'inherit'
});

function cleanup() {
  try {
    if (fs.existsSync(sandboxRoot)) {
      fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
  } catch (e) {}
}

child.on('exit', (code, signal) => {
  cleanup();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code || 0);
  }
});

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
