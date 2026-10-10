const state = {
  tab: "chat",
  providers: [],
  characters: [],
  threads: [],
  thread: null,
  messages: [],
  models: [],
  modelCache: {},
  voices: [],
  editingVoiceId: null,
  listening: false,
  voiceStopped: false,
  usage: [],
  presets: [],
  editingCharacterId: null,
  editingProviderId: null,
  clearKey: false,
  streaming: false,
  suggesting: false,
  suggestions: [],
  abort: null,
  compileTimer: null,
  toastTimer: null,
  settingsSnap: null,
};

const $ = (id) => document.getElementById(id);

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).includes("T") ? iso : String(iso).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

function initial(name) {
  const t = String(name || "?").trim();
  return t ? t[0].toUpperCase() : "?";
}

function growArea(node, cap) {
  if (!node) return;
  node.style.height = "auto";
  const limit = cap || 240;
  node.style.height = Math.min(node.scrollHeight, limit) + "px";
  node.style.overflowY = node.scrollHeight > limit ? "auto" : "hidden";
}

function growFormAreas() {
  for (const area of document.querySelectorAll("textarea")) {
    if (area.id === "draft") continue;
    growArea(area, area.id === "f-ejemplo" ? 320 : 220);
  }
}

function openModal(id) {
  $(id).classList.remove("hidden");
  requestAnimationFrame(growFormAreas);
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

function statusChip(kind, label) {
  const chip = document.createElement("span");
  chip.className = "badge-status " + kind;
  chip.textContent = label;
  return chip;
}

function setStatus(id, text, kind) {
  const node = $(id);
  node.textContent = text || "";
  node.className = "status" + (kind ? " " + kind : "");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text };
    }
  }
  if (!res.ok) {
    const detail = data && data.detail;
    const message = typeof detail === "string" ? detail : (detail && detail.message) || "No se pudo completar.";
    throw new Error(message);
  }
  return data;
}

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
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
  $("view-chat").classList.toggle("hidden", tab !== "chat");
  $("view-character").classList.toggle("hidden", tab !== "character");
  $("view-connect").classList.toggle("hidden", tab !== "connect");
  $("view-voice").classList.toggle("hidden", tab !== "voice");
  if (tab === "chat") focusDraft();
}

function fillSelect(select, items, placeholder, selected) {
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.appendChild(empty);
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label;
    if (item.id === selected) opt.selected = true;
    select.appendChild(opt);
  }
}

function renderThreads() {
  const list = $("thread-list");
  list.replaceChildren();
  if (!state.threads.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Todavía no hay conversaciones.";
    list.appendChild(p);
    return;
  }
  for (const thread of state.threads) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thread-item" + (state.thread && state.thread.id === thread.id ? " active" : "");
    btn.dataset.thread = thread.id;
    const name = document.createElement("span");
    name.className = "thread-name";
    name.textContent = thread.character_name || thread.title || "Nuevo hilo";
    const date = document.createElement("span");
    date.className = "thread-date";
    date.textContent = formatDate(thread.updated_at || thread.created_at);
    btn.append(name, date);
    list.appendChild(btn);
  }
}

function toast(message) {
  const node = $("toast");
  node.textContent = message || "";
  node.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.add("hidden"), 4800);
}

function fillFormatted(node, text) {
  node.replaceChildren();
  const src = text || "";
  const re = /\*[^*\n]+\*|«[^»\n]*»|"[^"\n]*"|“[^”\n]*”/g;
  let last = 0;
  let match;
  while ((match = re.exec(src)) !== null) {
    if (match.index > last) node.append(src.slice(last, match.index));
    const raw = match[0];
    const el = document.createElement(raw.startsWith("*") ? "strong" : "em");
    if (!raw.startsWith("*")) el.className = "thought";
    el.textContent = raw;
    node.appendChild(el);
    last = match.index + raw.length;
  }
  if (last < src.length) node.append(src.slice(last));
}

function renderMessages() {
  const box = $("messages");
  box.replaceChildren();
  if (!state.thread) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Creá un personaje, conectá un proveedor y abrí una conversación.";
    box.appendChild(p);
    return;
  }
  if (!state.messages.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Hilo vacío. Escribe algo para iniciar una conversación.";
    box.appendChild(p);
    return;
  }
  state.messages.forEach((msg, index) => {
    if (msg.role === "notice") return;
    box.appendChild(bubble(msg, index));
  });
  box.scrollTop = box.scrollHeight;
}

function retryTarget(index) {
  for (let i = index; i >= 0; i -= 1) {
    if (state.messages[i].role === "user" && state.messages[i].id) return state.messages[i].id;
  }
  return "";
}

function bubble(msg, index) {
  const wrap = document.createElement("div");
  wrap.className = "turn " + msg.role;
  const node = document.createElement("div");
  node.className = "bubble " + msg.role;
  fillFormatted(node, msg.content);
  wrap.appendChild(node);
  const actions = document.createElement("div");
  actions.className = "turn-actions";
  if (msg.role === "assistant" && (msg.content || "").trim() && !state.streaming) {
    const play = document.createElement("button");
    play.type = "button";
    play.className = "play-msg icon-btn";
    play.dataset.play = String(index);
    play.title = "Leer";
    play.setAttribute("aria-label", "Leer mensaje");
    play.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5z"/></svg>';
    actions.appendChild(play);
  }
  const target = retryTarget(index);
  if (target && !state.streaming && (msg.role === "user" || msg.role === "assistant")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retry icon-btn";
    btn.dataset.retry = target;
    btn.title = "Reintentar";
    btn.setAttribute("aria-label", "Reintentar");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>';
    actions.appendChild(btn);
  }
  if (actions.childNodes.length) wrap.appendChild(actions);
  return wrap;
}

