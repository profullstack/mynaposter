// Show the authorization code so it can be carried to a myna running elsewhere.
// Everything happens in the page: the code is read from the URL and never sent
// anywhere, because the token exchange belongs on the machine holding the
// client secret, not on this one.
const params = new URLSearchParams(location.search);
const code = params.get("code");
const error = params.get("error_description") || params.get("error");

const codeEl = document.getElementById("code");
const detail = document.getElementById("detail");
const heading = document.getElementById("heading");
const lede = document.getElementById("lede");
const copy = document.getElementById("copy");

if (error) {
  heading.textContent = "That did not work";
  lede.textContent = "The provider refused the authorization.";
  codeEl.textContent = error;
  copy.hidden = true;
} else if (!code) {
  heading.textContent = "Nothing to copy";
  lede.textContent = "This page expects to be redirected here by a sign-in you started in myna.";
  codeEl.textContent = "no code in the URL";
  copy.hidden = true;
} else {
  codeEl.textContent = code;
  const state = params.get("state");
  if (state) detail.textContent = `state ${state}`;
}

copy?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(codeEl.textContent.trim());
    copy.textContent = "Copied";
    copy.classList.add("done");
    setTimeout(() => {
      copy.textContent = "Copy";
      copy.classList.remove("done");
    }, 1800);
  } catch {
    copy.textContent = "Select it";
  }
});

// The code is in the address bar, which is the one place it lingers. Once it has
// been read into the page, take it out of the URL and out of history.
if (code) {
  history.replaceState(null, "", location.pathname);
}
