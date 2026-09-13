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
export { loadSettings, saveSettings, DEFAULT_SETTINGS, type Settings, type CustomDirectorySetting, type SkillSettings } from "./store/settings.ts";
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

export { postToAll, postPaced, refuseDuplicateTitles, tailor, charsFor, summarize, type ComposeOptions, type TargetResult, type PostOutcome, type PacedOptions, type PacedOutcome } from "./core/poster.ts";
export {
  planTargets,
  pacingRules,
  nextSlotFor,
  nextUnderCap,
  lastPerNetwork,
  bookingsPerNetwork,
  bookingsPerAccount,
  recentDuplicate,
  describeMs,
  DEFAULT_PACING,
  DAY_MS,
  type PacingSettings,
  type PacingRules,
  type Plan,
  type PlannedTarget,
  type AccountLimits,
} from "./core/pacing.ts";
export {
  TEMPLATE_VERSION,
  DEFAULT_SKILL_SLUG,
  skillKindFor,
  templateLimits,
  networkTemplate,
  accountTemplate,
  profileUrlFor,
  ensureNetworkSkill,
  ensureAccountSkill,
  initSkills,
  readNetworkSkill,
  listAccountSkills,
  readAccountSkill,
  addAccountSkill,
  removeAccountSkill,
  pinDefaultSkill,
  setRotation,
  selectSkill,
  takeSkill,
  resolveSkill,
  mergeLimits,
  planLimitsFor,
  titleOf,
  duplicateTitle,
  skillTargets,
  findSkillTarget,
  directoryAsAccount,
  handleSlug,
  safeSlug,
  type SkillFile,
  type SkillFrontmatter,
  type SkillKind,
  type SkillLimits,
  type Selection,
  type ResolvedSkill,
  type ResolvedLimits,
  type InitResult,
} from "./core/skills.ts";
export {
  TYPE_TEMPLATES,
  TYPE_TEMPLATE_VERSION,
  BUILTIN_TYPES,
  DEFAULT_BLOG_TYPE,
  DEFAULT_SOCIAL_TYPE,
  typeTemplate,
  ensureTypeSkill,
  initTypeSkills,
  readTypeSkill,
  requireTypeSkill,
  listTypeSkills,
  addTypeSkill,
  removeTypeSkill,
  defaultTypeFor,
  typeAllows,
  refusedTargets,
  refuseTypeMismatch,
  bookingsForType,
  typeCapFor,
  type TypeSkill,
} from "./core/post-types.ts";
export { parseSkill, serializeSkill, typeSkillPath, listTypeSlugs, TYPES_DIR, type TypeFrontmatter, skillsDir, networkSkillPath, accountSkillPath, accountSkillDir, listSkillNetworks, listSkillAccountDirs, SKILLS_DIR } from "./store/skills.ts";
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
  followAllFollowing,
  followsListRef,
  type FollowAllOptions,
  type FollowAllResult,
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
  FollowedEvent,
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

// OpenProfile.md and the reshare network.
export {
  parseOpenProfile,
  renderOpenProfile,
  parseTopics,
  topicKey,
  topicsMatch,
  networkFromUrl,
  accountUrlFor,
  parseRate,
  parseLimit,
  type OpenProfile,
  type ProfileAccount,
  type ProfileInput,
  type ProfileOperator,
  type ProfilePair,
  type ProfileSection,
  type ReshareTerms,
} from "./core/openprofile.ts";
export { profilePath, hasWrittenProfile, buildProfile, readProfile, currentProfile, writeProfile } from "./store/profile.ts";
export {
  scoreMatch,
  rankSharers,
  sharerFromProfile,
  hashtagsIn,
  ownTopics,
  requestFromPosted,
  runReshare,
  quoteText,
  type MatchRequest,
  type MatchSharer,
  type MatchResult,
  type RunReshareOptions,
  type ReshareTurn,
} from "./core/reshare.ts";
export * as reshare from "./store/reshare.ts";
export { resharePlugin, RESHARE_EVERY_MS } from "./plugins/reshare-plugin.ts";
export { DEFAULT_PROFILE, DEFAULT_RESHARE, type ProfileSettings, type ReshareSettings } from "./store/settings.ts";

// Follow-ups: replies and follow-backs for the people who engaged.
export {
  scanEngagement,
  sendFollowUps,
  classify,
  bodyOf,
  ourPost,
  templateReply,
  sentToday,
  type Drafter,
  type ScanOptions,
  type ScanResult,
  type SendOptions,
  type SendResult,
} from "./core/engage.ts";
export { readEngage, writeEngage, listFollowUps, updateFollowUp, clearEngage, followUpKey, type FollowUp, type FollowUpKind, type EngageFile } from "./store/engage.ts";
export { engagePlugin, ENGAGE_SCAN_EVERY_MS, ENGAGE_SEND_EVERY_MS } from "./plugins/engage-plugin.ts";
export { replyDraft, type ReplyRequest } from "./ai/writer.ts";
export { DEFAULT_ENGAGE, type EngageSettings } from "./store/settings.ts";

// DIDs: proved at CoinPay, attached to accounts as owner or operator.
export { loginWithCoinPay, loginWithCoinPayCli, assignDid, unassignDid, didStatus, resolveDidTargets, didFromUserInfo, coinpayCliSessionPath, DEFAULT_DID_SERVER, type DidRole, type DidStatus, type DidLoginOptions } from "./core/did.ts";
export { didSession, saveDidSession, clearDidSession, requireDidSession, isDid, type DidSession } from "./store/did.ts";
export { DEFAULT_DID, type DidSettings } from "./store/settings.ts";
// AT Protocol servers: the probe, and the directory at mynaposter.com/listing/atproto.
export { probeAtproto, atprotoOrigin, type AtprotoProbe, type AtprotoKind } from "./core/atproto.ts";
export * as atproto from "./store/atproto.ts";

// Outreach: SMTP servers, texts through Telnyx, contacts and lists.
export { sendSmtp, buildMime, dotStuff, addressOf, SmtpError, type SmtpServer, type SmtpMessage, type SmtpResult, type SmtpOptions, type SmtpSecurity } from "./core/smtp.ts";
export { sendSms, e164, TELNYX_MESSAGES_URL, type SmsConfig, type SmsResult } from "./core/sms.ts";
export { readContacts, writeContacts, upsertContact, removeContact, optOut, addToList, recipients, contactId, type Contact, type ContactsFile } from "./store/contacts.ts";
export { readOutreach, writeOutreach, saveSmtpServer, removeSmtpServer, smtpServer, saveSms, smsConfig, recordSent, outreachSentToday, type SmsSetup, type SentRecord, type OutreachFile } from "./store/outreach.ts";
export { importFromAgenticjobs, type ImportOptions, type ImportResult } from "./core/contacts-import.ts";
export { DEFAULT_OUTREACH, type OutreachSettings } from "./store/settings.ts";
