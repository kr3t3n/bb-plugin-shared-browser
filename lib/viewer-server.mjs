#!/usr/bin/env node
/**
 * Interactive CDP screencast viewer for the shared browser.
 * Serves HTTP UI on VIEWER_PORT and relays mouse/keyboard/paste to Chrome via CDP.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const CDP_PORT = Number(process.env.SHARED_BROWSER_CDP_PORT || 9222);
const VIEWER_PORT = Number(process.env.SHARED_BROWSER_VIEWER_PORT || 9225);

/** Windows virtual-key codes for non-printables CDP needs to delete/navigate. */
const WIN_KEY = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<meta name="mobile-web-app-capable" content="yes"/>
<title>Shared Browser</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0b0b0c; color: #e8e8ea; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; touch-action: none; }
  #bar { display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #161618; border-bottom: 1px solid #2a2a2e; flex-wrap: wrap; }
  #bar input { flex: 1; min-width: 0; background: #0b0b0c; color: inherit; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; font-size: 16px; }
  #bar button { background: #2a2a2e; color: inherit; border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
  #bar button:hover { background: #3a3a40; }
  #status { font-size: 12px; color: #9a9aa3; white-space: nowrap; }
  #wrap { position: relative; height: calc(100% - 49px); overflow: auto; background: #111; display: flex; justify-content: center; align-items: flex-start; }
  #stage { position: relative; display: inline-block; max-width: 100%; line-height: 0; }
  #frame { display: block; max-width: 100%; height: auto; cursor: default; background: #000; pointer-events: none; user-select: none; -webkit-user-select: none; }
  /* Transparent capture surface: receives focus so mobile IME opens, and owns pointer/keys. */
  #capture {
    position: absolute; inset: 0; width: 100%; height: 100%;
    margin: 0; padding: 0; border: 0; resize: none; outline: none;
    opacity: 0.01; color: transparent; caret-color: transparent;
    background: transparent; cursor: default;
    font-size: 16px; /* iOS: avoid zoom on focus */
    z-index: 2;
  }
  #hint { position: absolute; inset: 0; display: grid; place-items: center; color: #9a9aa3; pointer-events: none; z-index: 1; }
  #mobileHint {
    display: none; width: 100%; padding: 6px 10px; font-size: 12px; color: #9a9aa3;
    background: #121214; border-top: 1px solid #2a2a2e;
  }
  @media (pointer: coarse) {
    #mobileHint { display: block; }
  }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" type="button" title="Back">←</button>
    <button id="fwd" type="button" title="Forward">→</button>
    <button id="reload" type="button" title="Reload">↻</button>
    <input id="url" type="url" inputmode="url" enterkeyhint="go" placeholder="https://" spellcheck="false" autocomplete="off"/>
    <button id="go" type="button">Go</button>
    <span id="status">connecting…</span>
  </div>
  <div id="mobileHint">Tap the page to type. Paste works from the system keyboard.</div>
  <div id="wrap">
    <div id="stage">
      <img id="frame" alt="browser screencast" draggable="false"/>
      <textarea id="capture" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Type into the remote browser"></textarea>
      <div id="hint">Waiting for frames…</div>
    </div>
  </div>
