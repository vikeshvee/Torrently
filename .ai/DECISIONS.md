# Architectural Decision Records (ADRs) - Torrently

---

## ADR-001: WebTorrent as Core Torrent Protocol Engine

- **Status**: Accepted
- **Context**: Torrently requires a JavaScript/Node-native P2P engine that supports hybrid protocol connections (TCP, UDP, WebRTC) and native sequential piece fetching for streaming.
- **Decision**: Adopt WebTorrent for BitTorrent parsing, tracker queries, DHT discovery, and piece buffer management.
- **Consequences**: Enables seamless cross-platform execution in Electron/Node environments without requiring heavy native C++ libtorrent compilation for initial setups.

---

## ADR-002: Embedded Local HTTP Byte-Range Server for Video Playback

- **Status**: Accepted
- **Context**: Standard HTML5 video elements require HTTP `Range: bytes=start-end` support to handle seeking, container probing, and smooth playback buffering.
- **Decision**: Implement an internal Node.js HTTP server bound to `127.0.0.1` that translates HTTP range headers into WebTorrent piece prioritizations and streams the piece buffers.
- **Consequences**: HTML5 `<video>` tags and external media players (VLC, IINA) can play downloading videos seamlessly via `http://127.0.0.1:<port>/stream/<infohash>/<fileindex>`.

---

## ADR-003: Vanilla CSS Design System with Glassmorphic Aesthetic

- **Status**: Accepted
- **Context**: High-end user experience requires ultra-sleek visuals without framework overhead or compile-step bloat.
- **Decision**: Build UI using pure CSS3 variables, backdrop filters, glassmorphic container cards, glowing neon status accents, and CSS Grid layout.
- **Consequences**: Ultra-fast UI render speeds, smooth animations, precise visual control, and zero external CSS dependency bloat.