function actionBtn(label, attrs) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost";
  btn.textContent = label;
  for (const [key, value] of Object.entries(attrs || {})) btn.setAttribute(key, value);
  return btn;
}

function entityCard(opts) {
  const card = document.createElement("article");
  card.className = "entity-card" + (opts.active ? " active" : "");
  const top = document.createElement("div");
  top.className = "entity-top";
  const dot = document.createElement("div");
  dot.className = "avatar-dot";
  dot.textContent = initial(opts.name);
  const copy = document.createElement("div");
  copy.className = "entity-copy";
  const title = document.createElement("strong");
  title.textContent = opts.name;
  copy.appendChild(title);
  if (opts.sub) {
    const sub = document.createElement("small");
    sub.textContent = opts.sub;
    copy.appendChild(sub);
  }
  top.append(dot, copy);
  card.appendChild(top);
  if (opts.status) {
    const meta = document.createElement("div");
    meta.className = "entity-meta";
    meta.appendChild(statusChip(opts.status.kind, opts.status.label));
    card.appendChild(meta);
  }
  const actions = document.createElement("div");
  actions.className = "entity-actions";
  for (const action of opts.actions || []) actions.appendChild(action);
  card.appendChild(actions);
  return card;
}

function renderCharacters() {
  const list = $("character-list");
  list.replaceChildren();
  if (!state.characters.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Todavía no hay personajes.";
    list.appendChild(p);
  }
  for (const character of state.characters) {
    const fields = character.fields || {};
    const sub = fields.tono || fields.look || ("v" + character.version);
    list.appendChild(entityCard({
      active: state.editingCharacterId === character.id && !$("character-editor").classList.contains("hidden"),
      name: character.name,
      sub,
      actions: [
        actionBtn("Editar", { "data-character": character.id }),
        actionBtn("Borrar", { "data-character-delete": character.id }),
      ],
    }));
  }
  fillSelect(
    $("new-character"),
    state.characters.map((c) => ({ id: c.id, label: c.name })),
    state.characters.length ? "Elegí" : "Primero creá uno",
    $("new-character").value
  );
}

function providerStatus(provider) {
  const url = (provider.base_url || "").toLowerCase();
  if (/localhost|127\.0\.0\.1/.test(url)) return { kind: "local", label: "Local" };
  if (provider.has_key) return { kind: "ok", label: "Conectado" };
  return { kind: "muted", label: "Sin key" };
}

function renderProviders() {
  const list = $("provider-list");
  list.replaceChildren();
  if (!state.providers.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Todavía no hay conexiones.";
    list.appendChild(p);
  }
  for (const provider of state.providers) {
    list.appendChild(entityCard({
      active: state.editingProviderId === provider.id && !$("provider-editor").classList.contains("hidden"),
      name: provider.name,
      sub: provider.base_url,
      status: providerStatus(provider),
      actions: [
        actionBtn("Probar", { "data-provider-test": provider.id }),
        actionBtn("Editar", { "data-provider": provider.id }),
        actionBtn("Borrar", { "data-provider-delete": provider.id }),
      ],
    }));
  }
  const providerOptions = state.providers.map((p) => ({ id: p.id, label: p.name }));
  fillSelect(
    $("new-provider"),
    providerOptions,
    state.providers.length ? "Elegí" : "Primero conectá",
    $("new-provider").value
  );
  fillSelect(
    $("chat-provider"),
    providerOptions,
    state.providers.length ? "Elegí" : "Sin conexión",
    state.thread ? state.thread.provider_account_id : ""
  );
}

function fillModelSelect(select, providerId, selected) {
  const models = [...((providerId && state.modelCache[providerId]) || [])].sort((a, b) => a.id.localeCompare(b.id, "es"));
  const keep = selected != null ? selected : select.value;
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = models.length ? "Elegí un modelo" : "Sin modelos listados";
  select.appendChild(empty);
  const ids = new Set();
  for (const model of models) {
    ids.add(model.id);
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = model.free ? model.id + " · free" : model.id;
    if (model.context) opt.dataset.context = String(model.context);
    select.appendChild(opt);
  }
  if (keep && !ids.has(keep)) {
    const extra = document.createElement("option");
    extra.value = keep;
    extra.textContent = keep;
    select.appendChild(extra);
  }
  select.value = keep || "";
}

async function loadModels(providerId, announce) {
  if (!providerId) return;
  if (!state.modelCache[providerId]) {
    try {
      const listed = await api("/api/providers/" + providerId + "/models");
      state.modelCache[providerId] = listed.models || [];
    } catch (err) {
      if (announce) toast(err.message);
    }
  }
  renderModels();
}

function renderModels() {
  const filter = ($("model-filter").value || "").toLowerCase();
  const list = $("model-results");
  list.replaceChildren();
  const catalog = state.modelCache[state.editingProviderId] || state.models;
  const shown = catalog
    .filter((m) => !filter || m.id.toLowerCase().includes(filter) || (m.name || "").toLowerCase().includes(filter))
    .sort((a, b) => a.id.localeCompare(b.id, "es"));
  for (const model of shown.slice(0, 80)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-item";
    btn.dataset.model = model.id;
    btn.dataset.context = model.context || "";
    btn.textContent = model.id;
    if (model.free) {
      const mark = document.createElement("span");
      mark.className = "free";
      mark.textContent = " free";
      btn.appendChild(mark);
    }
    list.appendChild(btn);
  }
  fillModelSelect($("new-model"), $("new-provider").value, $("new-model").value);
  const chatProvider = (state.thread && state.thread.provider_account_id) || $("chat-provider").value;
  fillModelSelect($("chat-model"), chatProvider, $("chat-model").value);
}

