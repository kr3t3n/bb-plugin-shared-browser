import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "./server";

function BrowserPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<{
    state: {
      running: boolean;
      mode: "shared" | "headless" | null;
      url: string | null;
    };
    viewerUrl: string | null;
    axiHint: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [urlDraft, setUrlDraft] = useState("https://");

  const refresh = useCallback(async () => {
    try {
      const result = await rpc.call("status", {});
      setStatus(result);
      setError(null);
      if (result.state.url) setUrlDraft(result.state.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRealtime("shared-browser-changed", () => {
    void refresh();
  });

  const startShared = async () => {
    setBusy(true);
    try {
      const result = await rpc.call("start", {
        mode: "shared",
        url: urlDraft.trim() || undefined,
      });
      setStatus(result);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

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
    if (!url) return;
    setBusy(true);
    try {
      if (!status?.state.running) {
        const result = await rpc.call("start", { mode: "shared", url });
        setStatus(result);
      } else {
        await rpc.call("navigate", { url });
        await refresh();
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
          placeholder="https://"
          spellCheck={false}
        />
        <Button size="sm" disabled={busy} onClick={() => void navigate()}>
          Go
        </Button>
        {!running ? (
          <Button size="sm" disabled={busy} onClick={() => void startShared()}>
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
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
        {viewerUrl ? (
          <UrlLink
            href={viewerUrl}
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            Open viewer
          </UrlLink>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="px-3 py-2 text-xs text-muted-foreground">
        {status?.axiHint ?? "Starting…"}
        {running ? ` · mode ${status?.state.mode}` : null}
      </div>

      <div className="min-h-0 flex-1 bg-muted/30">
        {viewerUrl ? (
          <iframe
            title="Shared browser viewer"
            src={viewerUrl}
            className="h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
            <div className="max-w-md space-y-3">
              <p>
                Press Start to spin a shared Chromium for login. Agents attach to
                the same session. When you press Stop, agents use headless
                Chromium again.
              </p>
              <Button disabled={busy} onClick={() => void startShared()}>
                Start shared browser
              </Button>
            </div>
          </div>
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
    component: () => <BrowserPanel />,
  });

  app.slots.threadPanelAction({
    id: "open-browser",
    title: "Open Browser",
    icon: "Globe",
    layout: "flush",
    component: () => <BrowserPanel />,
    run: ({ openPanel }) => {
      openPanel({ title: "Browser" });
    },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "open-browser-new",
    title: "Open Browser",
    icon: "Globe",
    layout: "flush",
    component: () => <BrowserPanel />,
    run: ({ openPanel }) => {
      openPanel({ title: "Browser" });
    },
  });
});
