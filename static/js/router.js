function currentPath() {
  return location.pathname.replace(/\/+$/, "") || "/";
}

function urlFor(tab, threadId) {
  if (tab === "character") return "/personajes";
  if (tab === "connect") return "/conexiones";
  if (tab === "voice") return "/voces";
  if (threadId) return "/chat/" + threadId;
  return "/chat";
}

function parseRoute() {
  const parts = currentPath().split("/").filter(Boolean);
  const head = parts[0] || "chat";
  if (head === "personajes") return { tab: "character", threadId: "" };
  if (head === "conexiones") return { tab: "connect", threadId: "" };
  if (head === "voces") return { tab: "voice", threadId: "" };
  return { tab: "chat", threadId: head === "chat" ? (parts[1] || "") : "" };
}

function navigate(tab, threadId, replace) {
  const id = tab === "chat"
    ? (threadId || (state.thread && state.thread.id) || (state.threads[0] && state.threads[0].id) || "")
    : "";
  const url = urlFor(tab, id);
  if (currentPath() !== url) {
    history[replace ? "replaceState" : "pushState"]({ tab, threadId: id }, "", url);
  }
  setTab(tab);
  if (tab === "chat" && id && !(state.thread && state.thread.id === id)) {
    openThread(id, { skipNav: true }).catch((err) => toast(err.message));
  }
}

function setTab(tab) {
  state.tab = tab;
  document.body.dataset.view = tab;
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  $("view-chat").classList.toggle("hidden", tab !== "chat");
  $("view-character").classList.toggle("hidden", tab !== "character");
  $("view-connect").classList.toggle("hidden", tab !== "connect");
  $("view-voice").classList.toggle("hidden", tab !== "voice");
  if (tab === "chat") focusDraft();
  if (tab === "character") ensureCharacterEditor();
  if (tab === "connect") ensureProviderEditor();
  if (tab === "voice") ensureVoiceEditor();
}
