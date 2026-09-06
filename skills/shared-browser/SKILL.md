---
name: shared-browser
description: On-demand shared Chromium on the bb host for human login and agent control via chrome-devtools-axi. Use when the user must log in, approve OAuth, or click through a site the agent will continue using.
---

# Shared browser

Remote bb has no native Browser tab. This plugin provides an on-demand shared Chromium.

## When to use

- User must log in / pass MFA / click consent, then the agent continues.
- User asks to open the shared browser or "Open Browser".

## When not to use

- Agent-only page fetch with no human: use `chrome-devtools-axi` alone (ephemeral headless).
- Local HTML previews: prefer `bb connect expose` on a static/dev server.

## Commands

```bash
bb browser start --shared [url]   # headed + interactive viewer
bb browser start --headless [url] # persistent CDP profile, no viewer
bb browser open <url>             # shared start + navigate
bb browser status [--json]
bb browser url                    # viewer connect URL
bb browser stop                   # free resources; axi returns to ephemeral headless
```

Or tool `shared_browser` with `action=start|stop|status|open`.

## Agent flow

1. `bb browser start --shared` (or `open <url>`).
2. Give the user the `viewer:` URL as a markdown link so they can log in.
3. Wait for them to finish.
4. Drive the same session with `chrome-devtools-axi` (env sets `CHROME_DEVTOOLS_AXI_BROWSER_URL`).
5. `bb browser stop` when idle.

Cookies live in `~/.bb-shared-browser/chrome-profile` across restarts.