function renderUsage() {
  const list = $("usage-list");
  list.replaceChildren();
  if (!state.usage.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Todavía no hay intentos.";
    list.appendChild(p);
    return;
  }
  for (const event of state.usage) {
    const row = document.createElement("div");
    row.className = "item";
    const when = (event.created_at || "").slice(11, 16);
    const klass = event.error_class || "ok";
    row.textContent = [when, event.model || "—", event.http_status || "—", klass].join(" · ");
    list.appendChild(row);
  }
}

function fieldValues() {
  return {
    nombre: $("f-nombre").value.trim(),
    edad: $("f-edad").value.trim(),
    look: $("f-look").value.trim(),
    tono: $("f-tono").value.trim(),
    vocabulario: $("f-vocabulario").value.trim(),
    formato: $("f-formato").value.trim(),
    limites: $("f-limites").value.trim(),
    ejemplo: $("f-ejemplo").value.trim(),
    max_tokens: Number($("f-max").value || 600),
    temperatura: Number($("f-temp").value || 0.85),
  };
}

function fillCharacterForm(fields, version) {
  const data = fields || {};
  $("f-nombre").value = data.nombre || "";
  $("f-edad").value = data.edad || "";
  $("f-look").value = data.look || "";
  $("f-tono").value = data.tono || "";
  $("f-vocabulario").value = data.vocabulario || "";
  $("f-formato").value = data.formato || "";
  $("f-limites").value = data.limites || "";
  $("f-ejemplo").value = data.ejemplo || "";
  $("f-max").value = data.max_tokens ?? 600;
  $("f-temp").value = data.temperatura ?? 0.85;
  $("character-version").textContent = version
    ? "Versión " + version + ". Los cambios valen para el próximo turno. El historial no se reescribe."
    : "Los cambios valen para el próximo turno. El historial no se reescribe.";
  $("delete-character").disabled = !state.editingCharacterId;
  requestAnimationFrame(growFormAreas);
}

function scheduleCompile() {
  clearTimeout(state.compileTimer);
  state.compileTimer = setTimeout(compilePreview, 250);
}

async function compilePreview() {
  try {
    const data = await api("/api/compile", {
      method: "POST",
      body: JSON.stringify({ fields: fieldValues() }),
    });
    $("prompt-preview").textContent = data.prompt_compiled;
    const ejemplo = $("f-ejemplo").value.trim();
    if (ejemplo.endsWith("?")) {
      setStatus("character-status", "El ejemplo cierra con pregunta. Flash suele imitar eso.", "bad");
    }
  } catch (err) {
    $("prompt-preview").textContent = "";
    setStatus("character-status", err.message, "bad");
  }
}

function updateOrNote() {
  const url = ($("p-url").value || "").toLowerCase();
  $("or-note").classList.toggle("hidden", !url.includes("openrouter.ai"));
}

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

function fillVoiceForm(found) {
  state.editingVoiceId = found.id;
  $("v-name").value = found.name;
  $("v-provider").value = found.provider;
  $("v-key").value = "";
  $("v-key").placeholder = found.has_key ? "Key guardada (" + found.key_hint + ")" : "key de fish.audio";
  $("v-model").value = found.model || "s2.1-pro-free";
  $("v-voice").value = found.voice_id || "";
  $("v-test").disabled = false;
  $("v-delete").disabled = found.provider === "browser";
  syncVoiceFields();
  renderVoices();
  setStatus("voice-status", "");
}

function fillProviderForm(found) {
  state.editingProviderId = found.id;
  state.clearKey = false;
  $("p-name").value = found.name;
  $("p-url").value = found.base_url;
  $("p-key").value = "";
  $("p-key").placeholder = found.has_key ? "Key guardada (" + found.key_hint + ")" : "sk-…";
  $("test-connection").disabled = false;
  $("clear-key").disabled = false;
  $("delete-provider").disabled = false;
  updateOrNote();
  renderProviders();
  setStatus("provider-status", "");
}

function snapshotSettings() {
  state.settingsSnap = {
    provider: $("chat-provider").value,
    model: $("chat-model").value,
    context: $("chat-context").value,
    voice: $("chat-voice").value,
    speak: $("speak-toggle").classList.contains("on"),
  };
}

function restoreSettings() {
  const snap = state.settingsSnap;
  if (!snap) return;
  $("chat-provider").value = snap.provider;
  $("chat-model").value = snap.model;
  $("chat-context").value = snap.context;
  $("chat-voice").value = snap.voice;
  $("speak-toggle").classList.toggle("on", snap.speak);
  $("speak-toggle").setAttribute("aria-pressed", snap.speak ? "true" : "false");
}

async function saveSettings() {
  if (!state.thread) return;
  const providerId = $("chat-provider").value;
  const model = $("chat-model").value.trim();
  const context = Number($("chat-context").value || 8192);
  let voiceId = $("chat-voice").value;
  const speak = $("speak-toggle").classList.contains("on") ? 1 : 0;
  if (speak && !voiceId) {
    const browser = state.voices.find((item) => item.provider === "browser");
    if (browser) {
      voiceId = browser.id;
      $("chat-voice").value = voiceId;
    }
  }
  if (speak && !voiceId) {
    toast("No hay un motor de voz.");
    return;
  }
  try {
    const updated = await api("/api/threads/" + state.thread.id, {
      method: "PATCH",
      body: JSON.stringify({
        provider_account_id: providerId || undefined,
        model: model || undefined,
        context_tokens: context,
        voice_account_id: voiceId,
        speak,
      }),
    });
    state.thread = { ...state.thread, ...updated };
    Voice.setAccount(state.voices.find((item) => item.id === voiceId) || null);
    if (!speak) Voice.cancel();
    closeModal("settings-modal");
    await refreshCore();
    await openThread(state.thread.id);
  } catch (err) {
    toast(err.message);
  }
}

