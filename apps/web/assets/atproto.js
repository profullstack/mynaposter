// The atproto directory: read the hosted list once the page is open.
(async () => {
  const status = document.getElementById("status");
  const table = document.getElementById("servers");
  const body = table.querySelector("tbody");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  try {
    const reply = await fetch(document.querySelector("main.dir").dataset.api + "/v1/atproto", { headers: { accept: "application/json" } });
    const data = await reply.json();
    if (!data.ok) throw new Error(data.error || "no answer");
    if (!data.servers.length) { status.textContent = "Nothing listed yet. Be the first: myna atproto add <url>."; return; }
    for (const s of data.servers) {
      const tr = document.createElement("tr");
      const what = s.kind === "pds" ? (s.userDomains.length ? s.userDomains.map((d) => "<code>" + esc(d) + "</code>").join(" ") : "no handle domains") : esc(s.name || s.did || s.description || "");
      const signup = s.kind !== "pds" ? "" : s.inviteCodeRequired === false ? "open" : s.inviteCodeRequired === true ? "invite code" : "unknown";
      tr.innerHTML = '<td class="' + (s.online ? "on" : "off") + '">' + (s.online ? "&#9679;" : "&#9675;") + '</td><td class="kind">' + esc(s.kind) + '</td><td><a href="' + esc(s.url) + '" rel="nofollow noopener">' + esc(s.url.replace(/^https?:\/\//, "")) + '</a>' + (s.description ? '<br><span class="fineprint">' + esc(s.description) + '</span>' : '') + '</td><td>' + what + '</td><td>' + signup + '</td><td class="fineprint">' + (s.seenAt ? esc(s.seenAt.slice(0, 16).replace("T", " ")) : "never") + '</td>';
      body.appendChild(tr);
    }
    status.textContent = data.servers.length + " server" + (data.servers.length === 1 ? "" : "s") + ", " + data.servers.filter((s) => s.online).length + " online.";
    table.hidden = false;
  } catch (error) {
    status.textContent = "The directory could not be read: " + error.message;
  }
})();
