// mynaposter.com/dashboard: sign in, see the hand-off cards waiting on you, copy, open, mark done.
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
    signin.hidden = false;
    signinNote.textContent = message || "";
    cards = [];
    list.textContent = "";
    byId("email").focus();
  }

  async function paintSignedIn(email) {
    status.hidden = true;
    signin.hidden = true;
    board.hidden = false;
    who.textContent = email;
    who.hidden = false;
    signout.hidden = false;
    await load();
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

  signout.addEventListener("click", async () => {
    try {
      await call("/v1/cloud/session", { method: "DELETE", quiet401: true });
    } catch {
      // Signed out here either way.
    }
    paintSignedOut("Signed out.");
  });

  showDone.addEventListener("change", load);
  refresh.addEventListener("click", load);

  (async () => {
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
