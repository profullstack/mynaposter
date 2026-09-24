/**
 * The only bridge between the renderer and Node.
 *
 * Every method is an explicit, named channel. The renderer gets no `require`,
 * no filesystem and no network beyond what these expose.
 */
const { contextBridge, ipcRenderer } = require("electron");

const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

contextBridge.exposeInMainWorld("myna", {
  networks: () => call("networks:list"),

  accounts: {
    list: () => call("accounts:list"),
    login: (network, values) => call("accounts:login", network, values),
    logout: (id) => call("accounts:logout", id),
  },

  post: {
    send: (options) => call("post:send", options),
    preview: (options) => call("post:preview", options),
  },

  directories: {
    list: () => call("directories:list"),
    login: (directory, values) => call("directories:login", directory, values),
    logout: (directory) => call("directories:logout", directory),
    preview: (directory, url) => call("directories:preview", directory, url),
    submit: (directory, listing) => call("directories:submit", directory, listing),
    listings: (directory) => call("directories:listings", directory),
    remove: (directory, listingId) => call("directories:remove", directory, listingId),
  },

  upvote: {
    overview: () => call("upvote:overview"),
    enabled: (on) => call("upvote:enabled", on),
    scan: () => call("upvote:scan"),
    send: (options) => call("upvote:send", options),
    skip: (id) => call("upvote:skip", id),
    edit: (id, reply) => call("upvote:edit", id, reply),
  },
  queue: {
    list: () => call("queue:list"),
    add: (options) => call("queue:add", options),
    remove: (id) => call("queue:remove", id),
  },

  history: () => call("history:list"),

  newsletter: {
    overview: () => call("newsletter:overview"),
    create: (issue) => call("newsletter:create", issue),
    update: (id, patch) => call("newsletter:update", id, patch),
    remove: (id) => call("newsletter:remove", id),
    dry: (id) => call("newsletter:dry", id),
    test: (id, to) => call("newsletter:test", id, to),
    send: (id) => call("newsletter:send", id),
    stats: (id) => call("newsletter:stats", id),
    subscribers: (list) => call("newsletter:subscribers", list),
    subscribe: (list, emails) => call("newsletter:subscribe", list, emails),
    unsubscribe: (who, list) => call("newsletter:unsubscribe", who, list),
    import: (list) => call("newsletter:import", list),
    track: (site) => call("newsletter:track", site),
  },

  settings: {
    get: () => call("settings:get"),
    set: (settings) => call("settings:set", settings),
  },

  ai: {
    available: () => call("ai:available"),
    draft: (options) => call("ai:draft", options),
    revise: (options) => call("ai:revise", options),
    infographic: (options) => call("ai:infographic", options),
  },

  media: { pick: () => call("media:pick") },
  doctor: () => call("doctor"),
  openExternal: (url) => call("shell:open", url),

  onLoginProgress: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("login:progress", listener);
    return () => ipcRenderer.off("login:progress", listener);
  },

  // A sign-in that has to ask something mid-flow: a mailed one-time code, or a
  // device flow waiting on a browser. The handler shows a prompt and calls
  // `answerLogin`; until it does, the sign-in is still waiting.
  onLoginAsk: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("login:ask", listener);
    return () => ipcRenderer.off("login:ask", listener);
  },
  answerLogin: (id, value) => ipcRenderer.send("login:answer", { id, value }),
  cancelLogin: (id) => ipcRenderer.send("login:answer", { id, cancelled: true }),
  onSchedulerRan: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("scheduler:ran", listener);
    return () => ipcRenderer.off("scheduler:ran", listener);
  },
});
