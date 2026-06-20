# Pi Web UI

A web-based terminal UI for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. Connect to a running pi session through your browser.

![Pi Web UI 截图](https://raw.githubusercontent.com/Watercol/pi-web-ui/main/docs/Pi_Web_UI_example_01.png)

## Prerequisites

- **Node.js >= 20**
- **pi** — the pi coding agent must be installed separately:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

## Install

```bash
npm install -g @watercol/pi-web-ui
```

## Usage

```bash
pi-web-ui
```

Then open **http://127.0.0.1:3210** in your browser.

### Options

```
pi-web-ui [options]

Options:
  --host <host>       Host to bind, default 127.0.0.1
  --port <port>       Port to bind, default 3210
  --cwd <dir>         Working directory for pi --mode rpc, default .
  --pi-bin <path>     Pi executable, default PATH lookup for pi
  --provider <name>   Provider passed to pi
  --model <id>        Model passed to pi
```

### Examples

```bash
# Run on a different port, accessible from LAN
pi-web-ui --host 0.0.0.0 --port 8080

# Point to a custom pi binary
pi-web-ui --pi-bin /usr/local/bin/pi-dev

# Specify model and working directory
pi-web-ui --provider openai --model gpt-4o --cwd ~/my-project
```

## Development

```bash
cd pi-web-ui
npm install

# Build and run
npm run build
node dist/server/index.js

# Dev mode (auto-rebuild web on change requires separate Vite setup)
npm run dev

# Type-check without emitting
npm run typecheck

# Run tests
npm test
```

## License

MIT
