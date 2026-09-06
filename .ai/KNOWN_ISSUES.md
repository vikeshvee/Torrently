# Known Issues & Workarounds - Torrently

---

## 1. Video Container & Codec Limitations

- **Symptom**: Certain `.mkv` files using AC3/DTS audio codecs do not output audio in standard HTML5 video elements.
- **Cause**: Browser renderers (Chromium/Webkit) do not natively support proprietary AC3/DTS audio decoding.
- **Workaround / Solution**:
  - Integrate WebAssembly-based audio transcoders (ffmpeg.wasm) or provide an "Open in External Player" button (VLC / IINA) which native decodes all formats.

## 2. MP4 MOOV Atom at End of File

- **Symptom**: MP4 video file stalls indefinitely before starting playback.
- **Cause**: Non-web-optimized MP4 files place the `moov` index metadata atom at the very end of the file instead of the beginning.
- **Workaround / Solution**:
  - Torrently piece engine prioritizes fetching both the first 2MB and the last 2MB of an MP4 file immediately upon user clicking "Stream".

## 3. High CPU Usage during Peer Wire Handshakes

- **Symptom**: Temporary CPU usage spikes when connecting to 100+ peers simultaneously.
- **Workaround / Solution**:
  - Enforce max connections per torrent default cap (e.g. 55 peers) and enable socket pooling.
