# Development Roadmap - Torrently

---

## Phase 1: MVP Setup & Foundation (Current Phase)
- [x] Create project specification suite (`AGENTS.md`, `.ai/*`, `skills/*`).
- [x] Bootstrap core Electron + Vite / HTML5 / CSS3 client structure.
- [x] Implement magnet link parser, WebTorrent engine setup, and embedded streaming server architecture.
- [x] Design glassmorphic dark-mode interface with live torrent status cards.

## Phase 2: Enhanced Media Playback & Controls
- [ ] Subtitle file loading (`.srt`, `.vtt`) with auto-encoding detection.
- [ ] Integrated audio stream switcher (multi-language audio tracks).
- [ ] AirPlay and Chromecast casting integration.

## Phase 3: Advanced Torrent Management
- [ ] Per-file selective downloading tree with priority sliders.
- [ ] Global bandwidth scheduling & network speed graphs.
- [ ] IP blocklist (PeerGuardian format) and encrypted peer transport (MSE/PE).

## Phase 4: Cross-Platform Packaging & Distribution
- [ ] macOS signed DMG & auto-updater.
- [ ] Windows NSIS setup & portable executable.
- [ ] Linux AppImage & Flatpak packages.