<script>
(() => {
  const frame = document.getElementById('frame');
  const capture = document.getElementById('capture');
  const hint = document.getElementById('hint');
  const status = document.getElementById('status');
  const urlInput = document.getElementById('url');
  let meta = { offsetTop: 0, offsetLeft: 0, pageScaleFactor: 1, deviceWidth: 1440, deviceHeight: 900 };
  let cssW = 1440, cssH = 900;

  const WIN_KEY = ${JSON.stringify(WIN_KEY)};

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.binaryType = 'arraybuffer';

  function setStatus(t) { status.textContent = t; }

  ws.onopen = () => setStatus('connected');
  ws.onclose = () => setStatus('disconnected');
  ws.onerror = () => setStatus('error');
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'meta') {
        meta = Object.assign(meta, msg);
        cssW = msg.deviceWidth || cssW;
        cssH = msg.deviceHeight || cssH;
        if (msg.url) urlInput.value = msg.url;
        return;
      }
      if (msg.type === 'url' && msg.url) {
        urlInput.value = msg.url;
        return;
      }
      if (msg.type === 'error') {
        setStatus(msg.message || 'error');
        return;
      }
      return;
    }
    const blob = new Blob([ev.data], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    frame.onload = () => URL.revokeObjectURL(url);
    frame.src = url;
    hint.style.display = 'none';
  };

  function send(obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function focusCapture() {
    try { capture.focus({ preventScroll: true }); } catch { capture.focus(); }
  }

  function toCssPoint(clientX, clientY) {
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const x = ((clientX - rect.left) / rect.width) * cssW;
    const y = ((clientY - rect.top) / rect.height) * cssH;
    return {
      x: Math.max(0, Math.min(cssW, x)),
      y: Math.max(0, Math.min(cssH, y)),
    };
  }

  function modifiersOf(ev) {
    return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
  }

  function isUrlFocused() {
    return document.activeElement === urlInput;
  }

  function sendKey(ev, event) {
    if (isUrlFocused()) return;
    const key = ev.key;
    const code = ev.code;
    const win = WIN_KEY[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
    const printable = key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    // Never let the viewer page handle Backspace/Delete/arrows (history / scroll).
    if (key === 'Backspace' || key === 'Delete' || key.startsWith('Arrow') || key === 'Tab' || key === 'Enter' || key === 'Escape' || printable || ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
    }
    send({
      type: 'key',
      event,
      key,
      code,
      text: printable ? key : undefined,
      windowsVirtualKeyCode: win,
      nativeVirtualKeyCode: win,
      modifiers: modifiersOf(ev),
    });
  }

  // Pointer → mouse (works for mouse + touch + pen)
  capture.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    focusCapture();
    capture.setPointerCapture?.(ev.pointerId);
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    const button = ev.button === 2 ? 2 : ev.button === 1 ? 1 : 0;
    send({ type: 'mouse', event: 'down', x, y, button });
  });
  capture.addEventListener('pointerup', (ev) => {
    ev.preventDefault();
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    const button = ev.button === 2 ? 2 : ev.button === 1 ? 1 : 0;
    send({ type: 'mouse', event: 'up', x, y, button });
    focusCapture();
  });
  capture.addEventListener('pointermove', (ev) => {
    if (ev.buttons === 0 && ev.pointerType === 'mouse') {
      const { x, y } = toCssPoint(ev.clientX, ev.clientY);
      send({ type: 'mouse', event: 'move', x, y, button: 0 });
      return;
    }
    if (ev.buttons === 0) return;
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    send({ type: 'mouse', event: 'move', x, y, button: 0 });
  });
  capture.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    send({ type: 'wheel', x, y, deltaX: ev.deltaX, deltaY: ev.deltaY });
  }, { passive: false });
  capture.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // Physical / soft keyboard special keys
  window.addEventListener('keydown', (ev) => {
    if (isUrlFocused()) return;
    // Let IME composition finish without injecting premature keys.
    if (ev.isComposing || ev.keyCode === 229) return;
    sendKey(ev, 'down');
  }, true);
  window.addEventListener('keyup', (ev) => {
    if (isUrlFocused()) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    sendKey(ev, 'up');
  }, true);

  // Mobile IME / autocomplete insert characters via input events.
  capture.addEventListener('beforeinput', (ev) => {
    if (isUrlFocused()) return;
    if (ev.inputType === 'insertText' && ev.data) {
      ev.preventDefault();
      send({ type: 'insertText', text: ev.data });
      capture.value = '';
      return;
    }
    if (ev.inputType === 'insertCompositionText' && ev.data) {
      // Final composition often also fires insertText; skip mid-composition churn.
      return;
    }
    if (ev.inputType === 'insertFromPaste' && ev.data) {
      ev.preventDefault();
      send({ type: 'insertText', text: ev.data });
      capture.value = '';
      return;
    }
    if (ev.inputType === 'deleteContentBackward') {
      ev.preventDefault();
      send({
        type: 'key',
        event: 'down',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        modifiers: 0,
      });
      send({
        type: 'key',
        event: 'up',
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        modifiers: 0,
      });
      capture.value = '';
      return;
    }
    if (ev.inputType === 'deleteContentForward') {
      ev.preventDefault();
      send({
        type: 'key',
        event: 'down',
        key: 'Delete',
        code: 'Delete',
        windowsVirtualKeyCode: 46,
        nativeVirtualKeyCode: 46,
        modifiers: 0,
      });
      send({
        type: 'key',
        event: 'up',
        key: 'Delete',
        code: 'Delete',
        windowsVirtualKeyCode: 46,
        nativeVirtualKeyCode: 46,
        modifiers: 0,
      });
      capture.value = '';
    }
  });

  capture.addEventListener('compositionend', (ev) => {
    if (!ev.data) return;
    send({ type: 'insertText', text: ev.data });
    capture.value = '';
  });

  // Explicit paste (desktop Cmd/Ctrl+V and long-press paste on mobile).
  capture.addEventListener('paste', (ev) => {
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') || '';
    if (text) send({ type: 'insertText', text });
    capture.value = '';
  });

  // Keep capture empty so it never accumulates local text.
  capture.addEventListener('input', () => {
    if (capture.value) {
      // Fallback for browsers that skip beforeinput.
      send({ type: 'insertText', text: capture.value });
      capture.value = '';
    }
  });

  function go() {
    const u = urlInput.value.trim();
    if (!u) return;
    send({ type: 'navigate', url: u });
    focusCapture();
  }
  document.getElementById('go').onclick = go;
  urlInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go();
    }
  });
  document.getElementById('back').onclick = () => send({ type: 'back' });
  document.getElementById('fwd').onclick = () => send({ type: 'forward' });
  document.getElementById('reload').onclick = () => send({ type: 'reload' });

  // First tap anywhere in the stage focuses typing.
  document.getElementById('stage').addEventListener('click', () => focusCapture());
})();
</script>
</body>
</html>`;

async function getWsDebuggerUrl() {
  const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(
    (r) => r.json(),
  );
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) =>
    r.json(),
  );
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return page?.webSocketDebuggerUrl || version.webSocketDebuggerUrl;
}

function createCdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = new Map();

  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const handlers = events.get(msg.method) || [];
      for (const h of handlers) h(msg.params || {});
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  return {
    ready,
    on(method, handler) {
      if (!events.has(method)) events.set(method, []);
      events.get(method).push(handler);
    },
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

let cdp = null;
let screencastStarted = false;

async function ensureCdp() {
  if (cdp) return cdp;
  const wsUrl = await getWsDebuggerUrl();
  if (!wsUrl) throw new Error("No CDP websocket");
  cdp = createCdpSession(wsUrl);
  await cdp.ready;
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Input.setIgnoreInputEvents", { ignore: false }).catch(
    () => undefined,
  );
  return cdp;
}

async function startScreencast(broadcastMeta, broadcastFrame) {
  const session = await ensureCdp();
  session.on("Page.screencastFrame", async (params) => {
    try {
      await session.call("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch {
      /* ignore */
    }
    if (params.metadata) broadcastMeta(params.metadata);
    if (params.data) broadcastFrame(Buffer.from(params.data, "base64"));
  });
  session.on("Page.frameNavigated", async () => {
    try {
      const { result } = await session.call("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      const url = result?.result?.value;
      if (typeof url === "string") broadcastMeta({ url });
    } catch {
      /* ignore */
    }
  });
  if (!screencastStarted) {
    await session.call("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1440,
      maxHeight: 900,
      everyNthFrame: 1,
    });
    screencastStarted = true;
  }
  return session;
}

const clients = new Set();

function broadcastJson(obj) {
  const raw = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(raw);
  }
}

function broadcastFrame(buf) {
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(buf);
  }
}

async function dispatchKey(session, msg) {
  const win =
    typeof msg.windowsVirtualKeyCode === "number"
      ? msg.windowsVirtualKeyCode
      : WIN_KEY[msg.key];
  const isUp = msg.event === "up";
  const hasText = Boolean(msg.text);

  if (isUp) {
    await session.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: msg.key,
      code: msg.code,
      windowsVirtualKeyCode: win,
      nativeVirtualKeyCode: win,
      modifiers: msg.modifiers || 0,
    });
    return;
  }

  // Printable: keyDown with text, then keyUp (client also sends keyup; extra is harmless).
  if (hasText) {
    await session.call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: msg.key,
      code: msg.code,
      text: msg.text,
      unmodifiedText: msg.text,
      windowsVirtualKeyCode: win,
      nativeVirtualKeyCode: win,
      modifiers: msg.modifiers || 0,
    });
    await session.call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: msg.key,
      code: msg.code,
      windowsVirtualKeyCode: win,
      nativeVirtualKeyCode: win,
      modifiers: msg.modifiers || 0,
    });
    return;
  }

  // Special keys (Backspace/Delete/Enter/arrows): rawKeyDown + keyUp.
  await session.call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: msg.key,
    code: msg.code,
    windowsVirtualKeyCode: win,
    nativeVirtualKeyCode: win,
    modifiers: msg.modifiers || 0,
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(HTML);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (client) => {
  clients.add(client);
  client.on("close", () => clients.delete(client));

  try {
    const session = await startScreencast(
      (meta) => {
        broadcastJson({ type: "meta", ...meta });
        if (meta.url) broadcastJson({ type: "url", url: meta.url });
      },
      broadcastFrame,
    );

    client.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (msg.type === "mouse") {
          const button =
            msg.button === 2 ? "right" : msg.button === 1 ? "middle" : "left";
          if (msg.event === "move") {
            await session.call("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: msg.x,
              y: msg.y,
            });
          } else if (msg.event === "down") {
            await session.call("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: msg.x,
              y: msg.y,
              button,
              clickCount: 1,
            });
          } else if (msg.event === "up") {
            await session.call("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: msg.x,
              y: msg.y,
              button,
              clickCount: 1,
            });
          }
        } else if (msg.type === "wheel") {
          await session.call("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: msg.x,
            y: msg.y,
            deltaX: msg.deltaX,
            deltaY: msg.deltaY,
          });
        } else if (msg.type === "key") {
          await dispatchKey(session, msg);
        } else if (msg.type === "insertText" && typeof msg.text === "string") {
          // Paste + mobile IME: insert as text without needing key codes.
          await session.call("Input.insertText", { text: msg.text });
        } else if (msg.type === "navigate" && msg.url) {
          let url = String(msg.url).trim();
          if (!/^https?:\/\//i.test(url) && !url.startsWith("about:")) {
            url = "https://" + url;
          }
          await session.call("Page.navigate", { url });
        } else if (msg.type === "back") {
          await session.call("Runtime.evaluate", {
            expression: "history.back()",
          });
        } else if (msg.type === "forward") {
          await session.call("Runtime.evaluate", {
            expression: "history.forward()",
          });
        } else if (msg.type === "reload") {
          await session.call("Page.reload");
        }
      } catch (err) {
        client.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });
  } catch (err) {
    client.send(
      JSON.stringify({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
});

server.listen(VIEWER_PORT, "127.0.0.1", () => {
  console.log(`shared-browser viewer on http://127.0.0.1:${VIEWER_PORT}`);
});
