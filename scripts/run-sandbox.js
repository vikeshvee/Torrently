#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Dedicated, isolated sandbox root for development testing
const sandboxRoot = path.join(os.tmpdir(), 'torrently-dev-testing');
const sandboxHome = path.join(sandboxRoot, 'home');
const sandboxDotTorrently = path.join(sandboxHome, '.torrently');
const sandboxDownloads = path.join(sandboxHome, 'Downloads');
const sandboxBin = path.join(sandboxHome, 'bin');

fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(sandboxDotTorrently, { recursive: true });
fs.mkdirSync(sandboxDownloads, { recursive: true });
fs.mkdirSync(sandboxBin, { recursive: true });

// Seed initial state if needed
const stateDest = path.join(sandboxDotTorrently, 'torrently-state.json');
if (!fs.existsSync(stateDest)) {
  const fixture = path.join(__dirname, '../torrently-state.json');
  if (fs.existsSync(fixture)) {
    try {
      fs.copyFileSync(fixture, stateDest);
    } catch (e) {}
  }
}

// Ensure preferences point to sandboxed Downloads directory
const prefDest = path.join(sandboxDotTorrently, 'preferences.json');
if (!fs.existsSync(prefDest)) {
  try {
    fs.writeFileSync(prefDest, JSON.stringify({
      savePath: sandboxDownloads,
      autoStart: true,
      maxConnections: 200,
      downloadSpeedLimit: 0,
      showInStatusBar: false,
      showSidebarSpeed: false,
      showCompletionNotification: true
    }, null, 2));
  } catch (e) {}
}

console.log('\x1b[36m[Torrently Sandbox Runner]\x1b[0m Starting Torrently in testing sandbox...');
console.log('\x1b[36m[Torrently Sandbox Runner]\x1b[0m Sandbox root: ' + sandboxRoot);
console.log('\x1b[32m[Torrently Sandbox Runner]\x1b[0m Live production app, ~/.torrently, and port 8888 are 100% PROTECTED.');

const env = {
  ...process.env,
  HOME: sandboxHome,
  USERPROFILE: sandboxHome,
  TORRENTLY_DEV_SANDBOX: '1',
  PATH: sandboxBin + ':' + process.env.PATH
};

const sandboxUserData = path.join(sandboxRoot, 'userData');
fs.mkdirSync(sandboxUserData, { recursive: true });

const electronBinary = path.resolve(__dirname, '../node_modules/.bin/electron');
const electronArgs = ['.', `--user-data-dir=${sandboxUserData}`, ...process.argv.slice(2)];

const child = spawn(electronBinary, electronArgs, {
  cwd: path.resolve(__dirname, '..'),
  env: env,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  console.log(`\x1b[36m[Torrently Sandbox Runner]\x1b[0m Process exited with code ${code || 0} ${signal ? '(' + signal + ')' : ''}`);
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('\x1b[31m[Torrently Sandbox Runner]\x1b[0m Failed to launch Electron:', err);
  process.exit(1);
});
