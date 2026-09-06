# Architecture Specification - Torrently

Torrently follows a multi-process desktop architecture separating the UI system, the P2P BitTorrent engine, and the HTTP media streaming pipeline.

---

## 1. System Topology

```
┌──────────────────────────────────────────────────────────────┐
│                    UI Renderer Process                       │
│  - HTML5 / CSS3 (Glassmorphism Dark Theme)                   │
│  - Video Player Component (Custom Controls, Seek Bar)         │
│  - Swarm Dashboard, Torrent Cards, Bandwidth Graph           │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC / WebSocket Bridge
┌──────────────────────────────▼───────────────────────────────┐
│                    Main Desktop Controller                   │
│  - App Lifecycle & Window Management                         │
│  - OS Integration (Native Dialogs, Magnet Protocol Handler)   │
│  - Security & Local Token Validation                         │
└──────────────┬───────────────────────────────┬───────────────┘
               │                               │
┌──────────────▼──────────────┐ ┌──────────────▼───────────────┐
│   BitTorrent Engine Node    │ │   Local HTTP Stream Server   │
│ - Peer Wire Protocol        │ │ - 127.0.0.1 HTTP Server       │
│ - DHT, PEX, Trackers        │ │ - Byte-Range Header Handler  │
│ - Sequential Piece Selector │ │ - In-Memory / File Buffer    │
└─────────────────────────────┘ └──────────────────────────────┘
```

---

## 2. Component Specifications

### A. Torrent Engine (`src/main/engine.js`)
- Based on WebTorrent / Node BitTorrent protocol implementation.
- Manages peer connections via TCP, WebRTC, and UDP (DHT/UTP).
- Dynamically switches torrent piece selection strategy:
  - **Standard Mode**: Rarest-first piece fetching.
  - **Streaming Mode**: Header-first + sliding window sequential fetching.

### B. HTTP Stream Server (`src/main/streamServer.js`)
- Spawns an internal HTTP server bound exclusively to `127.0.0.1`.
- Listens for standard HTML5 `<video>` requests containing `Range: bytes=X-Y` headers.
- Converts range requests into target piece indices, prompting the Torrent Engine to prioritize those pieces from peers.
- Pipes piece byte buffers directly into the HTTP response stream.

### C. UI Renderer (`src/renderer/`)
- Built with HTML5, Vanilla CSS3 (CSS Variables, Flexbox/Grid, Backdrop Filters), and JavaScript.
- Communicates with the main process via secure IPC channels (`window.torrentlyAPI`).
- Renders live download speed gauges, ETA calculations, peer counters, piece availability maps, and embedded video stream overlay.
