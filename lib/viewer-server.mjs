#!/usr/bin/env node
/**
 * Interactive CDP screencast viewer for the shared browser.
 * Serves HTTP UI on VIEWER_PORT and relays mouse/keyboard/paste to Chrome via CDP.
 *
 * Typing model:
 * - Printable characters ($ # @ etc.) → Input.insertText (never Shift+keyDown;
 *   Shift+keyDown selects text in remote inputs).
 * - Paste → read the *local* clipboard, then Input.insertText (never forward
 *   Ctrl/Cmd+V to remote Chrome — its clipboard is empty).
 * - Backspace/Delete/Enter/Tab/arrows → Input.dispatchKeyEvent with virtual keys.
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const CDP_PORT = Number(process.env.SHARED_BROWSER_CDP_PORT || 9222);
const VIEWER_PORT = Number(process.env.SHARED_BROWSER_VIEWER_PORT || 9225);

/** Windows virtual-key codes for non-printables. */
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
  #tip { width: 100%; padding: 6px 10px; font-size: 12px; color: #9a9aa3; background: #121214; border-bottom: 1px solid #2a2a2e; }
  #wrap { position: relative; height: calc(100% - 78px); overflow: auto; background: #111; display: flex; justify-content: center; align-items: flex-start; }
  #stage { position: relative; display: inline-block; max-width: 100%; line-height: 0; }
  #frame { display: block; max-width: 100%; height: auto; cursor: default; background: #000; pointer-events: none; user-select: none; -webkit-user-select: none; }
  #capture {
    position: absolute; inset: 0; width: 100%; height: 100%;
    margin: 0; padding: 0; border: 0; resize: none; outline: none;
    opacity: 0.01; color: transparent; caret-color: transparent;
    background: transparent; cursor: default;
    font-size: 16px;
    z-index: 2;
  }
  #hint { position: absolute; inset: 0; display: grid; place-items: center; color: #9a9aa3; pointer-events: none; z-index: 1; }
