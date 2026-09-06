# Requirements Specification - Torrently

---

## 1. Functional Requirements

### Magnet & Torrent File Handling
- [FR-1.1] Support parsing and downloading via `magnet:` URIs with BTIH (BitTorrent Info Hash), trackers, and display names.
- [FR-1.2] Support opening `.torrent` files via file picker or drag-and-drop.
- [FR-1.3] Display multi-file torrent contents allowing users to select/deselect specific files.

### Streaming Playback
- [FR-2.1] Provide an instant "Play Stream" action for video files (`.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`).
- [FR-2.2] Automatically prioritize metadata headers (MOOV atom / EBML header) and current playback position buffer.
- [FR-2.3] Support seeking anywhere within downloaded or actively fetching video pieces.
- [FR-2.4] Provide player controls: play/pause, volume/mute, seek timeline, full screen toggle, picture-in-picture.

### Torrent Management & Network Controls
- [FR-3.1] Pause, resume, and remove torrents (with optional disk file deletion).
- [FR-3.2] Configurable global and per-torrent download/upload speed limits (KB/s or MB/s).
- [FR-3.3] Display active metrics: download speed, upload speed, peer count, seed count, progress percentage, ETA, and swarm piece map.

---

## 2. Non-Functional Requirements

### Performance & Responsiveness
- [NFR-1.1] Time to initial playback start < 5 seconds on swarms with > 5 active seeders.
- [NFR-1.2] Main UI process must remain responsive at 60 FPS during heavy multi-peer disk I/O.

### Compatibility & OS Support
- [NFR-2.1] **macOS**: macOS 11+ (Intel & Apple Silicon universal binaries).
- [NFR-2.2] **Windows**: Windows 10/11 (x64 / ARM64).
- [NFR-2.3] **Linux**: Ubuntu 20.04+, Fedora 36+, Arch Linux.

### UI & Aesthetics
- [NFR-3.1] Dark mode glassmorphism UI with vibrant indigo/cyan accents, clear status badges, and smooth CSS transitions.
