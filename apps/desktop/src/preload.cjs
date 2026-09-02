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

  queue: {
    list: () => call("queue:list"),
    add: (options) => call("queue:add", options),
    remove: (id) => call("queue:remove", id),
  },

  history: () => call("history:list"),

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
  onSchedulerRan: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("scheduler:ran", listener);
    return () => ipcRenderer.off("scheduler:ran", listener);
  },
});
