/** Shared on-demand browser — host-local paths and ports. */

export const DATA_DIR = "/home/bb/.bb-shared-browser";
export const PROFILE_DIR = `${DATA_DIR}/chrome-profile`;
export const STATE_PATH = `${DATA_DIR}/state.json`;
export const CHROME_PID_PATH = `${DATA_DIR}/chrome.pid`;
export const XVFB_PID_PATH = `${DATA_DIR}/xvfb.pid`;
export const VIEWER_PID_PATH = `${DATA_DIR}/viewer.pid`;
export const VIEWER_LOG_PATH = `${DATA_DIR}/viewer.log`;
export const CHROME_LOG_PATH = `${DATA_DIR}/chrome.log`;

/** Chrome DevTools Protocol port (loopback only). */
export const CDP_PORT = 9222;
/** Interactive screencast viewer HTTP port (shared via bb connect tunnel). */
export const VIEWER_PORT = 9225;
/** Dedicated X display for headed shared mode (avoid colliding with other :99 users). */
export const XVFB_DISPLAY = ":98";

export const AXI_BROWSER_URL = `http://127.0.0.1:${CDP_PORT}`;
