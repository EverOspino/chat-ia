function growDraft() {
  const box = $("draft");
  box.style.height = "auto";
  const cap = 128;
  box.style.height = Math.min(box.scrollHeight, cap) + "px";
  box.style.overflowY = box.scrollHeight > cap ? "auto" : "hidden";
}

function focusDraft() {
  if (state.tab !== "chat" || !state.thread) return;
  const box = $("draft");
  if (box.disabled) return;
  box.focus();
}

function chatControls() {
  const open = Boolean(state.thread) && !state.streaming;
  $("draft").disabled = !state.thread;
  $("draft").readOnly = Boolean(state.thread) && state.streaming;
  $("send").disabled = !open;
  $("stop").classList.toggle("hidden", !state.streaming);
  $("delete-thread").disabled = !state.thread || state.streaming;
  $("thread-settings").disabled = !state.thread || state.streaming;
  $("chat-provider").disabled = !state.thread || state.streaming;
  $("chat-voice").disabled = !state.thread || state.streaming;
  $("speak-toggle").disabled = !state.thread || state.streaming;
  $("mic").disabled = !state.thread || state.streaming;
  $("suggest").disabled = !open || state.suggesting;
  $("chat-model").disabled = !state.thread || state.streaming;
  $("chat-context").disabled = !state.thread || state.streaming;
  if (!state.thread) closeModal("settings-modal");
  if (open) focusDraft();
}

function showThread(thread, messages) {
  state.thread = thread;
  state.messages = messages || [];
  $("chat-title").textContent = thread ? thread.character_name || thread.title || "Nuevo hilo" : "Sin hilo";
  $("chat-character").value = thread ? thread.character_name || "" : "";
  $("chat-model-badge").textContent = thread && thread.model ? thread.model : "";
  $("chat-model-badge").classList.toggle("hidden", !(thread && thread.model));
  $("chat-meta").textContent = thread
    ? [thread.character_name, thread.provider_name].filter(Boolean).join(" · ")
    : "";
  $("chat-context").value = thread ? thread.context_tokens || 8192 : 8192;
  fillModelSelect($("chat-model"), thread && thread.provider_account_id, thread ? thread.model || "" : "");
  if (thread && $("chat-voice").querySelector(`option[value="${thread.voice_account_id || ""}"]`)) {
    $("chat-voice").value = thread.voice_account_id || "";
  } else if (!thread) {
    $("chat-voice").value = "";
  }
  const speaking = Boolean(thread && thread.speak);
  $("speak-toggle").classList.toggle("on", speaking);
  $("speak-toggle").setAttribute("aria-pressed", speaking ? "true" : "false");
  if (!Voice.busy()) {
    Voice.setAccount(state.voices.find((item) => item.id === (thread && thread.voice_account_id)) || null);
  }
  if (thread && $("chat-provider").querySelector(`option[value="${thread.provider_account_id}"]`)) {
    $("chat-provider").value = thread.provider_account_id;
  }
  renderMessages();
  renderThreads();
  hideSuggestMenu();
  chatControls();
}

async function refreshCore() {
  const [characters, providers, threads, usage, presets, voices] = await Promise.all([
    api("/api/characters"),
    api("/api/providers"),
    api("/api/threads"),
    api("/api/usage"),
    api("/api/presets"),
    api("/api/voices"),
  ]);
  state.characters = characters.characters;
  state.providers = providers.providers;
  state.threads = threads.threads;
  state.usage = usage.events;
  state.presets = presets.presets;
  state.voices = voices.voices;
  renderCharacters();
  renderProviders();
  renderVoices();
  renderThreads();
  renderUsage();
  const presetSelect = $("p-preset");
  const current = presetSelect.value;
  fillSelect(presetSelect, state.presets.map((p) => ({ id: p.id, label: p.label })), "Elegir…", current);
}

async function openThread(id, opts = {}) {
  const data = await api("/api/threads/" + id);
  await loadModels(data.thread.provider_account_id);
  showThread(data.thread, data.messages);
  if (!opts.skipNav) navigate("chat", id, opts.replace);
}

async function applyRoute() {
  const route = parseRoute();
  setTab(route.tab);
  if (route.tab !== "chat") return;
  if (route.threadId) {
    if (state.thread && state.thread.id === route.threadId) return;
    await openThread(route.threadId, { skipNav: true }).catch((err) => toast(err.message));
    return;
  }
  const fallback = (state.thread && state.thread.id) || (state.threads[0] && state.threads[0].id);
  if (fallback) await openThread(fallback, { replace: true });
  else chatControls();
}

async function boot() {
  await refreshCore();
  const defaults = await api("/api/defaults");
  fillCharacterForm(defaults.fields);
  $("prompt-preview").textContent = defaults.prompt_compiled;
  bind();
  const route = parseRoute();
  if (route.tab !== "chat") {
    setTab(route.tab);
    return;
  }
  const id = route.threadId || (state.threads[0] && state.threads[0].id);
  if (id) {
    await openThread(id, { replace: true }).catch((err) => {
      toast(err.message);
      chatControls();
      navigate("chat", "", true);
    });
  } else {
    chatControls();
    navigate("chat", "", true);
  }
}
