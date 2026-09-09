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
  Profile,
  FollowResult,
  TimelineItem,
} from "./net/types.ts";

export { NETWORKS, getNetwork, requireNetwork, registerNetwork, networksByCategory, authSummary } from "./net/registry.ts";
export {
  CALLBACK_PORT,
  REDIRECT_URI,
  openBrowser,
  authorize,
  refresh,
  currentToken,
  callbackFrom,
  OAUTH_FIELDS,
  PASTE_FIELD,
  REDIRECT_NOTE,
  type OAuth2Config,
  type TokenSet,
} from "./net/oauth2.ts";

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
  getPluginSecrets,
  setPluginSecrets,
  listDirectoryAccounts,
  getDirectoryAccount,
  saveDirectoryAccount,
  removeDirectoryAccount,
} from "./store/accounts.ts";

export type {
  Directory,
  DirectoryAccount,
  DirectoryCapabilities,
  Listing,
  ListingInput,
  Vocabulary,
} from "./directories/types.ts";
export {
  DIRECTORIES,
  listDirectories,
  getDirectory,
  requireDirectory,
  registerDirectory,
  unregisterDirectory,
  addCustomDirectory,
  removeCustomDirectory,
  resetDirectoryCache,
} from "./directories/registry.ts";
export { CATALOG, catalogEntry, type CatalogEntry } from "./directories/catalog.ts";
export { mcpDirectory, resolveTools, type CustomDirectoryConfig } from "./directories/custom.ts";
export {
  buildListing,
  submitListing,
  submitUrl,
  loginDirectory,
  logoutDirectory,
  directoryStatus,
  requireDirectoryAccount,
  deriveName,
  deriveDescription,
  type BuildOptions,
  type BuiltListing,
  type SubmitResult,
} from "./directories/submit.ts";
export { McpClient, McpToolError, parseMessage, MCP_PROTOCOL_VERSION, type McpTool, type McpServerInfo } from "./directories/mcp.ts";
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
export { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings, type CustomDirectorySetting } from "./store/settings.ts";
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

export { postToAll, postPaced, tailor, charsFor, summarize, type ComposeOptions, type TargetResult, type PostOutcome, type PacedOptions, type PacedOutcome } from "./core/poster.ts";
export { planTargets, pacingRules, nextSlotFor, lastPerNetwork, bookingsPerNetwork, recentDuplicate, describeMs, DEFAULT_PACING, type PacingSettings, type PacingRules, type Plan, type PlannedTarget } from "./core/pacing.ts";
export { runEvergreen, pickEvergreen, evergreenText, lastEvergreen, DEFAULT_EVERGREEN, EVERGREEN_MARK, type EvergreenSettings, type EvergreenRun, type EvergreenPick } from "./core/evergreen.ts";
export {
  buildRecap,
  renderRecapText,
  recapSubject,
  recapDue,
  runRecap,
  sendRecap,
  loadRecapState,
  saveRecapState,
  DEFAULT_RECAP,
  RECAP_GUARD_MS,
  type Recap,
  type RecapSettings,
  type RecapAccountRow,
  type RecapFailure,
  type RecapUpcoming,
  type RecapTurn,
  type SendRecapResult,
} from "./core/recap.ts";
export { runAfterPost, runAfterSchedule, runAfterCancel, postedEvent, scheduledEvent, type HookOutcome } from "./plugins/hooks.ts";
export { renderMarkdown, renderInline, firstParagraph, slugify, escapeHtml } from "./util/markdown.ts";
export { loadMedia, loadAllMedia } from "./core/media.ts";
export { runDuePosts, startScheduler } from "./core/scheduler.ts";
export { startDaemon, runDaemonOnce, builtinJobs, type DaemonJob, type DaemonOptions } from "./core/daemon.ts";
export {
  checkForUpdate,
  selfUpdate,
  assetFor,
  cpuHasAvx2,
  isNewer,
  daemonHint,
  type UpdateCheck,
  type UpdateResult,
  type UpdateOptions,
} from "./core/update.ts";
export {
  addSeeds,
  removeSeed,
  expandSeeds,
  rankCandidates,
  skipCandidate,
  followBudget,
  followNext,
  followOne,
  graphStatus,
  readGraph,
  clearGraph,
  graphPath,
  type SeedInput,
  type RankedCandidate,
  type ExpandResult,
  type GraphStatus,
  type Seed,
  type Candidate,
  type FollowRecord,
} from "./core/graph.ts";
export {
  registerPlugin,
  loadPlugins,
  listPlugins,
  getPlugin,
  findPluginCommand,
  pluginTasks,
  seedProviders,
  resolvePluginEntry,
  pluginsDir,
  resetPlugins,
} from "./plugins/loader.ts";
export { pluginContext, type HostOptions } from "./plugins/context.ts";
export type {
  MynaPlugin,
  PluginContext,
  PluginCommand,
  DaemonTask,
  SeedProvider,
  LoadedPlugin,
  PostedEvent,
  PostedTarget,
  ScheduledEvent,
  CancelledEvent,
} from "./plugins/types.ts";

export { countChars, splitThread, appendHashtags, toHashtag, extractHashtags, truncateTo, deriveTitle, bodyUnderTitle } from "./util/text.ts";
export { configDir, configPath } from "./util/paths.ts";
export { HttpError, request, getJson, postJson, postForm } from "./util/http.ts";
export { parseWhen, describeWhen, parseDuration } from "./util/when.ts";

export {
  draft,
  revise,
  infographicCopy,
  infographicHtml,
  listingCopy,
  writerAvailable,
  type Draft,
  type InfographicCopy,
  type ListingCopy,
  type ListingCopyRequest,
} from "./ai/writer.ts";
export { fetchPage, type PageSummary } from "./ai/extract.ts";
export { renderInfographic, renderSvg, type InfographicStyle, type RenderOptions } from "./graphics/infographic.ts";
export { availableRasterizers } from "./graphics/raster.ts";
