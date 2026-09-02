/** Everything the CLI, the desktop app, the API and the MCP server share. */

export { VERSION } from "./version.ts";

export type {
  Account,
  AuthKind,
  CredentialField,
  LoginContext,
  MediaItem,
  Network,
  NetworkCapabilities,
  PostInput,
  PostResult,
  PostStats,
  TimelineItem,
} from "./net/types.ts";

export { NETWORKS, getNetwork, requireNetwork, networksByCategory, authSummary } from "./net/registry.ts";
export { CALLBACK_PORT, REDIRECT_URI, openBrowser } from "./net/oauth2.ts";

export {
  listAccounts,
  getAccount,
  accountsFor,
  saveAccount,
  removeAccount,
  resolveTargets,
  unlock,
  needsPassphrase,
  resetAccountCache,
} from "./store/accounts.ts";
export { listQueue, enqueue, updateQueued, removeQueued, duePosts, type QueuedPost } from "./store/queue.ts";
export { listHistory, recordHistory, clearHistory, type HistoryEntry } from "./store/history.ts";
export { listEngagement, recordEngagement, clearEngagement } from "./store/engagement.ts";
export {
  postsPerDay,
  postsPerHour,
  byNetwork,
  totals,
  topPosts,
  needsRefresh,
  type DayBucket,
  type NetworkBreakdown,
  type Totals,
  type RankedPost,
  type EngagementRecord,
} from "./core/analytics.ts";
export { refreshEngagement, type RefreshResult } from "./core/refresh.ts";
export { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from "./store/settings.ts";
export {
  collect,
  seal,
  open as openBundle,
  apply as applyBundle,
  describe as describeBundle,
  BUNDLE_VERSION,
  type BundleFile,
  type BundlePayload,
  type ApplyResult,
} from "./store/bundle.ts";
export { vaultExists, vaultMode, rekeyVault, VaultLockedError } from "./util/crypto/vault.ts";
export * as cloud from "./store/cloud.ts";

export { postToAll, tailor, charsFor, summarize, type ComposeOptions, type TargetResult } from "./core/poster.ts";
export { loadMedia, loadAllMedia } from "./core/media.ts";
export { runDuePosts, startScheduler } from "./core/scheduler.ts";

export { countChars, splitThread, appendHashtags, toHashtag, extractHashtags, truncateTo } from "./util/text.ts";
export { configDir, configPath } from "./util/paths.ts";
export { HttpError } from "./util/http.ts";

export { draft, revise, infographicCopy, infographicHtml, writerAvailable, type Draft, type InfographicCopy } from "./ai/writer.ts";
export { fetchPage, type PageSummary } from "./ai/extract.ts";
export { renderInfographic, renderSvg, type InfographicStyle, type RenderOptions } from "./graphics/infographic.ts";
export { availableRasterizers } from "./graphics/raster.ts";
