/**
 * The desktop renderer.
 *
 * No framework and no build step: the whole app is a few hundred lines of DOM.
 * Every call goes through window.myna, which the preload defines; this file has
 * no access to Node, the filesystem or the network.
 */
const api = window.myna;

const state = {
  accounts: [],
  networks: [],
  directories: [],
  targets: new Set(),
  media: [],
  graphicPath: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function status(message, kind = "") {
  const element = $("#status");
  element.textContent = message;
  element.className = `status ${kind}`;
  if (message) setTimeout(() => {
    if (element.textContent === message) element.textContent = "";
  }, 8000);
}

async function guard(fn, busyMessage) {
  try {
    if (busyMessage) status(busyMessage);
    return await fn();
  } catch (error) {
    status(error.message, "error");
    return undefined;
  }
}

/* ---------------------------------------------------------------- navigation */

for (const button of $$(".nav")) {
  button.addEventListener("click", () => {
    for (const other of $$(".nav")) other.removeAttribute("aria-current");
    button.setAttribute("aria-current", "true");
    for (const view of $$(".view")) view.hidden = view.dataset.view !== button.dataset.view;
    refresh(button.dataset.view);
  });
}

function refresh(view) {
  if (view === "accounts") renderAccounts();
  if (view === "directories") renderDirectories();
  if (view === "queue") renderQueue();
  if (view === "history") renderHistory();
  if (view === "settings") renderSettings();
}

/* ------------------------------------------------------------------ compose */

const textarea = $("#text");
let previewTimer = null;

textarea.addEventListener("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderTargets, 180);
});

async function renderTargets() {
  const list = $("#target-list");
  if (!state.accounts.length) {
    list.innerHTML = `<div class="note">No accounts yet. Connect one from the Accounts tab.</div>`;
    return;
  }

  const targets = [...state.targets];
  const preview = await guard(() => api.post.preview({ text: textarea.value, targets }));
  const byAccount = new Map((preview ?? []).map((entry) => [entry.account, entry]));

  list.innerHTML = "";
  for (const account of state.accounts) {
    const row = document.createElement("label");
    row.className = "target";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.targets.size === 0 || state.targets.has(account.id);
    box.addEventListener("change", () => {
      // An empty set means "everything", so the first change has to materialise it.
      if (!state.targets.size) state.targets = new Set(state.accounts.map((entry) => entry.id));
      if (box.checked) state.targets.add(account.id);
      else state.targets.delete(account.id);
      renderTargets();
    });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = account.id;
    name.title = account.id;

    const count = document.createElement("span");
    const entry = byAccount.get(account.id);
    if (entry) {
      const over = entry.limit && entry.used > entry.limit;
      count.className = `count${over ? " over" : entry.parts > 1 ? " thread" : ""}`;
      count.textContent = !textarea.value
        ? entry.limit ? `${entry.limit} max` : "no limit"
        : entry.parts > 1
          ? `thread of ${entry.parts}`
          : entry.limit
            ? `${entry.used}/${entry.limit}`
            : `${entry.used}`;
    } else {
      count.className = "count";
      count.textContent = "-";
    }

    row.append(box, name, count);
    list.append(row);
  }
}

$("#btn-all").addEventListener("click", () => {
  state.targets.clear();
  renderTargets();
});
$("#btn-none").addEventListener("click", () => {
  state.targets = new Set(["__none__"]);
  renderTargets();
});

$("#btn-attach").addEventListener("click", async () => {
  const paths = await guard(() => api.media.pick());
  if (paths?.length) {
    state.media.push(...paths);
    renderAttachments();
  }
});

function renderAttachments() {
  $("#attachments").innerHTML = state.media
    .map((path) => `<span class="chip">${escapeHtml(path.split("/").pop())}</span>`)
    .join("");
}

$("#btn-post").addEventListener("click", async () => {
  const text = textarea.value.trim();
  if (!text) return status("Nothing to post.", "error");

  const targets = [...state.targets].filter((id) => id !== "__none__");
  if (state.targets.has("__none__")) return status("No targets selected.", "error");

  $("#btn-post").disabled = true;
  const results = await guard(
    () => api.post.send({ text, title: $("#title").value.trim(), targets, mediaPaths: state.media }),
    "Posting...",
  );
  $("#btn-post").disabled = false;
  if (!results) return;

  const failed = results.filter((result) => !result.ok);
  status(
    failed.length
      ? `${results.length - failed.length}/${results.length} posted. Failed: ${failed.map((r) => r.account).join(", ")}`
      : `Posted to ${results.length} account${results.length === 1 ? "" : "s"}.`,
    failed.length ? "error" : "success",
  );
  if (!failed.length) {
    textarea.value = "";
    $("#title").value = "";
    state.media = [];
    state.graphicPath = null;
    $("#graphic-preview").hidden = true;
    renderAttachments();
    renderTargets();
  }
});

