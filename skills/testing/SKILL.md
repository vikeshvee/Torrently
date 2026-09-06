---
name: testing
description: Automated and manual test procedures, mock swarm generation, and stream verification for Torrently.
---

# Testing Skill

This skill details how to test Torrently's torrent engine, streaming server, and UI components.

## Mock Torrent Swarm Testing

To test streaming without depending on external public tracker availability:

```js
// Create in-memory mock seed torrent for automated testing
const WebTorrent = require('webtorrent');
const fs = require('fs');

async function setupMockSwarm(dummyVideoPath) {
  const seeder = new WebTorrent({ dht: false });
  const leecher = new WebTorrent({ dht: false });

  return new Promise((resolve) => {
    seeder.seed(dummyVideoPath, (torrent) => {
      // Connect leecher directly to seeder
      leecher.add(torrent.magnetURI, (streamTorrent) => {
        resolve({ seeder, leecher, torrent: streamTorrent });
      });
    });
  });
}
```
