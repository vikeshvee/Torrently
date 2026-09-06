---
name: torrent-engine
description: BitTorrent engine management, peer discovery, piece selection algorithms, and swarm optimization for Torrently.
---

# Torrent Engine Skill

This skill governs the core P2P networking and piece management of Torrently.

## Key Responsibilities

1. **Swarm Management**: Connecting to DHT (Distributed Hash Table), PEX (Peer Exchange), and HTTP/UDP trackers.
2. **Piece Selection Strategy**:
   - Switching between *rarest-first* mode for passive downloads and *sequential sliding window* mode for active video streams.
   - Priority piece ordering: Header pieces (0..3) -> Seek target pieces -> Sequential buffer (N..N+15).
3. **Peer Connections**: Socket throttling, choke/unchoke logic, and bandwidth allocation.

## Usage Code Pattern

```js
// Engine piece priority initialization for streaming
function setStreamPriority(torrent, file, currentBytePosition) {
  const pieceLength = torrent.pieceLength;
  const startPiece = Math.floor((file.offset + currentBytePosition) / pieceLength);
  const endPiece = Math.min(
    torrent.pieces.length - 1,
    startPiece + 20 // Buffer 20 pieces ahead
  );

  // High priority for current playback position
  for (let i = startPiece; i <= endPiece; i++) {
    torrent.select(i, i, 10); // Priority level 10
  }
}
```
