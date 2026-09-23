const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Terminal color helpers
const isColor = process.stdout.isTTY;
const colors = {
  reset: isColor ? '\x1b[0m' : '',
  bold: isColor ? '\x1b[1m' : '',
  green: isColor ? '\x1b[32m' : '',
  yellow: isColor ? '\x1b[33m' : '',
  blue: isColor ? '\x1b[34m' : '',
  magenta: isColor ? '\x1b[35m' : '',
  cyan: isColor ? '\x1b[36m' : '',
  red: isColor ? '\x1b[31m' : '',
  gray: isColor ? '\x1b[90m' : ''
};

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return '0 B';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 0) return '0 KB/s';
  const kbps = bytesPerSec / 1024;
  if (kbps >= 1024) {
    return (kbps / 1024).toFixed(1) + ' MB/s';
  }
  return kbps.toFixed(1) + ' KB/s';
}

function getStoredPort() {
  try {
    const portFile = path.join(os.homedir(), '.torrently', 'api.json');
    if (fs.existsSync(portFile)) {
      const data = JSON.parse(fs.readFileSync(portFile, 'utf8'));
      if (data && data.port) return data.port;
    }
  } catch (e) {}
  return 8888;
}

function request(method, apiPath, body = null, port = null) {
  const activePort = port || getStoredPort();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: activePort,
      path: apiPath,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out connecting to Torrently app'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function findActivePort() {
  const candidatePorts = [getStoredPort(), 8888, 8889, 8890, 8891];
  const uniquePorts = Array.from(new Set(candidatePorts));

  for (const p of uniquePorts) {
    try {
      const res = await request('GET', '/api/status', null, p);
      if (res.status === 200 && res.data && res.data.app === 'Torrently') {
        return p;
      }
    } catch (e) {}
  }
  return null;
}