function bind() {
  document.body.addEventListener("click", async (event) => {
    const suggestPick = event.target.closest("[data-suggest]");
    if (suggestPick) {
      const text = state.suggestions[Number(suggestPick.dataset.suggest)];
      if (text) pickSuggestion(text);
      return;
    }
    if (!event.target.closest(".suggest-wrap") && !event.target.closest("#suggest-menu")) hideSuggestMenu();
    const closer = event.target.closest("[data-close]");
    if (closer) {
      if (closer.dataset.close === "settings-modal") restoreSettings();
      closeModal(closer.dataset.close);
      return;
    }
    const retry = event.target.closest("[data-retry]");
    if (retry) {
      retryFrom(retry.dataset.retry);
      return;
    }
    const play = event.target.closest("[data-play]");
    if (play) {
      const msg = state.messages[Number(play.dataset.play)];
      if (!msg || !msg.content) return;
      const voiceId = state.thread && state.thread.voice_account_id;
      const chosen = state.voices.find((item) => item.id === voiceId) || state.voices[0];
      if (!chosen) {
        toast("No hay un motor de voz.");
        return;
      }
      Voice.setAccount(chosen);
      Voice.preview(msg.content);
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      navigate(tab.dataset.tab, state.thread && state.thread.id);
      return;
    }
    const thread = event.target.closest("[data-thread]");
    if (thread) {
      await openThread(thread.dataset.thread).catch((err) => toast(err.message));
      return;
    }
    const characterDelete = event.target.closest("[data-character-delete]");
    if (characterDelete) {
      const found = state.characters.find((item) => item.id === characterDelete.dataset.characterDelete);
      if (!found) return;
      state.editingCharacterId = found.id;
      $("delete-character").disabled = false;
      $("delete-character").click();
      return;
    }
    const character = event.target.closest("[data-character]");
    if (character) {
      const found = state.characters.find((item) => item.id === character.dataset.character);
      if (!found) return;
      state.editingCharacterId = found.id;
      fillCharacterForm(found.fields, found.version);
      $("prompt-preview").textContent = found.prompt_compiled;
      renderCharacters();
      navigate("character");
      openModal("character-editor");
      return;
    }
    const voiceDelete = event.target.closest("[data-voice-delete]");
    if (voiceDelete) {
      const found = state.voices.find((item) => item.id === voiceDelete.dataset.voiceDelete);
      if (!found) return;
      fillVoiceForm(found);
      $("v-delete").click();
      return;
    }
    const voiceTest = event.target.closest("[data-voice-test]");
    if (voiceTest) {
      const found = state.voices.find((item) => item.id === voiceTest.dataset.voiceTest);
      if (!found) return;
      fillVoiceForm(found);
      testVoice();
      return;
    }
    const voiceItem = event.target.closest("[data-voice]");
    if (voiceItem) {
      const found = state.voices.find((item) => item.id === voiceItem.dataset.voice);
      if (!found) return;
      fillVoiceForm(found);
      navigate("voice");
      openModal("voice-editor");
      return;
    }
    const providerDelete = event.target.closest("[data-provider-delete]");
    if (providerDelete) {
      const found = state.providers.find((item) => item.id === providerDelete.dataset.providerDelete);
      if (!found) return;
      fillProviderForm(found);
      $("delete-provider").click();
      return;
    }
    const providerTest = event.target.closest("[data-provider-test]");
    if (providerTest) {
      const found = state.providers.find((item) => item.id === providerTest.dataset.providerTest);
      if (!found) return;
      fillProviderForm(found);
      openModal("provider-editor");
      $("test-connection").click();
      return;
    }
    const provider = event.target.closest("[data-provider]");
    if (provider) {
      const found = state.providers.find((item) => item.id === provider.dataset.provider);
      if (!found) return;
      fillProviderForm(found);
      navigate("connect");
      openModal("provider-editor");
      return;
    }
    const model = event.target.closest("[data-model]");
    if (model) {
      if ($("new-provider").value && $("new-provider").value === state.editingProviderId) {
        $("new-model").value = model.dataset.model;
      }
      if (state.thread && state.thread.provider_account_id === state.editingProviderId) {
        $("chat-model").value = model.dataset.model;
        if (model.dataset.context) $("chat-context").value = model.dataset.context;
        navigate("chat", state.thread.id);
      }
    }
  });

  $("new-thread-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus("chat-status", "");
    try {
      const created = await api("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          character_id: $("new-character").value,
          provider_account_id: $("new-provider").value,
          model: $("new-model").value,
          context_tokens: Number($("new-model").selectedOptions[0] && $("new-model").selectedOptions[0].dataset.context) || 8192,
        }),
      });
      await refreshCore();
      closeModal("new-thread-modal");
      await openThread(created.id);
    } catch (err) {
      toast(err.message);
    }
  });

  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    send();
  });
  $("draft").addEventListener("input", growDraft);



  $("stop").addEventListener("click", () => {
    state.voiceStopped = true;
    Voice.cancel();
    if (state.abort) state.abort.abort();
  });

  $("delete-thread").addEventListener("click", async () => {
    if (!state.thread) return;
    if (!confirm("¿Borrar este hilo?")) return;
    await api("/api/threads/" + state.thread.id, { method: "DELETE" });
    state.thread = null;
    state.messages = [];
    await refreshCore();
    showThread(null, []);
    navigate("chat", "", true);
  });

  $("character-form").addEventListener("input", () => {
    growFormAreas();
    scheduleCompile();
  });
  $("character-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = fieldValues();
    const path = state.editingCharacterId ? "/api/characters/" + state.editingCharacterId : "/api/characters";
    const method = state.editingCharacterId ? "PUT" : "POST";
    try {
      const saved = await api(path, { method, body: JSON.stringify({ fields }) });
      state.editingCharacterId = saved.id;
      await refreshCore();
      fillCharacterForm(saved.fields, saved.version);
      $("prompt-preview").textContent = saved.prompt_compiled;
      setStatus("character-status", "Guardado. El próximo turno usa esta versión.", "ok");
    } catch (err) {
      setStatus("character-status", err.message, "bad");
    }
  });

  $("new-character-btn").addEventListener("click", async () => {
    state.editingCharacterId = null;
    const defaults = await api("/api/defaults");
    fillCharacterForm(defaults.fields);
    $("prompt-preview").textContent = defaults.prompt_compiled;
    renderCharacters();
    setStatus("character-status", "");
    openModal("character-editor");
  });

  $("delete-character").addEventListener("click", async () => {
    if (!state.editingCharacterId) return;
    if (!confirm("¿Borrar este personaje?")) return;
    try {
      await api("/api/characters/" + state.editingCharacterId, { method: "DELETE" });
      state.editingCharacterId = null;
      await refreshCore();
      const defaults = await api("/api/defaults");
      fillCharacterForm(defaults.fields);
      $("prompt-preview").textContent = defaults.prompt_compiled;
      closeModal("character-editor");
      setStatus("character-status", "Borrado.", "ok");
    } catch (err) {
      setStatus("character-status", err.message, "bad");
    }
  });

  $("copy-prompt").addEventListener("click", async () => {
    const text = $("prompt-preview").textContent;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("character-status", "Prompt copiado.", "ok");
    } catch {
      setStatus("character-status", "No se pudo copiar.", "bad");
    }
  });

  $("provider-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      name: $("p-name").value.trim(),
      base_url: $("p-url").value.trim(),
      clear_key: state.clearKey,
    };
    const typed = $("p-key").value.trim();
    if (typed) payload.api_key = typed;
    const path = state.editingProviderId ? "/api/providers/" + state.editingProviderId : "/api/providers";
    const method = state.editingProviderId ? "PUT" : "POST";
    try {
      const saved = await api(path, { method, body: JSON.stringify(payload) });
      state.editingProviderId = saved.id;
      state.clearKey = false;
      $("p-key").value = "";
      $("p-key").placeholder = saved.has_key ? "Key guardada (" + saved.key_hint + ")" : "sk-…";
      $("test-connection").disabled = false;
      $("clear-key").disabled = false;
      $("delete-provider").disabled = false;
      await refreshCore();
      setStatus("provider-status", "Guardado. La key no se vuelve a mostrar entera.", "ok");
    } catch (err) {
      setStatus("provider-status", err.message, "bad");
    }
  });

  $("new-provider-btn").addEventListener("click", () => {
    state.editingProviderId = null;
    state.clearKey = false;
    $("provider-form").reset();
    $("p-key").placeholder = "sk-…";
    $("test-connection").disabled = true;
    $("clear-key").disabled = true;
    $("delete-provider").disabled = true;
    updateOrNote();
    renderProviders();
    setStatus("provider-status", "");
    openModal("provider-editor");
  });

  $("p-preset").addEventListener("change", () => {
    const found = state.presets.find((item) => item.id === $("p-preset").value);
    if (!found) return;
    $("p-url").value = found.base_url;
    if (!$("p-name").value.trim()) $("p-name").value = found.label;
    updateOrNote();
  });

  $("p-url").addEventListener("input", updateOrNote);

  $("clear-key").addEventListener("click", () => {
    state.clearKey = true;
    $("p-key").value = "";
    $("p-key").placeholder = "Se va a guardar sin key";
    setStatus("provider-status", "Al guardar, esta conexión queda sin key.", "bad");
  });

  $("delete-provider").addEventListener("click", async () => {
    if (!state.editingProviderId) return;
    if (!confirm("¿Borrar esta conexión? Los hilos quedan, pero no van a poder enviar.")) return;
    await api("/api/providers/" + state.editingProviderId, { method: "DELETE" });
    state.editingProviderId = null;
    $("provider-form").reset();
    $("test-connection").disabled = true;
    $("delete-provider").disabled = true;
    $("clear-key").disabled = true;
    await refreshCore();
    closeModal("provider-editor");
    setStatus("provider-status", "Conexión borrada.", "ok");
  });

  $("test-connection").addEventListener("click", async () => {
    if (!state.editingProviderId) return;
    setStatus("provider-status", "Probando…");
    try {
      const data = await api("/api/providers/" + state.editingProviderId + "/test", { method: "POST" });
      if (data.ok) state.modelCache[state.editingProviderId] = data.models || [];
      state.models = data.models || [];
      renderModels();
      await refreshCore();
      if (!data.ok) {
        setStatus("provider-status", data.message, "bad");
        return;
      }
      setStatus("provider-status", data.message, "ok");
    } catch (err) {
      setStatus("provider-status", err.message, "bad");
    }
  });

  $("model-form").addEventListener("submit", (event) => event.preventDefault());
  $("new-provider").addEventListener("change", async () => {
    $("new-model").value = "";
    await loadModels($("new-provider").value, true);
  });
  $("chat-model").addEventListener("change", () => {
    const picked = $("chat-model").selectedOptions[0];
    if (picked && picked.dataset.context) $("chat-context").value = picked.dataset.context;
  });
  $("chat-provider").addEventListener("change", async () => {
    $("chat-model").value = "";
    await loadModels($("chat-provider").value, true);
  });
  const savedVol = Number(localStorage.getItem("chat-ia-volume"));
  const vol = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 1;
  $("voice-volume").value = String(Math.round(vol * 100));
  Voice.setVolume(vol);
  $("voice-volume").addEventListener("input", () => {
    const next = Number($("voice-volume").value) / 100;
    Voice.setVolume(next);
    localStorage.setItem("chat-ia-volume", String(next));
  });
  $("speak-toggle").addEventListener("click", () => {
    if ($("speak-toggle").disabled) return;
    const next = !$("speak-toggle").classList.contains("on");
    $("speak-toggle").classList.toggle("on", next);
    $("speak-toggle").setAttribute("aria-pressed", next ? "true" : "false");
  });
  $("mic").addEventListener("click", () => toggleMic());
  $("suggest").addEventListener("click", (event) => {
    event.stopPropagation();
    loadSuggestions();
  });
  $("voice-form").addEventListener("submit", saveVoice);
  $("v-provider").addEventListener("change", syncVoiceFields);
  $("v-listed").addEventListener("change", () => {
    if ($("v-listed").value) $("v-voice").value = $("v-listed").value;
  });
  $("v-list").addEventListener("click", listVoiceOptions);
  $("v-test").addEventListener("click", testVoice);
  $("v-delete").addEventListener("click", deleteVoice);
  $("new-voice-btn").addEventListener("click", () => {
    state.editingVoiceId = null;
    $("voice-form").reset();
    $("v-key").placeholder = "key de fish.audio";
    $("v-test").disabled = true;
    $("v-delete").disabled = true;
    $("v-listed").classList.add("hidden");
    syncVoiceFields();
    renderVoices();
    setStatus("voice-status", "");
    openModal("voice-editor");
  });
  Voice.setError((message) => toast(message));
  syncVoiceFields();
  $("new-thread-btn").addEventListener("click", () => {
    if (state.characters.length === 1) $("new-character").value = state.characters[0].id;
    if (state.providers.length === 1 && !$("new-provider").value) {
      $("new-provider").value = state.providers[0].id;
      loadModels(state.providers[0].id);
    }
    openModal("new-thread-modal");
  });
  $("thread-settings").addEventListener("click", (event) => {
    event.stopPropagation();
    if ($("thread-settings").disabled) return;
    snapshotSettings();
    openModal("settings-modal");
  });
  $("settings-cancel").addEventListener("click", () => {
    restoreSettings();
    closeModal("settings-modal");
  });
  $("settings-save").addEventListener("click", () => saveSettings());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const ids = ["settings-modal", "new-thread-modal", "character-editor", "provider-editor", "voice-editor"];
      const open = ids.some((id) => !$(id).classList.contains("hidden"));
      if (!$("settings-modal").classList.contains("hidden")) restoreSettings();
      for (const id of ids) closeModal(id);
      hideSuggestMenu();
      if (open) {
        event.preventDefault();
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      if ($("mic").disabled) return;
      toggleMic();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (state.tab !== "chat") return;
    const el = event.target;
    const tag = (el.tagName || "").toLowerCase();
    const form = el.closest && el.closest("form");
    if (form && form.id !== "composer") return;
    if (el.id !== "draft" && (tag === "input" || tag === "textarea" || tag === "select")) return;
    event.preventDefault();
    send();
  });
  $("model-filter").addEventListener("input", renderModels);
  $("toast").addEventListener("click", () => $("toast").classList.add("hidden"));
  window.addEventListener("popstate", () => {
    applyRoute().catch((err) => toast(err.message));
  });
}