/* ------------------------------------------------------------------- writer */

$("#btn-draft").addEventListener("click", () => runWriter(false));
$("#btn-link").addEventListener("click", () => runWriter(true));

async function runWriter(fromLink) {
  const input = $("#ai-input").value.trim();
  if (!input) return status(fromLink ? "Paste a link first." : "What should it be about?", "error");

  const available = await guard(() => api.ai.available());
  if (!available?.ok) return status(available?.reason ?? "The writer is not configured.", "error");

  const networks = [...new Set(state.accounts
    .filter((account) => state.targets.size === 0 || state.targets.has(account.id))
    .map((account) => account.network))];

  const drafts = await guard(
    () => api.ai.draft(fromLink ? { url: input, networks } : { prompt: input }),
    fromLink ? "Reading the link..." : "Writing...",
  );
  if (!drafts?.length) return;

  const first = drafts[0];
  textarea.value = first.hashtags?.length ? `${first.text}\n\n${first.hashtags.join(" ")}` : first.text;
  $("#ai-note").textContent =
    drafts.length > 1
      ? `Drafted ${drafts.length} per-network variants; showing ${first.network || "the first"}. Edit before posting.`
      : "Drafted. Edit before posting.";
  renderTargets();
  status("Draft ready.", "success");
}

$("#btn-graphic").addEventListener("click", async () => {
  const input = $("#ai-input").value.trim() || textarea.value.trim();
  if (!input) return status("Give it a link or a topic first.", "error");

  const result = await guard(
    () => api.ai.infographic({ input, style: $("#graphic-style").value }),
    "Building the infographic...",
  );
  if (!result) return;

  state.graphicPath = result.path;
  state.media = [result.path];
  renderAttachments();

  const preview = $("#graphic-preview");
  preview.src = result.dataUrl;
  preview.hidden = false;

  if (!textarea.value.trim() && result.copy.caption) {
    const tags = result.copy.hashtags?.length ? `\n\n${result.copy.hashtags.join(" ")}` : "";
    textarea.value = `${result.copy.caption}${tags}`;
    renderTargets();
  }
  status("Infographic attached.", "success");
});

/* ----------------------------------------------------------------- accounts */

async function renderAccounts() {
  state.accounts = (await guard(() => api.accounts.list())) ?? [];
  const list = $("#account-list");

  if (!state.accounts.length) {
    list.innerHTML = `<div class="note">Nothing connected yet. "Connect an account" asks for whatever that network accepts.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const account of state.accounts) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<div><div class="title">${escapeHtml(account.id)}</div>` +
      `<div class="sub">${escapeHtml(account.displayName ?? "")}</div></div><div class="spacer"></div>`;

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "Disconnect";
    remove.addEventListener("click", async () => {
      await guard(() => api.accounts.logout(account.id));
      state.targets.delete(account.id);
      await renderAccounts();
      renderTargets();
      status(`Disconnected ${account.id}`, "success");
    });

    card.append(remove);
    list.append(card);
  }
  renderTargets();
}

$("#btn-add").addEventListener("click", async () => {
  if (!state.networks.length) state.networks = (await guard(() => api.networks())) ?? [];
  renderPicker("");
  $("#picker").showModal();
  $("#picker-filter").value = "";
  $("#picker-filter").focus();
});

$("#picker-filter").addEventListener("input", (event) => renderPicker(event.target.value));

const AUTH_LABEL = {
  password: "username + password",
  token: "paste a token",
  oauth1: "app keys",
  oauth2: "browser sign-in",
  device: "approve a code",
};

function renderPicker(filter) {
  const needle = filter.trim().toLowerCase();
  const list = $("#picker-list");
  list.innerHTML = "";

  for (const network of state.networks) {
    if (needle && !`${network.id} ${network.name} ${network.blurb}`.toLowerCase().includes(needle)) continue;
    const item = document.createElement("button");
    item.className = "picker-item";
    item.innerHTML =
      `<span>${escapeHtml(network.name)}</span>` +
      `<span class="how">${escapeHtml(AUTH_LABEL[network.auth.kind] ?? network.auth.kind)}</span>`;
    item.addEventListener("click", () => {
      $("#picker").close();
      openLogin(network);
    });
    list.append(item);
  }
}

