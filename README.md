# Shared Browser

On-demand Chromium for remote bb.

- **Start shared:** `bb browser start --shared` — headed Chrome + interactive viewer for login.
- **Panel:** thread right-panel **+ → Open Browser**, or sidebar **Browser**.
- **Agents:** while running, `chrome-devtools-axi` attaches to the same profile via CDP.
- **Stop:** `bb browser stop` — frees resources; agents return to ephemeral headless.

Profile: `~/.bb-shared-browser/chrome-profile`

## Viewer address

By default the viewer is shared through BB Connect. To keep it on a private tailnet instead, serve the viewer port with Tailscale and set the address:

```sh
tailscale serve --bg --https=9225 http://127.0.0.1:9225
bb plugin config shared-browser set viewerUrl https://<machine>.<tailnet>.ts.net:9225
```

With `viewerUrl` set, the plugin does not expose the port through BB Connect.
