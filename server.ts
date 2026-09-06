import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { browserStateSchema, hostContract } from "./contract.js";
import { AXI_BROWSER_URL, VIEWER_PORT } from "./lib/constants.js";

const ENV_JSON = "/home/bb/.bb/env.json";
const CONNECT_HANDLE_FALLBACK = "gap-hetzner";

function readConnectHandle(): string | null {
  if (process.env.BB_CONNECT_HANDLE?.trim()) {
    return process.env.BB_CONNECT_HANDLE.trim();
  }
  // Do not spawn `bb connect status` from the plugin server (same-process deadlock risk).
  return CONNECT_HANDLE_FALLBACK;
}

export const rpcContract = defineRpcContract({
  start: {
    input: z.object({
      mode: z.enum(["shared", "headless"]).default("shared"),
      url: z.string().trim().min(1).max(4096).optional(),
      hostId: z.string().trim().min(1).optional(),
    }),
    output: z.object({
      state: browserStateSchema,
      viewerUrl: z.string().nullable(),
      axiHint: z.string(),
    }),
  },
  stop: {
    input: z.object({
      hostId: z.string().trim().min(1).optional(),
    }),
    output: z.object({
      state: browserStateSchema,
    }),
  },
  status: {
    input: z.object({
      hostId: z.string().trim().min(1).optional(),
    }),
    output: z.object({
      state: browserStateSchema,
      viewerUrl: z.string().nullable(),
      axiHint: z.string(),
    }),
  },
  navigate: {
    input: z.object({
      url: z.string().trim().min(1).max(4096),
      hostId: z.string().trim().min(1).optional(),
    }),
    output: z.object({
      state: browserStateSchema,
    }),
  },
});

