/**
 * A key echo.
 *
 * When a binding "does nothing", the question is whether the key reached the
 * program at all. Ctrl+S is the classic: it is XOFF, and a terminal with flow
 * control still enabled swallows it and freezes output instead, which looks
 * exactly like the application ignoring you.
 */
import { createApp } from "@profullstack/hqtui";

export async function runKeyProbe(): Promise<void> {
  const seen: { key: string; name: string; when: number }[] = [];
  const wanted = ["ctrl+s", "f2", "ctrl+t", "enter", "escape", "tab", "shift+tab", "up", "down"];
  const got = new Set<string>();

  const app = await createApp({ title: "myna keys", quitKeys: ["ctrl+c"], focusNavigation: false });

  app.on("key", (event) => {
    seen.unshift({ key: event.key, name: event.name, when: Date.now() });
    if (seen.length > 12) seen.pop();
    got.add(event.key);
    app.invalidate();
  });

  app.render(({ ui, theme }) => {
    ui.column({ size: "1fr" }, (root) => {
      root.panel({ title: "Press the keys myna uses", size: wanted.length + 3 }, (panel) => {
        for (const key of wanted) {
          const arrived = got.has(key);
          panel.keyValues([
            {
              label: key,
              value: arrived ? "reaches myna" : "not seen yet",
              color: arrived ? theme.success : theme.muted,
            },
          ]);
        }
      });

      root.panel({ title: "What arrived", size: "1fr" }, (panel) => {
        if (!seen.length) {
          panel.label("Nothing yet. Try Ctrl+S first.", { size: 1 });
        }
        for (const event of seen) {
          panel.text(`${event.key.padEnd(14)} name=${event.name}`, { size: 1 });
        }
      });

      root.statusBar({
        size: 1,
        items: [
          { label: "myna keys", color: theme.primary },
          {
            label: got.has("ctrl+s")
              ? "Ctrl+S reaches myna, so the binding is fine"
              : "If Ctrl+S never appears, your terminal is eating it as XOFF: run `stty -ixon`",
            color: got.has("ctrl+s") ? theme.success : theme.warning,
          },
          { key: "quit", label: "Ctrl+C" },
        ],
      });
    });
  });

  await app.start();
}