// What the login dialog is currently connecting. A directory logs in exactly
// the way a network does — a few fields, then a call that verifies them — so
// the same dialog serves both, and `kind` decides only where it is saved.
let activeLogin = null;
let activeNetwork = null;

function openLogin(network, kind = "network") {
  activeNetwork = network;
  activeLogin = { kind, target: network };
  $("#login-title").textContent = `Connect ${network.name}`;
  $("#login-note").textContent = network.auth.note ?? "";
  const docs = $("#login-docs");
  docs.textContent = network.auth.docsUrl ? `Get the values here: ${network.auth.docsUrl}` : "";
  docs.href = network.auth.docsUrl ?? "#";
  docs.hidden = !network.auth.docsUrl;
  $("#login-progress").textContent = "";
  $("#login-error").textContent = "";

  const form = $("#login-form");
  form.innerHTML = "";
  for (const field of network.auth.fields) {
    const label = document.createElement("label");
    label.textContent = field.optional ? `${field.label} (optional)` : field.label;

    const input = document.createElement("input");
    input.type = field.secret ? "password" : "text";
    input.name = field.key;
    input.placeholder = field.placeholder ?? "";
    input.value = field.default ?? "";
    label.append(input);

    if (field.help) {
      const help = document.createElement("span");
      help.className = "note help";
      help.textContent = field.help;
      label.append(help);
    }
    form.append(label);
  }

  $("#login").showModal();
  form.querySelector("input")?.focus();
}

$("#login-submit").addEventListener("click", async () => {
  if (!activeNetwork) return;
  const values = {};
  for (const input of $$("#login-form input")) values[input.name] = input.value;

  for (const field of activeNetwork.auth.fields) {
    if (!field.optional && !values[field.key]?.trim()) {
      $("#login-error").textContent = `${field.label} is required.`;
      return;
    }
  }

  $("#login-submit").disabled = true;
  $("#login-error").textContent = "";
  try {
    if (activeLogin?.kind === "directory") {
      const account = await api.directories.login(activeNetwork.id, values);
      $("#login").close();
      await renderDirectories();
      status(`Connected ${account.directory} as ${account.handle}`, "success");
    } else {
      const account = await api.accounts.login(activeNetwork.id, values);
      $("#login").close();
      await renderAccounts();
      status(`Connected ${account.id}`, "success");
    }
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    $("#login-submit").disabled = false;
  }
});

/**
 * A sign-in that asks something mid-flow: SaaSRow mails a one-time code, a
 * device flow waits for a browser. Until this is answered the sign-in in the
 * main process is still waiting, so closing the box has to cancel it rather
 * than leave it hanging.
 */
let activeAsk = null;

api.onLoginAsk(({ id, prompt }) => {
  activeAsk = id;
  $("#ask-title").textContent = prompt;
  $("#ask-note").textContent = $("#login-progress").textContent.trim().split("\n").slice(-1)[0] ?? "";
  $("#ask-value").value = "";
  $("#askbox").showModal();
  $("#ask-value").focus();
});

function answerAsk(value) {
  if (activeAsk === null) return;
  if (value === null) api.cancelLogin(activeAsk);
  else api.answerLogin(activeAsk, value);
  activeAsk = null;
  $("#askbox").close();
}

$("#ask-submit").addEventListener("click", () => answerAsk($("#ask-value").value.trim()));
$("#ask-cancel").addEventListener("click", () => answerAsk(null));
$("#ask-value").addEventListener("keydown", (event) => {
  if (event.key === "Enter") answerAsk($("#ask-value").value.trim());
});
// Escape closes a <dialog> without a click, and a cancelled question that is
// never answered leaves the sign-in waiting forever.
$("#askbox").addEventListener("close", () => answerAsk(null));

api.onLoginProgress((message) => {
  const box = $("#login-progress");
  box.textContent += `${message}\n`;
  box.scrollTop = box.scrollHeight;
});

api.onSchedulerRan(({ id, summary }) => status(`Scheduler sent ${id}: ${summary}`, "success"));

/* -------------------------------------------------------------------- queue */

$("#btn-schedule").addEventListener("click", () => {
  if (!textarea.value.trim()) return status("Write the post first.", "error");
  const when = new Date(Date.now() + 3600_000);
  // datetime-local wants a local-time string with no zone suffix.
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  $("#schedule-at").value = local;
  $("#schedule").showModal();
});

