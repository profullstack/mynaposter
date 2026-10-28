// mynaposter.com/dashboard: sign in, see the hand-off cards waiting on you, copy, open, mark done;
// and manage your webhooks.
//
// The session is an HttpOnly cookie set by POST /api/v1/cloud/session. This
// script never sees the token: it only learns whether the cookie works, from
// GET /api/v1/cloud/me. Nothing is kept in web storage.
(() => {
  const main = document.querySelector("main.dash");
  const api = (main && main.dataset.api) || "/api";
  const byId = (name) => document.getElementById(name);

  const status = byId("status");
  const signin = byId("signin");
  const board = byId("board");
  const who = byId("who");
  const signout = byId("signout");
  const form = byId("signin-form");
  const signinNote = byId("signin-note");
  const boardNote = byId("board-note");
  const list = byId("cards");
  const empty = byId("empty");
  const showDone = byId("show-done");
  const refresh = byId("refresh");
  const forgot = byId("forgot");
  const forgotForm = byId("forgot-form");
  const forgotNote = byId("forgot-note");
  const reset = byId("reset");
  const resetForm = byId("reset-form");
  const resetNote = byId("reset-note");
  const hooksSection = byId("webhooks");

  // A reset link is /dashboard#reset=<token>: the token rides in the fragment
  // so no server log sees it. Read it once and take it out of the address bar.
  let resetToken = "";
  const takeResetToken = () => {
    if (!location.hash.startsWith("#reset=")) return false;
    try {
      resetToken = decodeURIComponent(location.hash.slice(7));
    } catch {
      resetToken = location.hash.slice(7);
    }
    history.replaceState(null, "", location.pathname + location.search);
    return true;
  };
  takeResetToken();

  let cards = [];

  const call = async (path, options = {}) => {
    const headers = { accept: "application/json" };
    if (options.body) headers["content-type"] = "application/json";
    const reply = await fetch(api + path, {
      method: options.method || (options.body ? "POST" : "GET"),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await reply.json().catch(() => ({}));
    if (reply.status === 401 && !options.quiet401) {
      paintSignedOut("Your session ended. Sign in again.");
      throw new Error("signed out");
    }
    if (!reply.ok || data.ok === false) {
      const error = new Error(data.error || "HTTP " + reply.status);
      error.status = reply.status;
      throw error;
    }
    return data;
  };

  function paintSignedOut(message) {
    status.hidden = true;
    board.hidden = true;
    who.hidden = true;
    signout.hidden = true;
    forgot.hidden = true;
    reset.hidden = true;
    signin.hidden = false;
    hooksSection.hidden = true;
    signinNote.textContent = message || "";
    cards = [];
    list.textContent = "";
    byId("email").focus();
  }

  async function paintSignedIn(email) {
    status.hidden = true;
    signin.hidden = true;
    forgot.hidden = true;
    reset.hidden = true;
    board.hidden = false;
    hooksSection.hidden = false;
    who.textContent = email;
    who.hidden = false;
    signout.hidden = false;
    await Promise.all([load(), loadHooks()]);
  }

  const when = (iso) => {
    const date = new Date(iso);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) +
      ", " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function renderCard(card) {
    const item = el("li", "hcard" + (card.doneAt ? " done" : ""));
    item.dataset.id = card.id;
    const details = el("details");
    const summary = el("summary");
    summary.appendChild(el("span", "place", card.place));
    const line = el("span", "line");
    line.appendChild(el("span", "title", card.title));
    const time = el("time", "date", (card.doneAt ? "done " + when(card.doneAt) : when(card.createdAt)));
    time.dateTime = card.doneAt || card.createdAt;
    line.appendChild(time);
    summary.appendChild(line);
    details.appendChild(summary);

    const body = el("div", "body");
    if (card.account) body.appendChild(el("p", "fineprint", "From " + card.account));
    const textId = "text-" + card.id;
    const label = el("label", "block-head");
    label.htmlFor = textId;
    label.appendChild(el("span", null, "Text to paste"));
    label.appendChild(el("span", null, card.text.length + " characters"));
    body.appendChild(label);
    const text = el("textarea");
    text.id = textId;
    text.readOnly = true;
    text.spellcheck = false;
    text.value = card.text;
    text.rows = Math.min(14, Math.max(4, card.text.split("\n").length + 1));
    body.appendChild(text);

    if (card.steps && card.steps.length) {
      const steps = el("ol", "steps");
      for (const step of card.steps) steps.appendChild(el("li", null, step));
      body.appendChild(steps);
    }

    const actions = el("div", "actions");
    const note = el("span", "note");
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");

    const copy = el("button", null, "Copy");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(card.text);
        note.textContent = "Copied.";
      } catch {
        text.focus();
        text.select();
        note.textContent = "Selected. Copy it by hand.";
      }
    });
    actions.appendChild(copy);

    if (card.openUrl && /^https?:\/\//i.test(card.openUrl)) {
      const open = el("a", "button-link", "Open " + hostOf(card.openUrl));
      open.href = card.openUrl;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      actions.appendChild(open);
    }

    const toggle = el("button", "quiet", card.doneAt ? "Undo" : "Mark done");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      const done = !card.doneAt;
      toggle.disabled = true;
      try {
        const data = await call("/v1/handoff/" + encodeURIComponent(card.id) + "/done", { body: { done } });
        const index = cards.findIndex((entry) => entry.id === card.id);
        if (index !== -1) cards[index] = data.handoff;
        boardNote.textContent = (done ? "Done: " : "Open again: ") + card.title;
        render();
      } catch (error) {
        if (error.message !== "signed out") note.textContent = "Not saved: " + error.message;
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);

    const page = el("a", "card-link", "Card page");
    page.href = "/handoff/" + encodeURIComponent(card.id);
    actions.appendChild(page);
    actions.appendChild(note);
    body.appendChild(actions);

    details.appendChild(body);
    item.appendChild(details);
    return item;
  }

  function render() {
    const open = new Set(Array.from(list.querySelectorAll("details[open]")).map((node) => node.parentElement.dataset.id));
    const visible = showDone.checked ? cards : cards.filter((card) => !card.doneAt);
    // Open cards first, newest first, then the done ones newest first.
    visible.sort((a, b) => (a.doneAt ? 1 : 0) - (b.doneAt ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));
    list.textContent = "";
    for (const card of visible) {
      const node = renderCard(card);
      if (open.has(card.id)) node.querySelector("details").open = true;
      list.appendChild(node);
    }
    const waiting = cards.filter((card) => !card.doneAt).length;
    byId("board-title").textContent = waiting ? "Waiting on you (" + waiting + ")" : "Waiting on you";
    empty.hidden = waiting !== 0;
    list.hidden = visible.length === 0;
  }

  async function load() {
    refresh.disabled = true;
    try {
      const data = await call("/v1/handoff" + (showDone.checked ? "?all=1" : ""));
      cards = data.handoffs || [];
      render();
    } catch (error) {
      if (error.message !== "signed out") boardNote.textContent = "Could not read your cards: " + error.message;
    } finally {
      refresh.disabled = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = byId("email").value.trim();
    const password = byId("password").value;
    if (!email || !password) {
      signinNote.textContent = "Email and password, both.";
      return;
    }
    const button = byId("signin-button");
    button.disabled = true;
    signinNote.textContent = "";
    try {
      const data = await call("/v1/cloud/session", { body: { email, password }, quiet401: true });
      byId("password").value = "";
      await paintSignedIn(data.email);
    } catch (error) {
      signinNote.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  byId("forgot-link").addEventListener("click", () => {
    signin.hidden = true;
    forgot.hidden = false;
    forgotNote.textContent = "";
    byId("forgot-email").value = byId("email").value.trim();
    byId("forgot-email").focus();
  });

  byId("forgot-back").addEventListener("click", () => paintSignedOut());

  forgotForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = byId("forgot-email").value.trim();
    if (!email) {
      forgotNote.textContent = "Your email, please.";
      return;
    }
    const button = byId("forgot-button");
    button.disabled = true;
    forgotNote.textContent = "";
    try {
      await call("/v1/cloud/password/forgot", { body: { email }, quiet401: true });
      forgotNote.textContent = "If " + email + " has a myna cloud account, a reset link is on its way. Check your inbox (and spam) in a minute.";
    } catch (error) {
      forgotNote.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function paintReset() {
    status.hidden = true;
    signin.hidden = true;
    forgot.hidden = true;
    board.hidden = true;
    reset.hidden = false;
    hooksSection.hidden = true;
    byId("new-password").focus();
  }

  resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = byId("new-password").value;
    const again = byId("new-password-again").value;
    if (password.length < 10) {
      resetNote.textContent = "Use a password of at least 10 characters.";
      return;
    }
    if (password !== again) {
      resetNote.textContent = "The two passwords do not match.";
      return;
    }
    const button = byId("reset-button");
    button.disabled = true;
    resetNote.textContent = "";
    try {
      const data = await call("/v1/cloud/password/reset", { body: { token: resetToken, password }, quiet401: true });
      resetToken = "";
      byId("new-password").value = "";
      byId("new-password-again").value = "";
      await paintSignedIn(data.email);
      boardNote.textContent = "Password changed. You are signed in here; sign in again everywhere else.";
    } catch (error) {
      resetNote.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  // The link opened in a tab already on /dashboard changes only the hash, not the page.
  window.addEventListener("hashchange", () => {
    if (takeResetToken()) paintReset();
  });

  signout.addEventListener("click", async () => {
    try {
      await call("/v1/cloud/session", { method: "DELETE", quiet401: true });
    } catch {
      // Signed out here either way.
    }
    paintSignedOut("Signed out.");
  });

  // ------------------------------------------------------------ webhooks
  //
  // The /api/v1/webhooks API. Reads ride the session cookie like the cards;
  // writes do too, because the API takes the cookie on a write only when the
  // request's Origin is this site.
  const hooksList = byId("hooks");
  const hooksEmpty = byId("hooks-empty");
  const hooksNote = byId("hooks-note");
  const hookForm = byId("hook-form");
  const hookFormNote = byId("hook-form-note");
  const hookEvents = byId("hook-events");
  const secretBox = byId("hook-secret");
  let eventTypes = [];

  const hookPath = (id, rest) => "/v1/webhooks" + (id ? "/" + encodeURIComponent(id) : "") + (rest || "");

  function showSecret(url, secret) {
    byId("hook-secret-url").textContent = url;
    byId("hook-secret-value").textContent = secret;
    secretBox.hidden = false;
  }

  byId("hook-secret-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(byId("hook-secret-value").textContent);
      hooksNote.textContent = "Secret copied.";
    } catch {
      hooksNote.textContent = "Select the secret and copy it by hand.";
    }
  });
  byId("hook-secret-hide").addEventListener("click", () => {
    secretBox.hidden = true;
    byId("hook-secret-value").textContent = "";
  });

  function paintEventChoices() {
    if (hookEvents.querySelector("input")) return;
    for (const type of eventTypes) {
      const label = el("label", "toggle");
      const box = el("input");
      box.type = "checkbox";
      box.value = type;
      label.appendChild(box);
      label.appendChild(document.createTextNode(" " + type));
      hookEvents.appendChild(label);
    }
  }

  function renderDeliveries(target, rows) {
    target.textContent = "";
    if (!rows.length) {
      target.appendChild(el("li", "fineprint", "No deliveries yet."));
      return;
    }
    for (const row of rows) {
      const result = row.last_status !== null && row.last_status !== undefined ? "HTTP " + row.last_status : row.last_error || "";
      target.appendChild(el("li", null, when(row.created_at) + "  " + row.event_type + "  " + row.status + (row.attempts ? " after " + row.attempts + " tr" + (row.attempts === 1 ? "y" : "ies") : "") + (result ? "  (" + result + ")" : "")));
    }
  }

  function renderHook(endpoint) {
    const item = el("li", "hcard" + (endpoint.enabled ? "" : " done"));
    const details = el("details");
    const summary = el("summary");
    summary.appendChild(el("span", "place", endpoint.enabled ? "on" : "off" + (endpoint.disabled_reason ? ": " + endpoint.disabled_reason : "")));
    const line = el("span", "line");
    line.appendChild(el("span", "title", endpoint.url));
    line.appendChild(el("span", "date", endpoint.events.join(", ")));
    summary.appendChild(line);
    details.appendChild(summary);

    const body = el("div", "body");
    if (endpoint.description) body.appendChild(el("p", "fineprint", endpoint.description));
    if (endpoint.failures) body.appendChild(el("p", "fineprint", endpoint.failures + " failed in a row"));
    const actions = el("div", "actions");
    const note = el("span", "note");
    note.setAttribute("role", "status");
    note.setAttribute("aria-live", "polite");
    const log = el("ol", "steps deliveries");

    const button = (label, quiet, run) => {
      const node = el("button", quiet ? "quiet" : null, label);
      node.type = "button";
      node.addEventListener("click", async () => {
        node.disabled = true;
        try {
          await run();
        } catch (error) {
          if (error.message !== "signed out") note.textContent = error.message;
        } finally {
          node.disabled = false;
        }
      });
      actions.appendChild(node);
      return node;
    };

    button("Send test", false, async () => {
      // A failed test answers {ok: false, error}, which call() throws as the error.
      try {
        const result = await call(hookPath(endpoint.id, "/test"), { method: "POST", body: {} });
        note.textContent = "Delivered: HTTP " + result.status;
      } catch (error) {
        if (error.message === "signed out") throw error;
        note.textContent = "Not delivered: " + error.message;
      }
      renderDeliveries(log, (await call(hookPath(endpoint.id, "/deliveries?limit=10"))).deliveries || []);
    });
    button("Deliveries", true, async () => {
      renderDeliveries(log, (await call(hookPath(endpoint.id, "/deliveries?limit=20"))).deliveries || []);
    });
    button(endpoint.enabled ? "Turn off" : "Turn on", true, async () => {
      await call(hookPath(endpoint.id), { method: "PATCH", body: { enabled: !endpoint.enabled } });
      await loadHooks();
    });
    button("New secret", true, async () => {
      if (!confirm("Replace the signing secret? The old one stops working now.")) return;
      const result = await call(hookPath(endpoint.id, "/rotate"), { method: "POST", body: {} });
      showSecret(endpoint.url, result.secret);
    });
    button("Remove", true, async () => {
      if (!confirm("Remove " + endpoint.url + "?")) return;
      await call(hookPath(endpoint.id), { method: "DELETE" });
      hooksNote.textContent = "Removed " + endpoint.url;
      await loadHooks();
    });
    actions.appendChild(note);
    body.appendChild(actions);
    body.appendChild(log);
    details.appendChild(body);
    item.appendChild(details);
    return item;
  }

  async function loadHooks() {
    try {
      const data = await call(hookPath());
      eventTypes = data.event_types || [];
      paintEventChoices();
      const endpoints = data.endpoints || [];
      hooksList.textContent = "";
      for (const endpoint of endpoints) hooksList.appendChild(renderHook(endpoint));
      hooksList.hidden = endpoints.length === 0;
      hooksEmpty.hidden = endpoints.length !== 0;
    } catch (error) {
      if (error.message !== "signed out") hooksNote.textContent = "Could not read your webhooks: " + error.message;
    }
  }

  hookForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = byId("hook-url").value.trim();
    if (!/^https:\/\//i.test(url)) {
      hookFormNote.textContent = "An https URL, please.";
      return;
    }
    const events = Array.from(hookEvents.querySelectorAll("input:checked")).map((box) => box.value);
    const description = byId("hook-description").value.trim();
    const button = byId("hook-add");
    button.disabled = true;
    hookFormNote.textContent = "";
    try {
      const created = await call(hookPath(), { body: { url, events: events.length ? events : undefined, description: description || undefined } });
      showSecret(created.endpoint.url, created.secret);
      byId("hook-url").value = "";
      byId("hook-description").value = "";
      for (const box of hookEvents.querySelectorAll("input:checked")) box.checked = false;
      await loadHooks();
    } catch (error) {
      if (error.message !== "signed out") hookFormNote.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  showDone.addEventListener("change", load);
  refresh.addEventListener("click", load);

  (async () => {
    if (resetToken) {
      paintReset();
      return;
    }
    try {
      const me = await call("/v1/cloud/me", { quiet401: true });
      await paintSignedIn(me.email);
    } catch (error) {
      if (error.status === 401) paintSignedOut();
      else {
        status.textContent = "myna cloud is not answering: " + error.message;
      }
    }
  })();
})();
