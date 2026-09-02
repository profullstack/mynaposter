// The only script on the site: the copy button.
const button = document.getElementById("copy");
const command = document.getElementById("install");

button?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    button.textContent = "Copied";
    button.classList.add("done");
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("done");
    }, 1800);
  } catch {
    // Clipboard is refused in some contexts; the text is selectable anyway.
    button.textContent = "Select it";
  }
});
