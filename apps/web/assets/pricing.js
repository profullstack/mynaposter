// mynaposter.com/pricing: the signed-in balance and the buy buttons.
// The session is the dashboard's HttpOnly cookie; this script never sees it.
(() => {
  const byId = (id) => document.getElementById(id);
  const box = byId("credits");
  const status = byId("credits-status");
  const buy = byId("credits-buy");
  const note = byId("credits-note");
  const signin = byId("credits-signin");
  const show = async () => {
    const res = await fetch("/api/v1/cloud/credits", { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (!res || !res.ok) return;
    const j = await res.json().catch(() => null);
    if (!j || !j.ok) return;
    box.hidden = false;
    signin.hidden = true;
    status.textContent = `${j.email}: ${j.credits.toLocaleString()} credits left (${j.free_monthly} free every month).`;
    buy.hidden = !j.buying;
    if (!j.buying) note.textContent = "Buying credits switches on shortly.";
  };
  buy.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-usd]");
    if (!button) return;
    button.disabled = true;
    note.textContent = "Opening CoinPay...";
    const res = await fetch("/api/v1/cloud/credits/topup", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: Number(button.dataset.usd) }),
    }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    button.disabled = false;
    if (j && j.ok && j.checkout_url) location.href = j.checkout_url;
    else note.textContent = (j && j.error) || "Could not start the payment; try again.";
  });
  if (new URLSearchParams(location.search).has("paid")) note.textContent = "Thanks! Credits appear as soon as the payment confirms.";
  show();
})();