$("#schedule-submit").addEventListener("click", async () => {
  const at = $("#schedule-at").value;
  if (!at) return;
  const targets = [...state.targets].filter((id) => id !== "__none__");
  const entry = await guard(() =>
    api.queue.add({ text: textarea.value.trim(), title: $("#title").value.trim(), targets, at, mediaPaths: state.media }),
  );
  $("#schedule").close();
  if (entry) {
    textarea.value = "";
    state.media = [];
    renderAttachments();
    renderTargets();
    status(`Queued ${entry.id}`, "success");
  }
});

async function renderQueue() {
  const posts = (await guard(() => api.queue.list())) ?? [];
  const list = $("#queue-list");

  if (!posts.length) {
    list.innerHTML = `<div class="note">Nothing scheduled.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const post of posts) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<div><div class="title">${escapeHtml(post.text.slice(0, 70))}</div>` +
      `<div class="sub">${new Date(post.scheduledFor).toLocaleString()} · ${post.status} · ${post.targets.length} account(s)</div></div>` +
      `<div class="spacer"></div>`;

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "Cancel";
    remove.addEventListener("click", async () => {
      await guard(() => api.queue.remove(post.id));
      renderQueue();
    });
    card.append(remove);
    list.append(card);
  }
}

/* ------------------------------------------------------------------ history */

async function renderHistory() {
  const entries = (await guard(() => api.history())) ?? [];
  const list = $("#history-list");

  if (!entries.length) {
    list.innerHTML = `<div class="note">Nothing posted yet.</div>`;
    return;
  }

  list.innerHTML = entries
    .map(
      (entry) =>
        `<div class="row ${entry.ok ? "ok" : "fail"}">` +
        `<span class="badge">${entry.ok ? "ok" : "fail"}</span>` +
        `<span class="when">${new Date(entry.at).toLocaleString()}</span>` +
        `<span class="who">${escapeHtml(entry.accountId)}</span>` +
        `<span class="what">${escapeHtml(entry.error ?? entry.text)}</span>` +
        `</div>`,
    )
    .join("");
}

/* ----------------------------------------------------------------- settings */

async function renderSettings() {
  const settings = await guard(() => api.settings.get());
  const doctor = await guard(() => api.doctor());
  if (!settings) return;

  const form = $("#settings-form");
  form.innerHTML = "";

  const fields = [
    { key: "ai.provider", label: "Writer provider", options: ["anthropic", "openai", "ollama"] },
    { key: "ai.model", label: "Model" },
    { key: "ai.voice", label: "Voice" },
    { key: "ai.maxHashtags", label: "Hashtags per post", type: "number" },
    { key: "signature", label: "Signature appended to every post" },
    { key: "infographic.accent", label: "Infographic accent colour" },
  ];

  for (const field of fields) {
    const label = document.createElement("label");
    label.textContent = field.label;

    const value = field.key.split(".").reduce((object, part) => object?.[part], settings);
    const input = field.options
      ? Object.assign(document.createElement("select"), { innerHTML: field.options.map((option) => `<option${option === value ? " selected" : ""}>${option}</option>`).join("") })
      : Object.assign(document.createElement("input"), { type: field.type ?? "text", value: value ?? "" });

    input.addEventListener("change", async () => {
      const path = field.key.split(".");
      let target = settings;
      for (const part of path.slice(0, -1)) target = target[part];
      const leaf = path[path.length - 1];
      target[leaf] = field.type === "number" ? Number(input.value) : input.value;
      await guard(() => api.settings.set(settings));
      status("Saved.", "success");
    });

    label.append(input);
    form.append(label);
  }

  $("#doctor").textContent = doctor
    ? [
        `config       ${doctor.configDir}`,
        `networks     ${doctor.networks}`,
        `rasterizers  ${doctor.rasterizers.join(", ") || "none found"}`,
        `writer       ${doctor.ai.ok ? "ready" : doctor.ai.reason}`,
      ].join("\n")
    : "";
}

/* -------------------------------------------------------------- directories */

/**
 * Directories list the product; the rest of the app posts about it. They are a
 * separate screen for that reason, and submitting is two steps — read the page,
 * then look at what would be sent — because a listing is public and a person
 * reviews it.
 */
