# Test Matrix Specification - Torrently

---

## 1. Automated Test Suite

| Test Suite | Coverage Area | Framework / Tool | Command |
|---|---|---|---|
| Engine Unit Tests | Magnet parsing, infohash extraction, speed math | Jest / Vitest / Node test | `npm test` |
| Streaming Server Tests | Range header byte offset parsing, HTTP 206 Partial Content | Supertest / Node HTTP assert | `npm run test:stream` |
| UI Component Tests | DOM rendering, progress bar calculations | Testing Library / JS DOM | `npm run test:ui` |

---

## 2. Manual Cross-Platform Verification Matrix

| OS Platform | Build Target | Test Scenarios | Expected Result |
|---|---|---|---|
| **macOS 14 (Sonoma)** | Apple Silicon / Intel | Magnet launch, stream MP4 video, system dark mode | Seamless video play < 3s, window controls native |
| **Windows 11** | x64 Setup | Magnet protocol registration, streaming seeking | Protocol association prompts, smooth timeline seek |
| **Ubuntu 24.04 LTS** | AppImage / deb | Video playback via internal player & VLC launcher | Correct HTTP stream piping, low CPU rendering |
