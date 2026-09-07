import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";

type PanelStatus = {
  state: {
    running: boolean;
    mode: "shared" | "headless" | null;
    url: string | null;
  };
  viewerUrl: string | null;
  axiHint: string;
};

function isNavigableUrl(value: string): boolean {
  const v = value.trim();
  if (!v || v === "https://" || v === "http://") return false;
  if (v.startsWith("/")) return false;
  return /^https?:\/\//i.test(v) || !v.includes("://");
}

function BrowserPanel({ autoStart }: { autoStart: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<PanelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState("https://example.com");
  const startedRef = useRef(false);

  const openViewer = useCallback((url: string | null | undefined) => {
    if (!url || typeof window === "undefined") return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("status", {});
      setStatus(result);
      setError(null);
      if (result.state.url && isNavigableUrl(result.state.url)) {
        setUrlDraft(result.state.url);
      }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [rpc]);

  const startShared = useCallback(
    async (opts?: { open?: boolean; url?: string }) => {
      setBusy(true);
      try {
        const draft = (opts?.url ?? urlDraft).trim();
        const url = isNavigableUrl(draft) ? draft : undefined;
        const result = await rpc.call("start", {
          mode: "shared",
          url,
        });
        setStatus(result);
        setError(null);
        // Only open from a direct user click — browsers block popup after await.
        if (opts?.open === true) openViewer(result.viewerUrl);
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [openViewer, rpc, urlDraft],
  );

  useEffect(() => {
    void (async () => {
      const current = await refresh();
      if (!autoStart || startedRef.current) return;
      startedRef.current = true;
      if (current?.state.running) {
        // Already up — still surface the viewer link; user clicks Open viewer.
        return;
      }
      await startShared({ open: false });
    })();
  }, [autoStart, refresh, startShared]);

  useRealtime("shared-browser-changed", () => {
    void refresh();
  });

  const stop = async () => {
    setBusy(true);
    try {
      await rpc.call("stop", {});
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const navigate = async () => {
    const url = urlDraft.trim();
    if (!isNavigableUrl(url)) {
      setError("Enter a full URL like https://example.com");
      return;
    }
    setBusy(true);
    try {
      if (!status?.state.running) {
        await startShared({ open: true, url });
      } else {
        await rpc.call("navigate", { url });
        const next = await refresh();
        if (next?.viewerUrl) openViewer(next.viewerUrl);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const viewerUrl = status?.viewerUrl ?? null;
  const running = status?.state.running ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <input
          className="min-w-[12rem] flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate();
          }}
          placeholder="https://example.com"
          spellCheck={false}
        />
        <Button size="sm" disabled={busy} onClick={() => void navigate()}>
          Go
        </Button>
        {!running ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void startShared({ open: true })}
          >
            Start
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void stop()}
          >
            Stop
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !viewerUrl}
          onClick={() => openViewer(viewerUrl)}
        >
          Open viewer
        </Button>
      </div>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="max-w-md space-y-2">
          <h2 className="text-base font-medium">
            {running ? "Shared browser is running" : "Shared browser is stopped"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {running
              ? "Open the viewer tab to click and log in. Agents use the same Chromium session."
              : "Press Start (or open this panel again) to spin Chromium for login."}
          </p>
          <p className="text-xs text-muted-foreground">
            {status?.axiHint ?? (busy ? "Starting…" : "")}
          </p>
        </div>

        {viewerUrl ? (
          <div className="flex flex-col items-center gap-2">
            <Button
              disabled={busy}
              onClick={() => openViewer(viewerUrl)}
            >
              Open viewer
            </Button>
            <UrlLink
              href={viewerUrl}
              className="break-all text-xs text-primary underline-offset-2 hover:underline"
            >
              {viewerUrl}
            </UrlLink>
            <p className="max-w-sm text-xs text-muted-foreground">
              The viewer opens in a new tab (connect share). An iframe cannot
              show it inside bb because the share requires your getbb.app
              session.
            </p>
          </div>
        ) : (
          <Button
            disabled={busy}
            onClick={() => void startShared({ open: true })}
          >
            {busy ? "Starting…" : "Start shared browser"}
          </Button>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "shared-browser",
    title: "Browser",
    icon: "Globe",
    path: "browser",
    component: () => <BrowserPanel autoStart={false} />,
  });

  app.slots.threadPanelAction({
    id: "open-browser",
    title: "Open Browser",
    icon: "Globe",
    layout: "flush",
    component: () => <BrowserPanel autoStart />,
    run: async ({ openPanel }) => {
      openPanel({ title: "Browser" });
    },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "open-browser-new",
    title: "Open Browser",
    icon: "Globe",
    layout: "flush",
    component: () => <BrowserPanel autoStart />,
    run: async ({ openPanel }) => {
      openPanel({ title: "Browser" });
    },
  });
});