async function renderDirectories() {
  state.directories = (await guard(() => api.directories.list())) ?? [];
  const list = $("#directory-list");
  list.innerHTML = "";

  for (const directory of state.directories) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      `<div><div class="title">${escapeHtml(directory.name)}</div>` +
      `<div class="sub">${escapeHtml(directory.connected ? directory.handle : directory.blurb)}</div></div>` +
      `<div class="spacer"></div>`;

    const button = document.createElement("button");
    button.className = directory.connected ? "ghost" : "primary";
    button.textContent = directory.connected ? "Disconnect" : "Connect";
    button.addEventListener("click", async () => {
      if (!directory.connected) {
        openLogin(directory, "directory");
        return;
      }
      await guard(() => api.directories.logout(directory.id));
      await renderDirectories();
      status(`Forgot ${directory.id}`, "success");
    });

    card.append(button);
    list.append(card);
  }

  await renderListings();
}

async function renderListings() {
  const list = $("#listing-list");
  const connected = (state.directories ?? []).some((directory) => directory.connected);
  if (!connected) {
    list.innerHTML = `<div class="note">Connect a directory to submit a product to it.</div>`;
    return;
  }

  const listings = (await guard(() => api.directories.listings())) ?? [];
  if (!listings.length) {
    list.innerHTML = `<div class="note">Nothing listed yet. Paste the product's URL above.</div>`;
    return;
  }

  list.innerHTML = "";
  for (const listing of listings) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      `<div class="title">${escapeHtml(listing.name)}</div>` +
      `<div class="sub">${escapeHtml(listing.directory)} · ${escapeHtml(listing.status ?? "listed")} · ` +
      `${escapeHtml(listing.url ?? listing.website)}</div>`;
    list.append(row);
  }
}

/** The listing fields shown before anything is sent, and edited in place. */
const LISTING_FIELDS = [
  { key: "name", label: "Name" },
  { key: "website", label: "Website" },
  { key: "category", label: "Category" },
  { key: "tags", label: "Tags", list: true },
  { key: "description", label: "Description", area: true },
];

let pendingListing = null;

$("#btn-directory-preview").addEventListener("click", async () => {
  const url = $("#directory-url").value.trim();
  if (!url) return status("Paste the product's URL first.", "error");

  const connected = (state.directories ?? []).filter((directory) => directory.connected);
  if (!connected.length) return status("Connect a directory first.", "error");
  // One connected directory is the common case; more than one is a choice, and
  // the first is a poor guess to make silently.
  const directory = connected[0];

  const built = await guard(() => api.directories.preview(directory.id, url), `Reading ${url}…`);
  if (!built) return;

  pendingListing = { directory: directory.id, listing: built.listing };
  $("#listing-title").textContent = `Submit to ${directory.name}?`;
  $("#listing-note").textContent =
    built.describedBy === "ai"
      ? "Written by myna's writer from the page. Edit anything that is wrong."
      : "Taken from the page's own metadata. Edit anything that is wrong.";
  $("#listing-error").textContent = "";

  const form = $("#listing-form");
  form.innerHTML = "";
  for (const field of LISTING_FIELDS) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement(field.area ? "textarea" : "input");
    input.name = field.key;
    const value = built.listing[field.key];
    input.value = Array.isArray(value) ? value.join(", ") : (value ?? "");
    label.append(input);
    form.append(label);
  }

  $("#listingbox").showModal();
});

$("#listing-submit").addEventListener("click", async () => {
  if (!pendingListing) return;
  const listing = { ...pendingListing.listing };
  for (const input of $$("#listing-form input, #listing-form textarea")) {
    const field = LISTING_FIELDS.find((entry) => entry.key === input.name);
    const value = input.value.trim();
    if (field?.list) listing[input.name] = value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
    else listing[input.name] = value || undefined;
  }

  $("#listing-submit").disabled = true;
  $("#listing-error").textContent = "";
  try {
    const submitted = await api.directories.submit(pendingListing.directory, listing);
    $("#listingbox").close();
    $("#directory-url").value = "";
    pendingListing = null;
    await renderListings();
    status(`Submitted ${submitted.name}`, "success");
  } catch (error) {
    $("#listing-error").textContent = error.message;
  } finally {
    $("#listing-submit").disabled = false;
  }
});

/* -------------------------------------------------------------------- misc */

for (const button of $$("[data-close]")) {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    button.closest("dialog").close();
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

(async function init() {
  state.networks = (await guard(() => api.networks())) ?? [];
  await renderAccounts();
})();
