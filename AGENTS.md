# AGENTS.md - Torrently Agentic System Specification

Welcome to **Torrently**, a cross-platform desktop BitTorrent client designed from the ground up for seamless video streaming during active downloads.

This document guides AI agents and developer subagents working on this codebase. It establishes operational protocols, architecture conventions, domain concepts, and subagent workflows.

---

## 1. Core System Objectives

1. **Sequential & Prioritized Piece Downloading**: Unlike traditional swarm fetch algorithms, Torrently prioritizes video headers (MOOV atoms in MP4, EBML headers in MKV) and sequential window pieces so video streams begin playing within seconds.
2. **Built-in HTTP Streaming Server**: Exposes a local, secured byte-range HTTP server (e.g. `http://127.0.0.1:<port>`) that bridges the torrent engine piece buffer directly to HTML5 video elements and external media players (VLC, IINA).
3. **Cross-Platform Compatibility**: Fully compatible with macOS, Windows, and Linux using unified native desktop integration (Electron / Tauri wrapper).
4. **Modern Fluid UI/UX**: Dark-themed, glassmorphic UI with dynamic bandwidth charts, real-time peer swarms, media playback controls, and intuitive magnet link handling.

---

## 2. Directory & Documentation Map

Before modifying code, agents **MUST** inspect relevant project documentation:

- **`.ai/PROJECT.md`**: Project overview, vision, and core capabilities.
- **`.ai/ARCHITECTURE.md`**: System component topology, IPC protocols, and streaming pipeline.
- **`.ai/REQUIREMENTS.md`**: Functional requirements, OS target specs, and non-functional constraints.
- **`.ai/DECISIONS.md`**: Architectural Decision Records (ADRs) explaining tech stack and design choices.
- **`.ai/KNOWN_ISSUES.md`**: Ongoing bugs, codec caveats, and platform quirks.
- **`.ai/TEST_MATRIX.md`**: Cross-platform verification procedures and mock torrent swarm tests.
- **`.ai/SECURITY.md`**: Local server security boundaries, magnet link validation, and peer sandboxing.
- **`.ai/ROADMAP.md`**: Planned milestones and feature trajectories.

---

## 3. Skill System Guidelines

Agents working on specific components should consult the domain skills located in `skills/`:

- **`skills/torrent-engine/SKILL.md`**: WebTorrent integration, peer protocol, piece selection strategies, swarm management.
- **`skills/streaming/SKILL.md`**: Sequential piece fetching, HTTP range request handler, media player state management.
- **`skills/cross-platform/SKILL.md`**: macOS/Windows/Linux packaging, deep linking (`magnet://`), desktop notifications.
- **`skills/ui-ux/SKILL.md`**: Modern dark glassmorphism styling, CSS architecture, interactive audio/video UI, dynamic micro-interactions.
- **`skills/downloads/SKILL.md`**: File selection, storage management, download speed throttling, disk space pre-allocation.
- **`skills/debugging/SKILL.md`**: Diagnosing piece corruption, stream buffer underruns, peer connection timeouts.
- **`skills/testing/SKILL.md`**: Unit tests, integration tests, mock torrent swarm generation.

---

## 4. Agent Operating Rules

1. **Read Before Writing**: Inspect existing `.ai/` and `skills/` files before making structural modifications.
2. **Never Break Audio/Video Streaming**: Sequential piece selection algorithm priority must never be overridden by standard random rarest-first selection when streaming mode is active.
3. **Keep Local Ports Secured**: Local HTTP streaming server must bind ONLY to `127.0.0.1` or `::1` with session tokens to prevent unauthorized local process access.
4. **Aesthetics & Performance**: Ensure UI renders at 60 FPS. Keep visual components modular and refrain from monolithic UI scripts.
5. **Update `.ai/KNOWN_ISSUES.md` & `DECISIONS.md`**: Log any newly identified platform bugs or non-trivial architectural decisions.
