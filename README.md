# Torrently ⚡

<div align="center">
  <img src="build/icon.png" width="128" height="128" alt="Torrently Logo" />
  <h3>High-Performance Desktop BitTorrent Client & Instant Streamer</h3>
  <p>Stream HD videos and audio directly as they download, package and seed custom torrents, track peers globally with country flags, and control your downloads from the terminal.</p>

  [![Version: v1.0.0 Stable](https://img.shields.io/badge/Version-v1.0.0%20Stable-blue.svg)](https://github.com/vikeshvee/torrently/releases)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/vikeshvee/torrently)
  [![Electron](https://img.shields.io/badge/Electron-30.0.0-47848F?logo=electron&logoColor=white)](https://electronjs.org)
  [![WebTorrent](https://img.shields.io/badge/WebTorrent-v3.0.21-E84118)](https://webtorrent.io)
  [![Tests](https://img.shields.io/badge/Tests-62%20Passing-10B981)](#-running-tests)
</div>

---

## 🌟 Key Points of Release v1.0.0

Torrently v1.0.0 is the first stable production release, engineered for performance, media versatility, and rock-solid state management:

- 🎬 **Universal Video & Audio Playback**: Instant streaming with real-time FFmpeg transcoding for **AC3 audio**, **HEVC (H.265)**, **AVI**, **MKV**, **DTS**, and **FLAC** containers. Watch movies instantly while pieces are sequentially prioritized.
- 📁 **Zero Duplicate Directory Nesting**: Intelligent path normalization prevents WebTorrent from creating redundant `/Folder/Folder` subdirectories when resuming or saving multi-file downloads.
- 🔄 **Safe State Integrity Across Restarts**: Preserves running, paused, and completed torrents across application restarts and new builds without resetting download progress to 0%.
- ⚡ **Headless Terminal CLI & Daemon**: Full-featured `torrently` command registered in system PATH with background daemon mode (`torrently daemon start`) and local REST API.
- 📊 **Real-Time Bandwidth Monitor & History**: Floating live speed graph window with 1-hour and 24-hour retention, CSV/JSON export, and macOS top menu bar throughput meter.
- 🎛️ **Modern iOS-Style UI Controls**: Refined settings panel with iOS toggle switches, row-click accordion expansion, subfile size cycling (Total / Remaining / Both), and per-file + combined ETA readouts.
- 📦 **Cross-Platform Native Installers**: Official **Apple Silicon macOS (`.dmg`)** and **Linux Debian (`.deb`)** production packages.

---

## 📸 Screenshots & Highlights

### 1. Active Downloads & Media Streaming Dashboard
Track active torrent downloads with live progress, true individual sub-file speeds, playable media stream indicators, and dynamic speed gauges.
<p align="center">
  <img src="screenshots/dashboard-downloads.png" alt="Torrently Dashboard" width="95%" />
</p>

---

### 2. "My Torrents" Creator & Seeding Hub
Create and seed torrents from files or directories, monitor swarm data transfers, and manage active uploads.
<p align="center">
  <img src="screenshots/my-torrents.png" alt="My Torrents Tab" width="95%" />
</p>

---

### 3. Swarm Inspector, Country Flags & Node Blocking
Inspect connected peers with automatic country flag resolution, download/upload rates, and the ability to ban or unblock individual nodes on the fly.
<p align="center">
  <img src="screenshots/peers-inspector.png" alt="Swarm Inspector" width="95%" />
</p>

---

### 4. Create Torrent from File or Folder
Recursively package entire directories or single files into torrents with custom trackers, comments, and private swarm options.
<p align="center">
  <img src="screenshots/create-torrent-modal.png" alt="Create Torrent Modal" width="75%" />
</p>

---

## 🚀 Key Features

### 🎬 Instant Media Streaming
- Sequential piece prioritization starts playback within seconds of adding a torrent.
- Embedded HTML5 player with volume and mute state persistence.
- Automatic FFmpeg transcoding for unsupported codecs (AC3, HEVC/H.265, AVI, DTS).
- Direct streaming to external players (VLC, IINA, MPV) via standard HTTP range requests (`http://127.0.0.1:8888`).

### 📁 Selective File Downloading & Sizing Modes
- Uncheck unwanted files (e.g. sample clips, readme text) to download only the files you need.
- Overall progress and downloaded percentage are calculated strictly from selected files.
- Clicking any subfile size cycles through:
  1. **Total Size** (e.g. `1.4 GB`)
  2. **Remaining Size** (e.g. `320 MB left`)
  3. **Total & Downloaded** (e.g. `1.1 GB / 1.4 GB`)
- Per-file ETA readouts (`Downloading (↓ 1.2 MB/s • 1m 30s)`) and combined torrent ETA in the progress bar.

### 🛡️ Peer Node Management & Geolocation
- Built-in offline GeoIP engine maps peer IP addresses to ISO country codes and flag emojis (🇺🇸, 🇩🇪, 🇮🇳, 🇬🇧, etc.).
- Identify peer client software (Transmission, qBittorrent, WebTorrent, uTorrent).
- **Block Node**: Instantly chokes and terminates connections with suspicious or leeching peers, blacklisting them from reconnecting.

### 📊 Live Bandwidth Monitor & macOS Menu Bar
- Interactive standalone network speed graph with download/upload throughput.
- 1-hour and 24-hour historical records with 1-second sampling accuracy.
- Export bandwidth history to CSV or JSON with a single click.
- Optional top macOS menu bar speed readout next to the system clock.

### ⌨️ Command-Line Interface (CLI)
- System-wide `torrently` command accessible directly from terminal.
- Background daemon mode with REST API for scripted and remote torrent operations:
  ```bash
  torrently add "magnet:?xt=urn:btih:..."
  torrently list
  torrently stream <infoHash>
  torrently pause <infoHash>
  torrently resume <infoHash>
  torrently speed
  torrently daemon start
  ```

---

## 🛠️ Tech Stack & Architecture

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Runtime & Shell** | [Electron 30](https://www.electronjs.org/) | Cross-platform desktop application environment with native system integration. |
| **Torrent Engine** | [WebTorrent 3.0](https://webtorrent.io/) | Accelerated BitTorrent protocol implementation with DHT, PEX, MSE, and tracker support. |
| **Stream Server** | [Express](https://expressjs.com/) & [FFmpeg Static](https://github.com/eugeneware/ffmpeg-static) | Local HTTP range-request server with real-time audio/video transcoding. |
| **Bandwidth Monitor** | Native System APIs & History Engine | Lightweight sampling daemon with ring-buffer storage and CSV/JSON export. |
| **CLI & REST Daemon** | Node.js Unix Socket & REST Engine | Headless client integration allowing full terminal and automated operation. |
| **Packaging & Dist** | [electron-builder](https://www.electron.build/) | Produces signed Apple Silicon DMG (`.dmg`) and Linux Debian (`.deb`) installers. |

---

## 📥 Installation

### 🍏 macOS (Apple Silicon)
1. Download **`Torrently-1.0.0-arm64.dmg`** from the `dist/` directory or Releases page.
2. Open the `.dmg` file and drag **Torrently** into your **Applications** folder.
3. Launch **Torrently** from Applications or Spotlight (`Cmd + Space`).

### 🐧 Linux (Debian / Ubuntu / Pop!_OS)
1. Download **`torrently_1.0.0_arm64.deb`**.
2. Install via `dpkg` or `apt`:
   ```bash
   sudo dpkg -i torrently_1.0.0_arm64.deb
   # Or:
   sudo apt install ./torrently_1.0.0_arm64.deb
   ```
3. Launch **Torrently** from your application menu or run `torrently` from terminal.

---

### 💻 Build from Source

#### Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or higher)
- [npm](https://www.npmjs.com/) (version 9 or higher)
- Git

#### Step-by-Step Setup
```bash
# 1. Clone the repository
git clone https://github.com/vikeshvee/torrently.git
cd torrently

# 2. Install dependencies
npm install

# 3. Launch in development mode
npm start

# 4. Run automated test suite
npm test
```

#### Package Installers
```bash
# Build macOS Apple Silicon DMG
npm run dist:dmg

# Build Linux Debian package
npm run dist:deb
```

---

## 🧪 Running Tests

The test suite runs with Node.js built-in test runner inside an isolated sandbox environment that safeguards your user home directory:

```bash
npm test
```

Includes **62 automated unit and integration tests** covering:
- Safe path normalization and zero duplicate directory nesting
- Startup state integrity across restarts and completed torrent preservation
- Real-time per-file download speed tracking and selective downloading
- Universal media detection (AC3, HEVC, AVI, MKV, DTS, FLAC) and stream transcoding
- Offline GeoIP country flag resolution and peer node blocking
- Headless CLI lifecycle (install, daemon, add, list, remove, uninstall)
- Real-time bandwidth monitor, history downsampling, and CSV/JSON export
- UI responsiveness, iOS switches, and compact action controls

---

## 👨‍💻 Developer & Author

**Developed by**: [vikeshvee@gmail.com](mailto:vikeshvee@gmail.com)  
**GitHub**: [@vikeshvee](https://github.com/vikeshvee)

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