function setAxiBrowserUrl(enabled: boolean): void {
  try {
    let data: { env?: Record<string, string> } = { env: {} };
    try {
      data = JSON.parse(readFileSync(ENV_JSON, "utf8")) as typeof data;
    } catch {
      data = { env: {} };
    }
    const env = { ...(data.env ?? {}) };
    if (enabled) {
      env.CHROME_DEVTOOLS_AXI_BROWSER_URL = AXI_BROWSER_URL;
    } else {
      delete env.CHROME_DEVTOOLS_AXI_BROWSER_URL;
    }
    writeFileSync(ENV_JSON, `${JSON.stringify({ ...data, env }, null, 2)}\n`);
    // Best-effort reload; never block the CLI on this.
    spawnSync("bb-app", ["config", "refresh"], {
      encoding: "utf8",
      timeout: 3000,
    });
  } catch {
    /* best-effort */
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("shared-browser loaded");

  const host = bb.hosts.experimental_client({
    contract: hostContract,
  });

  async function resolveHostId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    const config = await bb.sdk.system.config();
    if (config.primaryHostId) return config.primaryHostId;
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.filter((h) => h.status === "connected");
    const pick =
      connected.find((h) => /agents|hetzner|linux/i.test(h.name)) ??
      connected[0] ??
      hosts[0];
    if (!pick) throw new Error("No connected bb host to run the browser on");
    return pick.id;
  }

  async function viewerUrlFor(hostId: string, runningViewer: boolean): Promise<string | null> {
    if (!runningViewer) return null;

    // Never spawn `bb connect` from the plugin server — it deadlocks the same
    // event loop. Declare the port, then build the public URL from connect state.
    try {
      bb.hosts.declareSharedPorts(hostId, [VIEWER_PORT]);
    } catch (err) {
      bb.log.warn("declareSharedPorts failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prefer a quick tunnel label read with a hard timeout.
    try {
      const tunnel = await Promise.race([
        bb.hosts.ensureSharedPortTunnel(hostId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);
      if (tunnel && typeof tunnel === "object" && "label" in tunnel) {
        const t = tunnel as { label: string; baseDomain: string };
        return `https://${t.label}--${VIEWER_PORT}.${t.baseDomain}`;
      }
    } catch (err) {
      bb.log.warn("ensureSharedPortTunnel failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Fallback: read connect handle from local state files / known pairing.
    const handle = readConnectHandle();
    if (handle) return `https://${handle}--${VIEWER_PORT}.getbb.app`;
    return `http://127.0.0.1:${VIEWER_PORT}`;
  }

  function axiHint(running: boolean): string {
    if (running) {
      return `Agents: chrome-devtools-axi attaches via CHROME_DEVTOOLS_AXI_BROWSER_URL=${AXI_BROWSER_URL} (same profile).`;
    }
    return "Agents: shared browser stopped — chrome-devtools-axi uses ephemeral headless Chromium.";
  }

  function scheduleConnectExpose(port: number): void {
    // Run after the current plugin request finishes so we do not deadlock the
    // server event loop (bb connect talks to the same server).
    setTimeout(() => {
      try {
        spawn(
          "bb",
          ["connect", "expose", String(port), "--json"],
          { detached: true, stdio: "ignore" },
        ).unref();
      } catch (err) {
        bb.log.warn("deferred connect expose failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 0);
  }

  async function doStart(input: {
    mode: "shared" | "headless";
    url?: string;
    hostId?: string;
  }) {
    const hostId = await resolveHostId(input.hostId);
    const state = await host.call(
      "start",
      { mode: input.mode, url: input.url },
      { hostId },
    );
    setAxiBrowserUrl(true);
    if (state.viewerPort !== null) {
      try {
        bb.hosts.declareSharedPorts(hostId, [VIEWER_PORT]);
      } catch {
        /* ignore */
      }
      scheduleConnectExpose(VIEWER_PORT);
    }
    const viewerUrl = await viewerUrlFor(hostId, state.viewerPort !== null);
    bb.realtime.publish("shared-browser-changed", {
      running: state.running,
      mode: state.mode,
    });
    return { state, viewerUrl, axiHint: axiHint(state.running) };
  }

  async function doStop(input: { hostId?: string }) {
    const hostId = await resolveHostId(input.hostId);
    const state = await host.call("stop", {}, { hostId });
    setAxiBrowserUrl(false);
    try {
      bb.hosts.declareSharedPorts(hostId, []);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        spawn(
          "bb",
          ["connect", "unexpose", String(VIEWER_PORT)],
          { detached: true, stdio: "ignore" },
        ).unref();
      } catch {
        /* ignore */
      }
    }, 0);
    bb.realtime.publish("shared-browser-changed", {
      running: false,
      mode: null,
    });
    return { state };
  }

  async function doStatus(input: { hostId?: string }) {
    const hostId = await resolveHostId(input.hostId);
    const state = await host.call("status", {}, { hostId });
    const viewerUrl = await viewerUrlFor(hostId, state.viewerPort !== null);
    return { state, viewerUrl, axiHint: axiHint(state.running) };
  }

  bb.rpc.register(rpcContract, {
    start: (input) => doStart(input),
    stop: (input) => doStop(input),
    status: (input) => doStatus(input),
    async navigate(input) {
      const hostId = await resolveHostId(input.hostId);
      const state = await host.call("navigate", { url: input.url }, { hostId });
      bb.realtime.publish("shared-browser-changed", {
        running: state.running,
        mode: state.mode,
      });
      return { state };
    },
  });

  const usage = [
    "Usage:",
    "  bb browser start [--shared|--headless] [url]",
    "  bb browser stop",
    "  bb browser status [--json]",
    "  bb browser url",
    "  bb browser open <url>",
    "",
    "shared (default for start): headed Chromium + interactive viewer for login.",
    "headless: persistent-profile CDP only (no viewer). Agents attach via axi.",
    "When stopped, agents use ephemeral headless Chromium again.",
  ].join("\n");

  bb.cli.register({
    name: "browser",
    summary: "On-demand shared Chromium for login + agent control",
    commands: [
      {
        name: "start",
        summary: "Start shared (viewer) or headless browser",
        usage: "bb browser start [--shared|--headless] [url]",
      },
      { name: "stop", summary: "Stop browser and viewer", usage: "bb browser stop" },
      {
        name: "status",
        summary: "Show browser status",
        usage: "bb browser status [--json]",
      },
      {
        name: "url",
        summary: "Print the interactive viewer URL",
        usage: "bb browser url",
      },
      {
        name: "open",
        summary: "Start shared mode and navigate",
        usage: "bb browser open <url>",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const args = argv.filter((a) => a !== "--json");
      const [command, ...rest] = args;

      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`,
      });

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: `${usage}\n` };
          case "start": {
            let mode: "shared" | "headless" = "shared";
            const positional: string[] = [];
            for (const a of rest) {
              if (a === "--shared") mode = "shared";
              else if (a === "--headless") mode = "headless";
              else positional.push(a);
            }
            const result = await doStart({
              mode,
              url: positional[0],
            });
            const lines = [
              `mode: ${result.state.mode}`,
              `cdp: ${result.state.axiBrowserUrl}`,
              result.viewerUrl ? `viewer: ${result.viewerUrl}` : "viewer: (none)",
              result.axiHint,
            ];
            return reply(result, lines.join("\n"));
          }
          case "stop": {
            const result = await doStop({});
            return reply(result, "stopped");
          }
          case "status": {
            const result = await doStatus({});
            const lines = [
              `running: ${result.state.running}`,
              `mode: ${result.state.mode ?? "-"}`,
              `url: ${result.state.url ?? "-"}`,
              result.viewerUrl ? `viewer: ${result.viewerUrl}` : "viewer: -",
              result.axiHint,
            ];
            return reply(result, lines.join("\n"));
          }
          case "url": {
            const result = await doStatus({});
            if (!result.viewerUrl) {
              return {
                exitCode: 1,
                stderr:
                  "No viewer URL. Run: bb browser start --shared\n",
              };
            }
            return reply({ viewerUrl: result.viewerUrl }, result.viewerUrl);
          }
          case "open": {
            const url = rest.join(" ").trim();
            if (!url) break;
            const result = await doStart({ mode: "shared", url });
            const lines = [
              `opened: ${url}`,
              result.viewerUrl ? `viewer: ${result.viewerUrl}` : "viewer: (none)",
              result.axiHint,
            ];
            return reply(result, lines.join("\n"));
          }
        }
      } catch (err) {
        return {
          exitCode: 1,
          stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        };
      }

      void ctx;
      return { exitCode: 1, stderr: `${usage}\n` };
    },
  });

  bb.agents.registerTool({
    name: "shared_browser",
    description:
      "Start/stop the on-demand shared Chromium used for human login and agent control. Prefer this when the user must log in, then continue with chrome-devtools-axi on the same profile.",
    instructions:
      "For user login or shared browsing, call shared_browser action=start (shared). Give the user the viewerUrl markdown link. After login, use chrome-devtools-axi (it attaches via CHROME_DEVTOOLS_AXI_BROWSER_URL). Stop when done. For agent-only browsing without login, do not start shared — use chrome-devtools-axi headless alone.",
    parameters: z.object({
      action: z.enum(["start", "stop", "status", "open"]),
      mode: z.enum(["shared", "headless"]).optional(),
      url: z.string().trim().min(1).max(4096).optional(),
    }),
    async execute(input) {
      if (input.action === "stop") {
        return JSON.stringify(await doStop({}));
      }
      if (input.action === "status") {
        return JSON.stringify(await doStatus({}));
      }
      if (input.action === "open") {
        if (!input.url) throw new Error("url is required for open");
        return JSON.stringify(await doStart({ mode: "shared", url: input.url }));
      }
      return JSON.stringify(
        await doStart({
          mode: input.mode ?? "shared",
          url: input.url,
        }),
      );
    },
  });

  bb.agents.contributeInstructions(() =>
    [
      "Remote bb has no native Browser tab.",
      "For human login on this host: `bb browser start --shared` (or shared_browser tool), give the viewer URL, then use chrome-devtools-axi on the same CDP profile.",
      "When idle: `bb browser stop` — agents fall back to ephemeral headless.",
    ].join(" "),
  );

  bb.onDispose(() => {
    bb.log.info("shared-browser disposed");
  });
}
