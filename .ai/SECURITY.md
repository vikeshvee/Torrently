# Security Architecture & Constraints - Torrently

---

## 1. Local HTTP Stream Server Security

- **Host Binding**: The HTTP streaming server MUST bind strictly to `127.0.0.1` (or `::1`). It must NEVER listen on `0.0.0.0` or public interface IP addresses.
- **Session Tokens**: Every stream session generates a cryptographically secure 128-bit random token:
  `http://127.0.0.1:<port>/stream/<infohash>/<fileIndex>?token=<session_token>`
  Requests lacking a valid token are rejected with HTTP 403 Forbidden to prevent unauthorized local processes from reading torrent contents.

## 2. Input Sanitization & Magnet Handling

- **InfoHash Validation**: All incoming infohashes must strictly match hex regex (`^[a-fA-F0-9]{40}$`) or base32 regex to prevent path traversal or command injection.
- **File System Path Escaping**: Download destinations are validated against system path traversal (`../`) attacks.

## 3. Desktop Sandbox & Process Isolation

- Context isolation enabled in Electron renderer (`contextIsolation: true`).
- Preload scripts expose strictly typed, safe IPC methods (`window.torrentlyAPI`).
