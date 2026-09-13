/**
 * `myna synconfig` (also `myna syncfg`): your settings, on every machine.
 *
 *   myna synconfig                  where this machine stands against the cloud
 *   myna synconfig save [--force]   push settings, OpenProfile and skills
 *   myna synconfig load [--force] [--dry-run]   pull them here
 *   myna synconfig revisions        what the cloud keeps (the last ten)
 *   myna synconfig on | off         let the daemon do it every few minutes
 *
 * Needs `myna cloud login`. Accounts are not in this: they travel sealed,
 * with `myna cloud push`.
 */
import { synconfig, loadSettings, saveSettings } from "@profullstack/myna-core";
import { out } from "./io.ts";

type Flags = Record<string, unknown>;

const when = (iso?: string): string => (iso ? iso.slice(0, 16).replace("T", " ") : "never");

export async function runSynconfig(positional: string[], flags: Flags): Promise<number> {
  const [sub = "status"] = positional;
  const json = flags.json === true;
  const settings = loadSettings();

  if (sub === "on" || sub === "off") {
    settings.synconfig.auto = sub === "on";
    saveSettings(settings);
    out(`Settings sync ${sub}.${sub === "on" ? ` The daemon (myna run) pulls and pushes every ${settings.synconfig.everyMinutes} minutes.` : ""}`);
    return 0;
  }

  if (!synconfig.canSync()) throw new Error("Settings sync uses your myna cloud account: myna cloud login <email>");

  switch (sub) {
    case "status": {
      const state = await synconfig.configStatus();
      if (json) {
        out(JSON.stringify(state, null, 2));
        return 0;
      }
      out(`auto      ${settings.synconfig.auto ? `on, every ${settings.synconfig.everyMinutes} min in myna run` : "off  (myna synconfig on)"}`);
      out(`here      ${state.marker ? `revision ${state.marker.revision}, synced ${when(state.marker.at)}` : "never synced"}`);
      out(`cloud     ${state.serverRevision !== undefined ? `revision ${state.serverRevision}, saved ${when(state.serverSavedAt)}${state.serverHost ? ` from ${state.serverHost}` : ""}` : "nothing yet"}`);
      if (state.drifted.length) out(`changed   ${state.drifted.join(", ")}  (myna synconfig save)`);
      if (state.behind) out(`behind    the cloud is newer  (myna synconfig load)`);
      if (!state.drifted.length && !state.behind && state.marker) out("in sync.");
      return 0;
    }
    case "save": {
      const result = await synconfig.saveConfig({ force: flags.force === true });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return result.status === "conflict" ? 1 : 0;
      }
      for (const skip of result.skipped) out(`  skipped ${skip.path}: ${skip.reason}`);
      switch (result.status) {
        case "saved":
          out(`Saved revision ${result.revision}: ${result.files} file${result.files === 1 ? "" : "s"}.`);
          return 0;
        case "unchanged":
          out(`Nothing changed since revision ${result.revision}.`);
          return 0;
        case "empty":
          out("Nothing to save: no settings, OpenProfile or skills here yet.");
          return 0;
        case "conflict":
          out(`Not saved: another machine saved revision ${result.serverRevision} first.`);
          out("  myna synconfig load        take theirs (keeps your local edits unless --force)");
          out("  myna synconfig save --force   make yours the newest");
          return 1;
      }
      return 0;
    }
    case "load": {
      const result = await synconfig.loadConfig({ force: flags.force === true, dryRun: flags.dryRun === true });
      if (json) {
        out(JSON.stringify(result, null, 2));
        return result.status === "local_changes" ? 1 : 0;
      }
      for (const reject of result.rejected) out(`  ignored ${reject.path}: ${reject.reason}`);
      switch (result.status) {
        case "empty":
          out("Nothing in the cloud yet. myna synconfig save puts this machine's settings there.");
          return 0;
        case "same":
          out(`Already at revision ${result.revision}.`);
          return 0;
        case "planned":
          for (const entry of result.plan) out(`  ${entry.status.padEnd(8)} ${entry.path}`);
          out(`Would take revision ${result.revision}. Nothing written.`);
          return 0;
        case "local_changes":
          out(`Not loaded: ${result.drifted.join(", ")} changed here since the last sync.`);
          out("  myna synconfig save           keep yours, push them");
          out("  myna synconfig load --force   replace them with the cloud's");
          return 1;
        case "loaded":
          out(`Loaded revision ${result.revision}: ${result.written.join(", ")}.`);
          return 0;
      }
      return 0;
    }
    case "revisions": {
      const revisions = await synconfig.syncContext().client.revisions();
      if (json) {
        out(JSON.stringify(revisions, null, 2));
        return 0;
      }
      if (!revisions.length) {
        out("Nothing saved yet.");
        return 0;
      }
      for (const entry of revisions) out(`${String(entry.revision).padStart(4)}  ${when(entry.savedAt)}  ${(entry.host ?? "").padEnd(18)}  ${entry.version ?? ""}  ${entry.size} bytes`);
      return 0;
    }
    default:
      throw new Error(`Unknown: myna synconfig ${sub}. Try status, save, load, revisions, on or off.`);
  }
}