async function switchConnection(providerId) {
  if (!state.thread || !providerId || providerId === state.thread.provider_account_id) return;
  const previous = state.thread.provider_account_id;
  try {
    await api("/api/threads/" + state.thread.id, {
      method: "PATCH",
      body: JSON.stringify({ provider_account_id: providerId }),
    });
    const threadId = state.thread.id;
    delete state.modelCache[providerId];
    await refreshCore();
    await openThread(threadId);
  } catch (err) {
    $("chat-provider").value = previous || "";
    toast(err.message);
  }
}

function voiceStatus(voice) {
  if (voice.provider === "browser") return { kind: "local", label: "Sistema" };
  if (voice.has_key) return { kind: "ok", label: "Conectado" };
  return { kind: "muted", label: "Sin key" };
}

function renderVoices() {
  const list = $("voice-list");
  list.replaceChildren();
  if (!state.voices.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Todavía no hay voces.";
    list.appendChild(p);
  }
  for (const voice of state.voices) {
    list.appendChild(entityCard({
      active: state.editingVoiceId === voice.id && !$("voice-editor").classList.contains("hidden"),
      name: voice.name,
      sub: voice.provider === "fish" ? "Fish Audio" : "Navegador",
      status: voiceStatus(voice),
      actions: [
        actionBtn("Probar", { "data-voice-test": voice.id }),
        actionBtn("Editar", { "data-voice": voice.id }),
        ...(voice.provider === "browser" ? [] : [actionBtn("Borrar", { "data-voice-delete": voice.id })]),
      ],
    }));
  }
  fillSelect(
    $("chat-voice"),
    state.voices.map((voice) => ({
      id: voice.id,
      label: voice.name + (voice.provider === "fish" ? " · Fish" : " · Navegador"),
    })),
    "Sin voz",
    state.thread ? state.thread.voice_account_id : ""
  );
}

