# Subito sfz

A low-friction tool for creating SFZ instruments: record samples from your mic,
trim/select the useful part, and write out `.sfz` + audio files to disk.

## Architecture

- **`app/`** — Electron + React (TypeScript) desktop shell. Handles the UI,
  mic capture, and local disk I/O.
- **`server/`** — A Rust sidecar (Axum) that Electron spawns as a child
  process on startup. It binds to an OS-assigned local port, prints
  `SUBITOSFZ_SERVER_PORT=<port>` to stdout so the Electron main process knows
  where to send requests, and does the heavier audio processing work. It has
  no knowledge of Electron and can be run/tested standalone.

Electron's main process and the Rust server talk over plain local HTTP
(`127.0.0.1:<port>`); the renderer never talks to the sidecar directly — it
goes through a `window.api` bridge exposed by the preload script via IPC.

## Development

Requires Node 20+ and Rust (stable) installed.

```bash
# build the sidecar once (rebuild after any Rust changes)
cd server && cargo build

# in another terminal, run the Electron app in dev mode
cd app && npm install && npm run dev
```
