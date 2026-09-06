---
name: cross-platform
description: Native OS integration, protocol registration (magnet links), and build packaging across macOS, Windows, and Linux.
---

# Cross-Platform Desktop Skill

This skill details native operating system integration and binary packaging for Torrently.

## Protocol Handler Registration (`magnet://`)

- **macOS**: Register `CFBundleURLTypes` in Info.plist for scheme `magnet`.
- **Windows**: Register registry keys under `HKCU\Software\Classes\magnet`.
- **Linux**: Desktop entry file with `MimeType=x-scheme-handler/magnet;`.

## Packaging Strategies

- **macOS**: `electron-builder` targeting DMG, ZIP (universal binary with `x86_64` and `arm64` slice).
- **Windows**: `electron-builder` NSIS installer + portable `.exe`.
- **Linux**: AppImage for standalone execution + `.deb` / `.rpm` for distribution.