function syncVoiceFields() {
  $("v-fish-fields").classList.toggle("hidden", $("v-provider").value !== "fish");
}

async function saveVoice(event) {
  event.preventDefault();
  const payload = {
    name: $("v-name").value.trim(),
    provider: $("v-provider").value,
    voice_id: $("v-voice").value.trim(),
    model: $("v-model").value,
  };
  const typed = $("v-key").value.trim();
  if (typed) payload.api_key = typed;
  const path = state.editingVoiceId ? "/api/voices/" + state.editingVoiceId : "/api/voices";
  const method = state.editingVoiceId ? "PUT" : "POST";
  try {
    const saved = await api(path, { method, body: JSON.stringify(payload) });
    state.editingVoiceId = saved.id;
    $("v-key").value = "";
    $("v-test").disabled = false;
    $("v-delete").disabled = saved.provider === "browser";
    await refreshCore();
    setStatus("voice-status", "Guardada. La key no se vuelve a mostrar entera.", "ok");
  } catch (err) {
    setStatus("voice-status", err.message, "bad");
  }
}

async function listVoiceOptions() {
  $("v-listed").classList.remove("hidden");
  $("v-listed").replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Elegí…";
  $("v-listed").appendChild(empty);
  if ($("v-provider").value === "browser") {
    const voices = await Voice.browserVoices();
    for (const voice of voices) {
      const opt = document.createElement("option");
      opt.value = voice.name;
      opt.textContent = voice.name + " · " + voice.lang;
      $("v-listed").appendChild(opt);
    }
    setStatus("voice-status", voices.length ? "Voces del sistema." : "El navegador todavía no listó voces.", voices.length ? "ok" : "bad");
    return;
  }
  if (!state.editingVoiceId) {
    setStatus("voice-status", "Guardá la key de Fish antes de listar.", "bad");
    return;
  }
  try {
    const data = await api("/api/voices/" + state.editingVoiceId + "/models");
    for (const model of data.models) {
      const opt = document.createElement("option");
      opt.value = model.id;
      opt.textContent = model.name;
      $("v-listed").appendChild(opt);
    }
    setStatus("voice-status", data.models.length ? "Tus voces de Fish." : "No hay voces propias. Pegá un reference_id.", data.models.length ? "ok" : "bad");
  } catch (err) {
    setStatus("voice-status", err.message, "bad");
  }
}

