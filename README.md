# TiltShift

A VS Code extension for managing [Tilt](https://tilt.dev/) from within the editor — with first-class support for VS Code Remote environments (SSH, Dev Containers, WSL). View resource status in the sidebar, start/stop Tilt from the command palette, and have endpoint links automatically forwarded to your local machine.

> **Prototype notice:** This extension was generated with [Claude Code](https://claude.ai/claude-code) using the **Claude Sonnet 4.6** model. It is experimental and not officially supported by the Tilt project.

---

## Features

- **Resource tree view** — live sidebar panel showing all Tilt resources with build and runtime status icons
- **Status bar** — at-a-glance Tilt health summary; click to open the Tilt UI
- **WebSocket connection** — connects to Tilt's `/ws/view` endpoint for real-time incremental updates
- **Auto port-forwarding** — endpoint links for healthy resources are forwarded immediately via VS Code's port-forwarding mechanism, without needing to expand the tree
- **Start / Stop / Restart Tilt** — launch `tilt up` in a dedicated terminal from the command palette or sidebar toolbar
- **Connect to existing Tilt** — attach to an already-running Tilt instance
- **Remote-first** — designed to work in VS Code Remote sessions; all port resolution uses `vscode.env.asExternalUri`

---

## Requirements

- [Tilt](https://docs.tilt.dev/install.html) installed and accessible on the `PATH` of the remote machine (or local machine for local workspaces)
- VS Code 1.85 or later

---

## Installation

### From a GitHub Release (recommended)

1. Go to the [Releases page](../../releases) and download the `.vsix` file from the latest release
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Extensions: Install from VSIX…**
3. Select the downloaded `.vsix` file

Alternatively, install from the terminal:

```bash
code --install-extension tiltshift-<version>.vsix
```

### Building from source

```bash
git clone <this-repo>
cd tiltshift
npm install
npm run bundle
npx vsce package
code --install-extension tiltshift-*.vsix
```

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `tiltshift.tiltPort` | `10350` | Port that the Tilt API listens on |
| `tiltshift.tiltfilePath` | `""` | Path to Tiltfile relative to workspace root (empty = use `Tiltfile` in root) |
| `tiltshift.autoConnect` | `true` | Automatically connect to a running Tilt instance on workspace open |
| `tiltshift.autoForwardUI` | `true` | Automatically forward the Tilt UI port when connected |
| `tiltshift.autoForwardStatuses` | `["ok", "pending"]` | Runtime statuses for which endpoint links are automatically port-forwarded |
| `tiltshift.pollInterval` | `2000` | Polling interval in ms (used as reconnect delay) |
| `tiltshift.tiltArgs` | `[]` | Additional arguments passed to `tilt up` |

---

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P`) under the **TiltShift** category:

| Command | Description |
|---|---|
| TiltShift: Start Tilt | Launch `tilt up` in a dedicated terminal |
| TiltShift: Stop Tilt | Send Ctrl-C to the Tilt terminal |
| TiltShift: Restart Tilt | Stop then restart Tilt |
| TiltShift: Connect to Running Tilt | Attach to an already-running Tilt instance |
| TiltShift: Open Tilt UI | Open the Tilt web UI in a browser |
| TiltShift: Refresh | Refresh the resource tree and reconnect if needed |

---

## Development

```bash
npm install       # install dependencies
npm run build     # development build with source maps
npm run watch     # rebuild on file changes
npm run typecheck # TypeScript type checking
npm run bundle    # production minified build (used for packaging)
npm run package   # create .vsix package
```

Press `F5` in VS Code to launch the Extension Development Host.

---

## How it works

1. On activation, TiltShift attempts to connect to Tilt by fetching a CSRF token from `http://localhost:{port}/api/websocket_token`
2. It then opens a WebSocket to `ws://localhost:{port}/ws/view?csrf={token}`
3. Each incoming frame is a partial update containing only changed resources; TiltShift merges these into its resource store
4. Resources with both `runtimeStatus` and `updateStatus` set to `none` are removed from the store
5. Endpoint links for resources whose `runtimeStatus` is in `autoForwardStatuses` are proactively forwarded via `vscode.env.asExternalUri`
