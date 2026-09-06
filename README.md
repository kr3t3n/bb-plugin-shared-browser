# Shared Browser

On-demand Chromium for remote bb.

- **Start shared:** `bb browser start --shared` — headed Chrome + interactive viewer for login.
- **Panel:** thread right-panel **+ → Open Browser**, or sidebar **Browser**.
- **Agents:** while running, `chrome-devtools-axi` attaches to the same profile via CDP.
- **Stop:** `bb browser stop` — frees resources; agents return to ephemeral headless.

Profile: `~/.bb-shared-browser/chrome-profile`