async function testVoice() {
  if (!state.editingVoiceId) return;
  const found = state.voices.find((item) => item.id === state.editingVoiceId);
  if (!found) return;
  Voice.setAccount(found);
  Voice.preview("Hola. Esta es una prueba de voz.");
  setStatus("voice-status", found.provider === "fish" ? "Pidiendo audio a Fish…" : "Leyendo con el navegador.", "ok");
}

async function deleteVoice() {
  if (!state.editingVoiceId) return;
  if (!confirm("¿Borrar esta voz?")) return;
  try {
    await api("/api/voices/" + state.editingVoiceId, { method: "DELETE" });
    state.editingVoiceId = null;
    $("voice-form").reset();
    $("v-test").disabled = true;
    $("v-delete").disabled = true;
    syncVoiceFields();
    await refreshCore();
    closeModal("voice-editor");
    setStatus("voice-status", "Voz borrada.", "ok");
  } catch (err) {
    setStatus("voice-status", err.message, "bad");
  }
}

async function saveVoiceChoice() {
  if (!state.thread) return;
  const voiceId = $("chat-voice").value;
  try {
    const updated = await api("/api/threads/" + state.thread.id, {
      method: "PATCH",
      body: JSON.stringify({ voice_account_id: voiceId }),
    });
    state.thread.voice_account_id = updated.voice_account_id;
    const chosen = state.voices.find((item) => item.id === voiceId) || null;
    Voice.setAccount(chosen);
    Voice.cancel();
    toast(chosen ? "Este hilo lee con " + chosen.name + "." : "Este hilo no tiene voz.");
  } catch (err) {
    toast(err.message);
  }
}

async function toggleSpeak() {
  if (!state.thread) return;
  const next = state.thread.speak ? 0 : 1;
  let voiceId = $("chat-voice").value;
  if (next && !voiceId) {
    const browser = state.voices.find((item) => item.provider === "browser");
    if (browser) {
      voiceId = browser.id;
      $("chat-voice").value = voiceId;
    }
  }
  if (next && !voiceId) {
    toast("No hay un motor de voz.");
    return;
  }
  try {
    const updated = await api("/api/threads/" + state.thread.id, {
      method: "PATCH",
      body: JSON.stringify({ speak: next, voice_account_id: voiceId }),
    });
    state.thread.speak = updated.speak;
    state.thread.voice_account_id = updated.voice_account_id;
    Voice.setAccount(state.voices.find((item) => item.id === voiceId) || null);
    if (!next) Voice.cancel();
    $("speak-toggle").classList.toggle("on", Boolean(next));
    $("speak-toggle").setAttribute("aria-pressed", next ? "true" : "false");
  } catch (err) {
    toast(err.message);
  }
}

