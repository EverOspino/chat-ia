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
