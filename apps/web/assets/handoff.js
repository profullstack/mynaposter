// The hand-off card: read it, copy it, open the page, mark it done.
(async () => {
  const main = document.querySelector("main.handoff");
  const status = document.getElementById("status");
  const card = document.getElementById("card");
  const api = (main && main.dataset.api) || "/api";
  const id = (location.pathname.match(/^\/handoff\/([A-Za-z0-9_-]+)/) || [])[1];
  if (!id) {
    status.textContent = "This is not a card link.";
    return;
  }

  const byId = (name) => document.getElementById(name);
  const text = byId("text");
  const done = byId("done");
  const note = byId("note");

  function paint(handoff) {
    byId("place").textContent = handoff.place;
    if (handoff.account) {
      byId("account").textContent = handoff.account;
      byId("account-wrap").hidden = false;
    }
    byId("title").textContent = handoff.title;
    text.value = handoff.text;
    byId("count").textContent = handoff.text.length + " characters";
    const open = byId("open");
    if (handoff.openUrl) {
      open.href = handoff.openUrl;
      let host = handoff.openUrl;
      try {
        host = new URL(handoff.openUrl).hostname.replace(/^www\./, "");
      } catch {
        // Shown as given.
      }
      open.textContent = "Open " + host;
      open.hidden = false;
    }
    const steps = byId("steps");
    steps.textContent = "";
    for (const step of handoff.steps || []) {
      const li = document.createElement("li");
      li.textContent = step;
      steps.appendChild(li);
    }
    steps.hidden = !(handoff.steps && handoff.steps.length);
    const isDone = Boolean(handoff.doneAt);
    card.classList.toggle("done", isDone);
    done.textContent = isDone ? "Mark not done" : "Mark done";
    byId("meta").textContent =
      "Made " + new Date(handoff.createdAt).toLocaleString() + (isDone ? ", done " + new Date(handoff.doneAt).toLocaleString() : "") + ".";
    card.hidden = false;
    status.hidden = true;
  }

  let current;
  try {
    const reply = await fetch(api + "/v1/handoff/" + encodeURIComponent(id), { headers: { accept: "application/json" } });
    const data = await reply.json();
    if (!data.ok) throw new Error(data.error || "no such card");
    current = data.handoff;
    paint(current);
  } catch (error) {
    status.textContent = "The card could not be read: " + error.message;
    return;
  }

  text.addEventListener("input", () => {
    byId("count").textContent = text.value.length + " characters";
  });

  byId("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      note.textContent = "Copied. Now paste it there.";
    } catch {
      text.focus();
      text.select();
      note.textContent = "Select the text above and copy it by hand.";
    }
  });

  done.addEventListener("click", async () => {
    const wanted = !current.doneAt;
    done.disabled = true;
    try {
      const reply = await fetch(api + "/v1/handoff/" + encodeURIComponent(id) + "/done", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ done: wanted }),
      });
      const data = await reply.json();
      if (!data.ok) throw new Error(data.error || "not saved");
      current = data.handoff;
      paint(current);
      note.textContent = wanted ? "Done. myna knows." : "Open again.";
    } catch (error) {
      note.textContent = "Could not save that: " + error.message;
    } finally {
      done.disabled = false;
    }
  });
})();