function printHelp() {
  console.log(`
${colors.bold}${colors.cyan}Torrently CLI${colors.reset} — Command-line management for Torrently

${colors.bold}USAGE:${colors.reset}
  torrently <command> [arguments] [options]

${colors.bold}COMMANDS:${colors.reset}
  ${colors.green}list, ls${colors.reset}                         List all active and completed torrents
  ${colors.green}add <magnet|path|url>${colors.reset}            Add a new torrent or magnet link
  ${colors.green}pause <infoHash|--all>${colors.reset}           Pause a specific torrent or all torrents
  ${colors.green}resume <infoHash|--all>${colors.reset}          Resume a specific torrent or all torrents
  ${colors.green}remove, rm <infoHash>${colors.reset}           Remove a torrent (use -d to delete data)
  ${colors.green}verify <infoHash>${colors.reset}                 Re-check and verify torrent data on disk
  ${colors.green}files <infoHash>${colors.reset}                  List all individual files in a torrent
  ${colors.green}select <infoHash> <idx...>${colors.reset}       Select file index(es) to download
  ${colors.green}deselect <infoHash> <idx...>${colors.reset}     Deselect/skip file index(es) from downloading
  ${colors.green}speed${colors.reset}                            Display live network speed and stats
  ${colors.green}status-bar [on|off]${colors.reset}              View or toggle macOS menu bar speed ticker
  ${colors.green}prefs [get|set <key> <val>]${colors.reset}      View or modify application preferences
  ${colors.green}help, --help${colors.reset}                     Show this help screen

${colors.bold}OPTIONS:${colors.reset}
  --json                            Output raw JSON response
  --path <dir>                      Specify custom download location (with 'add')
  --paused                          Add torrent in paused mode
  -d, --delete-files                Also delete downloaded data from disk (with 'remove')
  -w, --watch                       Live watch network speed (with 'speed')

${colors.bold}EXAMPLES:${colors.reset}
  torrently list
  torrently add "magnet:?xt=urn:btih:..."
  torrently add ./movie.torrent --path ~/Movies
  torrently pause 8c0d12e4
  torrently resume --all
  torrently files 8c0d12e4
  torrently select 8c0d12e4 0 2
  torrently deselect 8c0d12e4 1
  torrently speed --watch
  torrently status-bar on
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ? argv[0].toLowerCase() : 'help';

  if (!argv[0] || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const isJson = argv.includes('--json');
  const port = await findActivePort();

  if (!port) {
    if (isJson) {
      console.log(JSON.stringify({ success: false, error: 'Torrently app is not running' }));
    } else {
      console.error(`${colors.red}Error:${colors.reset} Torrently desktop app is not currently running.`);
      console.error(`Please launch Torrently or start it with: ${colors.cyan}npm start${colors.reset}`);
    }
    process.exit(1);
  }

  try {
    switch (command) {
      case 'list':
      case 'ls': {
        const res = await request('GET', '/api/torrents', null, port);
        const torrents = res.data && res.data.torrents ? res.data.torrents : [];

        if (isJson) {
          console.log(JSON.stringify(torrents, null, 2));
          return;
        }

        if (torrents.length === 0) {
          console.log(`${colors.gray}No torrents currently in queue or history.${colors.reset}`);
          return;
        }

        console.log(`\n${colors.bold}TORRENTS (${torrents.length}):${colors.reset}`);
        console.log(`${colors.gray}${'HASH'.padEnd(10)} ${'NAME'.padEnd(32)} ${'PROGRESS'.padEnd(10)} ${'DOWN'.padEnd(11)} ${'UP'.padEnd(10)} ${'PEERS'.padEnd(7)} ${'STATUS'}${colors.reset}`);
        console.log('-'.repeat(88));

        torrents.forEach(t => {
          const shortHash = (t.infoHash || '').slice(0, 8);
          const name = (t.name || 'Untitled').length > 30 ? (t.name || '').slice(0, 29) + '…' : (t.name || 'Untitled');
          const pct = Math.min(100, Math.round((t.progress || 0) * 100));
          const pctStr = pct + '%';
          const downSpeed = formatSpeed(t.downloadSpeed || 0);
          const upSpeed = formatSpeed(t.uploadSpeed || 0);
          const peers = String(t.numPeers || 0);

          let statusStr = 'Downloading';
          let statusColor = colors.green;
          if (t.paused) {
            statusStr = 'Paused';
            statusColor = colors.yellow;
          } else if (pct >= 100) {
            statusStr = 'Completed (Seeding)';
            statusColor = colors.cyan;
          } else if (t.verifying) {
            statusStr = 'Verifying';
            statusColor = colors.magenta;
          }

          console.log(`${colors.bold}${shortHash.padEnd(10)}${colors.reset} ${name.padEnd(32)} ${pctStr.padEnd(10)} ${statusColor}${downSpeed.padEnd(11)}${colors.reset} ${upSpeed.padEnd(10)} ${peers.padEnd(7)} ${statusColor}${statusStr}${colors.reset}`);
        });
        console.log('');
        break;
      }

      case 'add': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide a magnet link, .torrent file path, or torrent URL.`);
          process.exit(1);
        }

        let downloadPath = null;
        const pathIdx = argv.indexOf('--path');
        if (pathIdx !== -1 && argv[pathIdx + 1]) {
          downloadPath = argv[pathIdx + 1];
        }

        const paused = argv.includes('--paused');
        let torrentId = target;

        // If it's a local file, resolve it
        if (fs.existsSync(target)) {
          torrentId = path.resolve(target);
        }

        const res = await request('POST', '/api/torrents/add', {
          torrentId,
          downloadPath,
          paused
        }, port);

        if (isJson) {
          console.log(JSON.stringify(res.data, null, 2));
        } else if (res.data.success) {
          const t = res.data.torrent || {};
          console.log(`${colors.green}✔ Torrent added successfully!${colors.reset}`);
          console.log(`  Name: ${colors.bold}${t.name || target}${colors.reset}`);
          if (t.infoHash) console.log(`  InfoHash: ${colors.cyan}${t.infoHash}${colors.reset}`);
        } else {
          console.error(`${colors.red}Error adding torrent:${colors.reset} ${res.data.error || 'Unknown error'}`);
          process.exit(1);
        }
        break;
      }

      case 'pause': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide an infoHash or '--all'.`);
          process.exit(1);
        }

        if (target === '--all') {
          const listRes = await request('GET', '/api/torrents', null, port);
          const torrents = listRes.data && listRes.data.torrents ? listRes.data.torrents : [];
          for (const t of torrents) {
            await request('POST', `/api/torrents/${t.infoHash}/pause`, {}, port);
          }
          console.log(`${colors.yellow}✔ Paused all ${torrents.length} torrents.${colors.reset}`);
        } else {
          const res = await request('POST', `/api/torrents/${target}/pause`, {}, port);
          if (res.data.success) {
            console.log(`${colors.yellow}✔ Torrent ${target} paused.${colors.reset}`);
          } else {
            console.error(`${colors.red}Error:${colors.reset} ${res.data.error || 'Could not pause'}`);
            process.exit(1);
          }
        }
        break;
      }

      case 'resume': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide an infoHash or '--all'.`);
          process.exit(1);
        }

        if (target === '--all') {
          const listRes = await request('GET', '/api/torrents', null, port);
          const torrents = listRes.data && listRes.data.torrents ? listRes.data.torrents : [];
          for (const t of torrents) {
            await request('POST', `/api/torrents/${t.infoHash}/resume`, {}, port);
          }
          console.log(`${colors.green}✔ Resumed all ${torrents.length} torrents.${colors.reset}`);
        } else {
          const res = await request('POST', `/api/torrents/${target}/resume`, {}, port);
          if (res.data.success) {
            console.log(`${colors.green}✔ Torrent ${target} resumed.${colors.reset}`);
          } else {
            console.error(`${colors.red}Error:${colors.reset} ${res.data.error || 'Could not resume'}`);
            process.exit(1);
          }
        }
        break;
      }

      case 'remove':
      case 'rm': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide an infoHash to remove.`);
          process.exit(1);
        }
        const deleteFiles = argv.includes('-d') || argv.includes('--delete-files');
        const res = await request('POST', `/api/torrents/${target}/remove`, { deleteFiles }, port);
        if (res.data.success) {
          console.log(`${colors.red}✔ Torrent ${target} removed.${deleteFiles ? ' (Files deleted from disk)' : ''}${colors.reset}`);
        } else {
          console.error(`${colors.red}Error:${colors.reset} ${res.data.error || 'Could not remove'}`);
          process.exit(1);
        }
        break;
      }

      case 'verify': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide an infoHash to verify.`);
          process.exit(1);
        }
        const res = await request('POST', `/api/torrents/${target}/verify`, {}, port);
        if (res.data.success) {
          console.log(`${colors.cyan}✔ Verification started for torrent ${target}.${colors.reset}`);
        } else {
          console.error(`${colors.red}Error:${colors.reset} ${res.data.error || 'Could not verify'}`);
          process.exit(1);
        }
        break;
      }

      case 'files': {
        const target = argv[1];
        if (!target) {
          console.error(`${colors.red}Error:${colors.reset} Please provide an infoHash.`);
          process.exit(1);
        }
        const res = await request('GET', `/api/torrents/${target}/files`, null, port);
        if (isJson) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        if (!res.data.success || !res.data.files) {
          console.error(`${colors.red}Error:${colors.reset} ${res.data.error || 'Torrent not found'}`);
          process.exit(1);
        }

        const files = res.data.files;
        console.log(`\n${colors.bold}FILES IN TORRENT (${files.length}):${colors.reset}`);
        console.log(`${colors.gray}${'INDEX'.padEnd(7)} ${'STATUS'.padEnd(12)} ${'PROGRESS'.padEnd(10)} ${'SIZE'.padEnd(12)} ${'NAME'}${colors.reset}`);
        console.log('-'.repeat(80));

        files.forEach(f => {
          const isDone = Boolean(f.isDone || (f.progress || 0) >= 1.0 || (f.length > 0 && (f.downloaded || 0) >= f.length));
          const pct = isDone ? 100 : Math.min(99, Math.floor((f.progress || 0) * 100));
          const pctStr = pct + '%';
          const sizeStr = formatBytes(f.length || 0);

          let statusStr = 'Wanted';
          let statusColor = colors.green;
          if (isDone) {
            statusStr = 'Completed';
            statusColor = colors.cyan;
          } else if (f.wanted === false) {
            statusStr = 'Skipped';
            statusColor = colors.gray;
          }

          console.log(`${String(f.index).padEnd(7)} ${statusColor}${statusStr.padEnd(12)}${colors.reset} ${pctStr.padEnd(10)} ${sizeStr.padEnd(12)} ${f.name}`);
        });
        console.log('');
        break;
      }

      case 'select': {
        const target = argv[1];
        const indices = argv.slice(2).filter(arg => !arg.startsWith('-')).map(arg => parseInt(arg, 10));
        if (!target || indices.length === 0 || indices.some(isNaN)) {
          console.error(`${colors.red}Error:${colors.reset} Usage: torrently select <infoHash> <fileIndex1> [fileIndex2 ...]`);
          process.exit(1);
        }

        for (const idx of indices) {
          await request('POST', `/api/torrents/${target}/files/${idx}/wanted`, { wanted: true }, port);
        }
        console.log(`${colors.green}✔ Selected file index(es) ${indices.join(', ')} for download.${colors.reset}`);
        break;
      }

      case 'deselect': {
        const target = argv[1];
        const indices = argv.slice(2).filter(arg => !arg.startsWith('-')).map(arg => parseInt(arg, 10));
        if (!target || indices.length === 0 || indices.some(isNaN)) {
          console.error(`${colors.red}Error:${colors.reset} Usage: torrently deselect <infoHash> <fileIndex1> [fileIndex2 ...]`);
          process.exit(1);
        }

        for (const idx of indices) {
          await request('POST', `/api/torrents/${target}/files/${idx}/wanted`, { wanted: false }, port);
        }
        console.log(`${colors.yellow}✔ Deselected / skipped file index(es) ${indices.join(', ')}.${colors.reset}`);
        break;
      }

      case 'speed': {
        const watch = argv.includes('-w') || argv.includes('--watch');

        const printSpeed = async () => {
          const res = await request('GET', '/api/speed', null, port);
          if (isJson && !watch) {
            console.log(JSON.stringify(res.data, null, 2));
            return;
          }

          const speed = res.data && res.data.speed ? res.data.speed : { downloadSpeed: 0, uploadSpeed: 0 };
          const down = formatSpeed(speed.downloadSpeed);
          const up = formatSpeed(speed.uploadSpeed);

          if (watch) {
            process.stdout.write(`\r${colors.bold}Live Speed:${colors.reset}  ↓ ${colors.green}${down}${colors.reset}   ↑ ${colors.cyan}${up}${colors.reset}   ${colors.gray}(Ctrl+C to quit)${colors.reset}   `);
          } else {
            console.log(`\n${colors.bold}Torrently Network Speed:${colors.reset}`);
            console.log(`  Download Speed: ${colors.green}${colors.bold}↓ ${down}${colors.reset}`);
            console.log(`  Upload Speed:   ${colors.cyan}${colors.bold}↑ ${up}${colors.reset}\n`);
          }
        };

        if (watch) {
          await printSpeed();
          const timer = setInterval(printSpeed, 1000);
          process.on('SIGINT', () => {
            clearInterval(timer);
            console.log('\n');
            process.exit(0);
          });
        } else {
          await printSpeed();
        }
        break;
      }

      case 'status-bar': {
        const arg = argv[1] ? argv[1].toLowerCase() : null;
        if (arg === 'on' || arg === 'enable' || arg === 'true') {
          const res = await request('POST', '/api/status-bar', { enable: true }, port);
          console.log(`${colors.green}✔ Status bar speed ticker enabled.${colors.reset}`);
        } else if (arg === 'off' || arg === 'disable' || arg === 'false') {
          const res = await request('POST', '/api/status-bar', { enable: false }, port);
          console.log(`${colors.yellow}✔ Status bar speed ticker disabled.${colors.reset}`);
        } else {
          const res = await request('GET', '/api/preferences', null, port);
          const current = res.data && res.data.preferences ? Boolean(res.data.preferences.showInStatusBar) : false;
          console.log(`Status bar ticker is currently: ${current ? colors.green + 'ENABLED' : colors.gray + 'DISABLED'}${colors.reset}`);
          console.log(`Toggle with: ${colors.cyan}torrently status-bar on${colors.reset} or ${colors.cyan}torrently status-bar off${colors.reset}`);
        }
        break;
      }

      case 'prefs': {
        const sub = argv[1] ? argv[1].toLowerCase() : 'get';
        if (sub === 'set') {
          const key = argv[2];
          const val = argv[3];
          if (!key || val === undefined) {
            console.error(`${colors.red}Error:${colors.reset} Usage: torrently prefs set <key> <value>`);
            process.exit(1);
          }
          let parsedVal = val;
          if (val === 'true') parsedVal = true;
          else if (val === 'false') parsedVal = false;
          else if (!isNaN(Number(val))) parsedVal = Number(val);

          const res = await request('POST', '/api/preferences', { [key]: parsedVal }, port);
          console.log(`${colors.green}✔ Preference '${key}' updated to: ${parsedVal}${colors.reset}`);
        } else {
          const res = await request('GET', '/api/preferences', null, port);
          const prefs = res.data && res.data.preferences ? res.data.preferences : {};
          if (isJson) {
            console.log(JSON.stringify(prefs, null, 2));
          } else {
            console.log(`\n${colors.bold}Torrently Preferences:${colors.reset}`);
            for (const [k, v] of Object.entries(prefs)) {
              if (typeof v === 'object' && v !== null) {
                console.log(`  ${colors.bold}${k}:${colors.reset}`);
                for (const [subK, subV] of Object.entries(v)) {
                  console.log(`    ${subK}: ${subV}`);
                }
              } else {
                console.log(`  ${k}: ${v}`);
              }
            }
            console.log('');
          }
        }
        break;
      }

      default:
        console.error(`${colors.red}Unknown command:${colors.reset} ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`${colors.red}Command failed:${colors.reset}`, err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, request, findActivePort, formatBytes, formatSpeed };