</style>
</head>
<body>
  <div id="bar">
    <button id="back" type="button" title="Back">←</button>
    <button id="fwd" type="button" title="Forward">→</button>
    <button id="reload" type="button" title="Reload">↻</button>
    <input id="url" type="text" inputmode="url" enterkeyhint="go" placeholder="https://" spellcheck="false" autocomplete="off"/>
    <button id="go" type="button">Go</button>
    <button id="paste" type="button" title="Paste from your clipboard into the page">Paste</button>
    <span id="status">connecting…</span>
  </div>
  <div id="tip">Tap the page to type. Use Paste (or Ctrl/Cmd+V) for clipboard — remote Chrome cannot see your local clipboard by itself.</div>
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
  let cssW = 1440, cssH = 900;

  const SPECIAL = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, Space: 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
  };

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

  function isUrlFocused() {
    return document.activeElement === urlInput;
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

  function insertText(text) {
    if (!text) return;
    send({ type: 'insertText', text });
  }

  function sendSpecial(key, code, modifiers, phase) {
    const win = SPECIAL[key];
    send({
      type: 'key',
      event: phase,
      key,
      code: code || key,
      windowsVirtualKeyCode: win,
      nativeVirtualKeyCode: win,
      modifiers: modifiers || 0,
    });
  }

  async function pasteLocal() {
    focusCapture();
    // 1) Async clipboard API (HTTPS + permission)
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          insertText(text);
          setStatus('pasted');
          return;
        }
      }
    } catch (_) { /* fall through */ }

    // 2) execCommand fallback via hidden capture
    try {
      capture.value = '';
      focusCapture();
      const ok = document.execCommand && document.execCommand('paste');
      if (ok && capture.value) {
        insertText(capture.value);
        capture.value = '';
        setStatus('pasted');
        return;
      }
    } catch (_) { /* fall through */ }

    setStatus('paste blocked — allow clipboard, or long-press Paste');
  }

  // Pointer → mouse
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
    if (ev.buttons === 0 && ev.pointerType !== 'mouse') return;
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    send({ type: 'mouse', event: 'move', x, y, button: 0 });
  });
  capture.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const { x, y } = toCssPoint(ev.clientX, ev.clientY);
    send({ type: 'wheel', x, y, deltaX: ev.deltaX, deltaY: ev.deltaY });
  }, { passive: false });
  capture.addEventListener('contextmenu', (ev) => ev.preventDefault());

  window.addEventListener('keydown', (ev) => {
    if (isUrlFocused()) return;
    if (ev.isComposing || ev.keyCode === 229) return;

    const mod = modifiersOf(ev);
    const key = ev.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    // Local paste — never forward Ctrl/Cmd+V to remote Chrome.
    if ((ev.ctrlKey || ev.metaKey) && lower === 'v') {
      ev.preventDefault();
      ev.stopPropagation();
      void pasteLocal();
      return;
    }

    // Useful editing shortcuts still go to remote (select-all / copy / cut / undo).
    if ((ev.ctrlKey || ev.metaKey) && ['a', 'c', 'x', 'z', 'y'].includes(lower)) {
      ev.preventDefault();
      sendSpecial(key.length === 1 ? key.toUpperCase() : key, 'Key' + lower.toUpperCase(), mod, 'down');
      return;
    }

    // Printable character including $ # @ ! etc. — insertText only.
    // Never send Shift+keyDown: Shift makes remote inputs select instead of type.
    if (key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      insertText(key);
      return;
    }

    if (key in SPECIAL) {
      ev.preventDefault();
      sendSpecial(key, ev.code, mod, 'down');
      return;
    }
  }, true);

  window.addEventListener('keyup', (ev) => {
    if (isUrlFocused()) return;
    if (ev.isComposing || ev.keyCode === 229) return;
    const key = ev.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if ((ev.ctrlKey || ev.metaKey) && lower === 'v') {
      ev.preventDefault();
      return;
    }
    // Printables already handled via insertText — no keyUp needed.
    if (key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      return;
    }
    if (key in SPECIAL) {
      ev.preventDefault();
      sendSpecial(key, ev.code, modifiersOf(ev), 'up');
    }
    if ((ev.ctrlKey || ev.metaKey) && ['a', 'c', 'x', 'z', 'y'].includes(lower)) {
      ev.preventDefault();
      sendSpecial(key.length === 1 ? key.toUpperCase() : key, 'Key' + lower.toUpperCase(), modifiersOf(ev), 'up');
    }
  }, true);

  // Mobile IME / beforeinput path (also catches some paste variants).
  capture.addEventListener('beforeinput', (ev) => {
    if (isUrlFocused()) return;
    if (ev.inputType === 'insertText' && ev.data) {
      ev.preventDefault();
      insertText(ev.data);
      capture.value = '';
      return;
    }
    if (ev.inputType === 'insertFromPaste') {
      ev.preventDefault();
      const text = ev.data || '';
      if (text) insertText(text);
      else void pasteLocal();
      capture.value = '';
      return;
    }
    if (ev.inputType === 'insertCompositionText') return;
    if (ev.inputType === 'deleteContentBackward') {
      ev.preventDefault();
      sendSpecial('Backspace', 'Backspace', 0, 'down');
      sendSpecial('Backspace', 'Backspace', 0, 'up');
      capture.value = '';
      return;
    }
    if (ev.inputType === 'deleteContentForward') {
      ev.preventDefault();
      sendSpecial('Delete', 'Delete', 0, 'down');
      sendSpecial('Delete', 'Delete', 0, 'up');
      capture.value = '';
    }
  });

  capture.addEventListener('compositionend', (ev) => {
    if (!ev.data) return;
    insertText(ev.data);
    capture.value = '';
  });

  // Native paste event (right-click / long-press Paste) — has clipboardData.
  capture.addEventListener('paste', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const text = ev.clipboardData?.getData('text/plain') || '';
    if (text) {
      insertText(text);
      setStatus('pasted');
    } else {
      void pasteLocal();
    }
    capture.value = '';
  });

  // Also catch paste on document when capture is focused.
  document.addEventListener('paste', (ev) => {
    if (isUrlFocused()) return;
    ev.preventDefault();
    const text = ev.clipboardData?.getData('text/plain') || '';
    if (text) {
      insertText(text);
      setStatus('pasted');
    }
  }, true);

  capture.addEventListener('input', () => {
    if (capture.value) {
      insertText(capture.value);
      capture.value = '';
    }
  });

  function go() {
    const u = urlInput.value.trim();
    if (!u) return;
    send({ type: 'navigate', url: u });
    urlInput.blur();
    focusCapture();
  }
  document.getElementById('go').onclick = go;
  document.getElementById('paste').onclick = () => { void pasteLocal(); };
  urlInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      go();
    }
  });
  document.getElementById('back').onclick = () => send({ type: 'back' });
  document.getElementById('fwd').onclick = () => send({ type: 'forward' });
  document.getElementById('reload').onclick = () => send({ type: 'reload' });
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

  // Never use text+Shift keyDown for printables — client sends insertText instead.
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
