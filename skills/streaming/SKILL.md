---
name: streaming
description: In-flight video streaming server, byte-range HTTP request translation, and player synchronization for Torrently.
---

# Video Streaming Skill

This skill manages real-time media streaming while torrent pieces download in parallel.

## Core Concepts

1. **Byte-Range Server**: Exposes a local HTTP service that accepts HTML5 video byte-range requests: `Range: bytes=1048576-2097151`.
2. **Stream Pipe**: Connects WebTorrent file readable streams (`file.createReadStream({ start, end })`) directly to HTTP response objects.
3. **Seek Handling**: When the user jumps forward in the video player timeline, convert the new timestamp into byte offsets and request those piece indices from the torrent swarm immediately.

## Implementation Pattern

```js
// HTTP Byte-Range Handler Example
app.get('/stream/:infoHash/:fileIndex', (req, res) => {
  const torrent = client.get(req.params.infoHash);
  const file = torrent.files[req.params.fileIndex];
  
  const total = file.length;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': file.mime });
    return file.createReadStream().pipe(res);
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
  const chunkSize = (end - start) + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': file.mime
  });

  file.createReadStream({ start, end }).pipe(res);
});
```