function stripSpeechMarks(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function punctuateSpeech(chunk) {
  let t = String(chunk || "").trim();
  if (!t) return "";
  if (/[¿¡]/.test(t) || /[.?!…]$/.test(t)) {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const body = t.replace(/^[¿¡\s]+/, "").replace(/[.?!…,;:]+$/g, "").trim();
  if (!body) return "";
  const plain = stripSpeechMarks(body);
  const question = /^(que|quien|cual|cuales|como|cuando|donde|adonde|por que|acaso)\b/.test(plain)
    || /\b(no|verdad|o que)$/.test(plain);
  const exclaim = /^(ay|uy|ah|oh|eh|basta|carajo|mierda|joder)\b/.test(plain);
  const capped = body.charAt(0).toUpperCase() + body.slice(1);
  if (question) return "¿" + capped + "?";
  if (exclaim) return "¡" + capped + "!";
  return capped + ".";
}

function speechDraft(event) {
  const finals = [];
  let interim = "";
  for (const result of event.results) {
    const bit = result[0].transcript;
    if (result.isFinal) finals.push(punctuateSpeech(bit));
    else interim += bit;
  }
  return [...finals, interim.trim()].filter(Boolean).join(" ");
}

function micOff() {
  state.listening = false;
  state.mediaRecorder = null;
  $("mic").classList.remove("on");
  $("mic").setAttribute("aria-pressed", "false");
  setStatus("chat-status", "");
}

async function toggleMic() {
  if (!state.thread) return;
  if (state.listening && state.mediaRecorder) {
    try { state.mediaRecorder.stop(); } catch { micOff(); }
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Este navegador no graba audio.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("El navegador bloqueó el micrófono.");
    return;
  }
  const chunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  state.mediaRecorder = rec;
  state.listening = true;
  $("mic").classList.add("on");
  $("mic").setAttribute("aria-pressed", "true");
  setStatus("chat-status", "Grabando… tocá de nuevo para transcribir");
  rec.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    micOff();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    if (blob.size < 256) {
      toast("No se capturó audio. Hablá con el mic prendido y tocá de nuevo para cortar.");
      return;
    }
    setStatus("chat-status", "Transcribiendo…");
    try {
      const body = new FormData();
      body.append("file", blob, "speech.webm");
      const res = await fetch("/api/threads/" + state.thread.id + "/transcribe", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data.detail;
        throw new Error(typeof detail === "string" ? detail : "No se pudo transcribir.");
      }
      const text = punctuateSpeech(data.text || "") || (data.text || "").trim();
      if (!text) throw new Error("No se entendió el audio.");
      const prev = ($("draft").value || "").trim();
      $("draft").value = prev ? prev + " " + text : text;
      growDraft();
    } catch (err) {
      toast(err.message);
    } finally {
      setStatus("chat-status", "");
      focusDraft();
    }
  };
  rec.start();
}

function hideSuggestMenu() {
  const menu = $("suggest-menu");
  menu.classList.add("hidden");
  menu.replaceChildren();
  $("suggest").setAttribute("aria-expanded", "false");
}

function showSuggestMenu(replies) {
  const menu = $("suggest-menu");
  menu.replaceChildren();
  state.suggestions = replies;
  const labels = ["Continuar", "Empujar", "Desviar"];
  replies.forEach((text, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggest-item";
    btn.setAttribute("role", "option");
    btn.dataset.suggest = String(index);
    const tag = document.createElement("small");
    tag.className = "suggest-label";
    tag.textContent = labels[index] || "";
    const body = document.createElement("span");
    body.textContent = text;
    btn.append(tag, body);
    menu.appendChild(btn);
  });
  menu.classList.remove("hidden");
  $("suggest").setAttribute("aria-expanded", "true");
}

function pickSuggestion(text) {
  $("draft").value = text;
  growDraft();
  hideSuggestMenu();
  focusDraft();
}

async function loadSuggestions() {
  if (!state.thread || state.streaming || state.suggesting) return;
  state.suggesting = true;
  $("suggest").classList.add("on");
  chatControls();
  hideSuggestMenu();
  try {
    const data = await api("/api/threads/" + state.thread.id + "/suggestions", { method: "POST" });
    const replies = data.replies || [];
    if (replies.length < 3) throw new Error("No se pudieron armar 3 opciones. Probá de nuevo.");
    showSuggestMenu(replies);
  } catch (err) {
    toast(err.message);
  } finally {
    state.suggesting = false;
    $("suggest").classList.remove("on");
    chatControls();
  }
}

function retryFrom(messageId) {
  const idx = state.messages.findIndex((msg) => msg.id === messageId);
  if (idx < 0) return;
  const laterUsers = state.messages.slice(idx + 1).filter((msg) => msg.role === "user");
  if (laterUsers.length && !confirm("Esto borra los turnos de después y genera de nuevo.")) return;
  streamTurn({ content: state.messages[idx].content, retryMessageId: messageId });
}

function send() {
  const content = $("draft").value.trim();
  if (!content) return;
  streamTurn({ content });
}

async function streamTurn(opts) {
  if (!state.thread || state.streaming) return;
  const content = (opts.content || "").trim();
  const retryMessageId = opts.retryMessageId || "";
  if (!retryMessageId && !content) return;
  const threadId = state.thread.id;
  state.streaming = true;
  state.voiceStopped = false;
  Voice.cancel();
  chatControls();
  if (retryMessageId) {
    const idx = state.messages.findIndex((msg) => msg.id === retryMessageId);
    if (idx >= 0) state.messages = state.messages.slice(0, idx + 1);
  } else {
    state.messages.push({ role: "user", content });
  }
  state.messages.push({ role: "assistant", content: "" });
  renderMessages();
  const box = $("messages");
  const nodes = box.querySelectorAll(".bubble.assistant");
  const target = nodes[nodes.length - 1];
  let acc = "";
  state.abort = new AbortController();
  try {
    const res = await fetch("/api/threads/" + threadId + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        retry_message_id: retryMessageId || null,
        model: $("chat-model").value.trim(),
        context_tokens: Number($("chat-context").value || 8192),
      }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = data.detail;
      if (!retryMessageId) {
        $("draft").value = content;
        growDraft();
      }
      throw new Error(typeof detail === "string" ? detail : "No se pudo enviar.");
    }
    if (!retryMessageId) {
      $("draft").value = "";
      growDraft();
    }
    await readSSE(res, (evt) => {
      if (evt.event === "delta" && evt.data.text) {
        acc += evt.data.text;
        if (target) fillFormatted(target, acc);
        box.scrollTop = box.scrollHeight;
        window.dispatchEvent(new CustomEvent("chat-ia-scene", { detail: { type: "line", text: acc } }));
        if (state.thread && state.thread.speak) Voice.feed(evt.data.text);
      }
      if (evt.event === "error") toast(evt.data.message || "Error del proveedor.");
    });
  } catch (err) {
    if (err.name !== "AbortError") toast(err.message);
  } finally {
    if (!state.voiceStopped && state.thread && state.thread.speak) Voice.flush();
    state.streaming = false;
    state.abort = null;
    chatControls();
    try {
      await refreshCore();
      await openThread(threadId);
    } catch {
      chatControls();
    }
  }
}

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseSSE(raw);
      if (evt) onEvent(evt);
    }
  }
  if (buf.trim()) {
    const evt = parseSSE(buf);
    if (evt) onEvent(evt);
  }
}

function parseSSE(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: { message: "No se pudo leer un evento del stream." } };
  }
}

boot().catch((err) => {
  toast(err.message);
});
