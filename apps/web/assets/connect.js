// mynaposter.com/connect: sign in, make a setup token, see and revoke the apps holding one.
(async () => {
  const main = document.querySelector("main.connect");
  const api = (main && main.dataset.api) || "/api";
  const byId = (name) => document.getElementById(name);
  const KEY = "myna.cloud";

  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  };
  const write = (session) => {
    try {
      if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
      else sessionStorage.removeItem(KEY);
    } catch {
      // Private mode. The page still works for this visit.
    }
  };

  let session = read();

  const call = async (path, options = {}) => {
    const headers = { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(session ? { authorization: "Bearer " + session.token } : {}) };
    const reply = await fetch(api + path, { method: options.method || (options.body ? "POST" : "GET"), headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const data = await reply.json().catch(() => ({}));
    if (reply.status === 401 && session) {
      session = null;
      write(null);
      paintSignedOut();
    }
    if (!reply.ok || data.ok === false) throw new Error(data.error || data.message || "HTTP " + reply.status);
    return data;
  };

  const signinNote = byId("signin-note");
  const appsNote = byId("apps-note");

  function paintSignedOut() {
    byId("signin").hidden = false;
    byId("account").hidden = true;
  }

  async function paintSignedIn() {
    byId("signin").hidden = true;
    byId("account").hidden = false;
    byId("who").textContent = session.email;
    await Promise.all([paintScopes(), paintApps()]);
  }

  let scopesPainted = false;
  async function paintScopes() {
    if (scopesPainted) return;
    const fieldset = byId("scopes");
    let scopes = {};
    try {
      const reply = await fetch("/.well-known/openconnection.json", { headers: { accept: "application/json" } });
      scopes = (await reply.json()).scopes || {};
    } catch {
      scopes = {};
    }
    for (const [name, line] of Object.entries(scopes)) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = "scope";
      box.value = name;
      box.checked = true;
      label.appendChild(box);
      const code = document.createElement("code");
      code.textContent = name;
      label.appendChild(code);
      label.appendChild(document.createTextNode(" " + line));
      fieldset.appendChild(label);
    }
    scopesPainted = true;
  }

  async function paintApps() {
    const list = byId("apps");
    list.textContent = "";
    let apps = [];
    try {
      apps = (await call("/v1/openconnection/apps")).apps || [];
    } catch (error) {
      appsNote.textContent = "Could not read the list: " + error.message;
      return;
    }
    byId("apps-empty").hidden = apps.length > 0;
    for (const app of apps) {
      const li = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = (app.app && app.app.name) || "An unnamed app";
      li.appendChild(name);
      if (app.app && app.app.url) {
        li.appendChild(document.createTextNode(" "));
        const a = document.createElement("a");
        a.href = app.app.url;
        a.rel = "noopener";
        a.target = "_blank";
        a.textContent = new URL(app.app.url).hostname;
        li.appendChild(a);
      }
      const meta = document.createElement("div");
      meta.className = "fineprint";
      meta.textContent =
        "Connected " + new Date(app.issuedAt).toLocaleString() + (app.lastUsedAt ? ", last used " + new Date(app.lastUsedAt).toLocaleString() : ", never used") + ". Scopes: " + app.scopes.join(", ") + ".";
      li.appendChild(meta);
      if (app.reclaims > 0) {
        const warn = document.createElement("div");
        warn.className = "warn";
        warn.textContent = "Its setup token was claimed again " + app.reclaims + (app.reclaims === 1 ? " time" : " times") + " after it was used. Someone else saw that token; revoke this and make a new one.";
        li.appendChild(warn);
      }
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.className = "quiet";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await call("/v1/openconnection/apps/" + encodeURIComponent(app.id), { method: "DELETE" });
          appsNote.textContent = "Revoked. Its next call is refused.";
          await paintApps();
        } catch (error) {
          appsNote.textContent = "Could not revoke: " + error.message;
          revoke.disabled = false;
        }
      });
      li.appendChild(revoke);
      list.appendChild(li);
    }
  }

  async function signIn(path) {
    const email = byId("email").value.trim();
    const password = byId("password").value;
    signinNote.textContent = "";
    if (!email || !password) {
      signinNote.textContent = "Email and password, please.";
      return;
    }
    try {
      const data = await call(path, { body: { email, password } });
      session = { email: data.email, token: data.token };
      write(session);
      await paintSignedIn();
    } catch (error) {
      signinNote.textContent = error.message;
    }
  }

  byId("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void signIn("/v1/cloud/login");
  });
  byId("signup").addEventListener("click", () => void signIn("/v1/cloud/signup"));
  byId("logout").addEventListener("click", async () => {
    try {
      await call("/v1/cloud/logout", { method: "POST" });
    } catch {
      // The session is forgotten here either way.
    }
    session = null;
    write(null);
    paintSignedOut();
  });

  byId("make").addEventListener("click", async () => {
    const scopes = Array.from(document.querySelectorAll('input[name="scope"]:checked')).map((box) => box.value);
    const minutes = Number(byId("minutes").value) || 15;
    byId("make").disabled = true;
    try {
      const data = await call("/v1/openconnection/setup", { body: { scopes, minutes } });
      byId("token").value = data.token;
      byId("expires").textContent = "Expires " + new Date(data.expires).toLocaleTimeString();
      byId("token-block").hidden = false;
      byId("copy-note").textContent = "";
    } catch (error) {
      byId("copy-note").textContent = error.message;
      byId("token-block").hidden = false;
    } finally {
      byId("make").disabled = false;
    }
  });

  byId("copy").addEventListener("click", async () => {
    const token = byId("token");
    try {
      await navigator.clipboard.writeText(token.value);
      byId("copy-note").textContent = "Copied. Paste it into the app within the time shown.";
    } catch {
      token.focus();
      token.select();
      byId("copy-note").textContent = "Select and copy the token above.";
    }
  });

  if (session) {
    try {
      const me = await call("/v1/cloud/me");
      session.email = me.email || session.email;
      await paintSignedIn();
    } catch {
      paintSignedOut();
    }
  } else {
    paintSignedOut();
  }
})();
