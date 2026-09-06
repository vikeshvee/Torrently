---
name: debugging
description: Swarm diagnostic logging, network socket troubleshooting, stream buffer underrun resolution, and media decoding analysis.
---

# Debugging Skill

This skill provides step-by-step diagnostic workflows for Torrently developers and agents.

## Common Diagnostic Recipes

### 1. Video Stalls on Buffering
- **Check 1**: Inspect active peer piece availability in the piece map visualizer.
- **Check 2**: Verify MOOV atom has been fetched. Ensure pieces `0..2` and `(total-2)..total` show green (downloaded).
- **Check 3**: Look for HTTP range request errors in DevTools Console (`Failed to load resource: net::ERR_CONTENT_LENGTH_MISMATCH`).

### 2. Zero Peers Connected
- **Check 1**: Inspect tracker response logs for `Connection Refused` or `UDP Tracker Timeout`.
- **Check 2**: Test DHT node connectivity (`dht.nodes.length > 0`).
- **Check 3**: Verify firewall settings for local P2P listening port.
