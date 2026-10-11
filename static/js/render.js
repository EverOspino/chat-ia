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

function threadGroup(iso) {
  const d = parseDate(iso);
  if (!d) return "Antes";
  const ago = daysAgo(d);
  if (ago <= 0) return "Hoy";
  if (ago === 1) return "Ayer";
  if (ago < 7) return "Esta semana";
  return "Antes";
}

function renderThreads() {
  const list = $("thread-list");
  list.replaceChildren();
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "muted list-note";
    p.textContent = text;
    list.appendChild(p);
  };
  if (!state.threads.length) {
    note("Todavía no hay conversaciones.");
    return;
  }
  const query = (state.threadQuery || "").trim().toLowerCase();
  const shown = state.threads.filter((thread) => {
    if (!query) return true;
    return [thread.title, thread.character_name].some((v) => String(v || "").toLowerCase().includes(query));
  });
  if (!shown.length) {
    note("Nada coincide con esa búsqueda.");
    return;
  }
  let group = "";
  for (const thread of shown) {
    const when = thread.updated_at || thread.created_at;
    const label = threadGroup(when);
    if (label !== group) {
      group = label;
      const head = document.createElement("p");
      head.className = "list-group";
      head.textContent = label;
      list.appendChild(head);
    }
    const active = state.thread && state.thread.id === thread.id;
    const row = document.createElement("div");
    row.className = "thread-row" + (active ? " active" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thread-item" + (active ? " active" : "");
    btn.dataset.thread = thread.id;
    const name = document.createElement("span");
    name.className = "thread-name";
    name.textContent = thread.title || thread.character_name || "Nuevo hilo";
    const sub = document.createElement("span");
    sub.className = "thread-sub";
    sub.textContent = [thread.character_name, dayLabel(when) === "Hoy" ? timeLabel(when) : formatDate(when)]
      .filter(Boolean)
      .join(" · ");
    btn.append(name, sub);
    const more = document.createElement("button");
    more.type = "button";
    more.className = "thread-more icon-btn";
    more.dataset.threadMenu = thread.id;
    more.title = "Más opciones";
    more.setAttribute("aria-label", "Más opciones de " + name.textContent);
    more.setAttribute("aria-haspopup", "menu");
    more.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>';
    row.append(btn, more);
    list.appendChild(row);
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
  let day = "";
  state.messages.forEach((msg, index) => {
    if (msg.role === "notice") return;
    const label = dayLabel(msg.created_at) || "Hoy";
    if (label !== day) {
      day = label;
      const sep = document.createElement("div");
      sep.className = "day-sep";
      const text = document.createElement("span");
      text.textContent = label;
      sep.appendChild(text);
      box.appendChild(sep);
    }
    box.appendChild(bubble(msg, index));
  });
  box.scrollTop = box.scrollHeight;
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13l11-6.5z"/></svg>',
  retry: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>',
};

function turnAction(kind, label, data, withText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = (kind === "retry" ? "retry" : kind === "play" ? "play-msg" : "copy-msg") + (withText ? " chip-btn" : " icon-btn");
  btn.dataset[kind] = data;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = ICONS[kind] + (withText ? "<span>" + label + "</span>" : "");
  return btn;
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
  const body = document.createElement("div");
  body.className = "turn-body";
  const name = (state.thread && state.thread.character_name) || "Personaje";
  if (msg.role === "assistant") {
    const face = document.createElement("div");
    face.className = "avatar-dot turn-avatar";
    face.setAttribute("aria-hidden", "true");
    paintAvatar(face, name, characterFoto(characterOf(state.thread)));
    wrap.appendChild(face);
    const meta = document.createElement("div");
    meta.className = "turn-meta";
    const who = document.createElement("strong");
    who.textContent = name;
    const when = document.createElement("span");
    when.textContent = timeLabel(msg.created_at);
    meta.append(who, when);
    body.appendChild(meta);
  }
  const node = document.createElement("div");
  node.className = "bubble " + msg.role;
  fillFormatted(node, msg.content);
  body.appendChild(node);
  const actions = document.createElement("div");
  actions.className = "turn-actions";
  const done = (msg.content || "").trim() && !state.streaming;
  const target = retryTarget(index);
  if (msg.role === "assistant" && done) {
    actions.appendChild(turnAction("play", "Leer", String(index), false));
    if (target) actions.appendChild(turnAction("retry", "Regenerar", target, true));
    actions.appendChild(turnAction("copy", "Copiar", String(index), true));
  } else if (msg.role === "user") {
    const when = document.createElement("span");
    when.className = "turn-time";
    when.textContent = timeLabel(msg.created_at);
    actions.appendChild(when);
    if (target && !state.streaming) actions.appendChild(turnAction("retry", "Reintentar", target, false));
  }
  if (actions.childNodes.length) body.appendChild(actions);
  wrap.appendChild(body);
  return wrap;
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
    const row = document.createElement("button");
    row.type = "button";
    row.className = "entity-row" + (state.editingCharacterId === character.id ? " active" : "");
    row.dataset.character = character.id;
    const dot = document.createElement("span");
    dot.className = "avatar-dot";
    paintAvatar(dot, character.name, characterFoto(character));
    const copy = document.createElement("span");
    copy.className = "entity-copy";
    const title = document.createElement("strong");
    title.textContent = character.name;
    const sub = document.createElement("small");
    sub.textContent = ["Versión " + character.version, characterUsed(character.id) ? "En uso" : ""]
      .filter(Boolean)
      .join(" · ");
    copy.append(title, sub);
    row.append(dot, copy);
    list.appendChild(row);
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
  if (provider.has_key) return { kind: "ok", label: "Conectada" };
  return { kind: "muted", label: "Sin key" };
}

// Fila de lista para Conexiones y Voces: marca a la izquierda, nombre y detalle, flecha.
function listRow(opts) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "entity-row" + (opts.active ? " active" : "");
  for (const [key, value] of Object.entries(opts.data || {})) row.dataset[key] = value;
  const mark = document.createElement("span");
  mark.className = opts.dot ? "status-dot " + opts.dot : "row-icon";
  if (opts.icon) mark.innerHTML = opts.icon;
  const copy = document.createElement("span");
  copy.className = "entity-copy";
  const title = document.createElement("strong");
  title.textContent = opts.name;
  const sub = document.createElement("small");
  sub.textContent = opts.sub || "";
  copy.append(title, sub);
  const chevron = document.createElement("span");
  chevron.className = "row-chevron";
  chevron.setAttribute("aria-hidden", "true");
  row.append(mark, copy, chevron);
  return row;
}

function emptyNote(list, text) {
  const p = document.createElement("p");
  p.className = "muted list-note";
  p.textContent = text;
  list.appendChild(p);
}

function renderProviders() {
  const list = $("provider-list");
  list.replaceChildren();
  if (!state.providers.length) emptyNote(list, "Todavía no hay conexiones.");
  for (const provider of state.providers) {
    const status = providerStatus(provider);
    list.appendChild(listRow({
      active: state.editingProviderId === provider.id,
      data: { provider: provider.id },
      dot: status.kind,
      name: provider.name,
      sub: status.label,
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
  const catalog = state.modelCache[state.editingProviderId] || [];
  const shown = catalog
    .filter((m) => !filter || m.id.toLowerCase().includes(filter) || (m.name || "").toLowerCase().includes(filter))
    .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id, "es"));
  if (!catalog.length) {
    emptyNote(list, state.editingProviderId ? "Probá la conexión para ver sus modelos." : "Guardá la conexión para ver sus modelos.");
  } else if (!shown.length) {
    emptyNote(list, "Ningún modelo coincide.");
  }
  for (const model of shown.slice(0, 80)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-item";
    btn.dataset.model = model.id;
    btn.dataset.context = model.context || "";
    btn.title = model.id;
    const copy = document.createElement("span");
    copy.className = "model-copy";
    const name = document.createElement("strong");
    name.textContent = model.name || model.id;
    const id = document.createElement("small");
    id.textContent = model.id;
    copy.append(name, id);
    btn.appendChild(copy);
    if (model.free) {
      const mark = document.createElement("span");
      mark.className = "free-badge";
      mark.textContent = "Free";
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
    emptyNote(list, "Todavía no hay intentos.");
    return;
  }
  const cell = (text, cls) => {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    return span;
  };
  const head = document.createElement("div");
  head.className = "usage-row usage-head";
  head.append(cell("Hora"), cell("Modelo"), cell("Estado"));
  list.appendChild(head);
  for (const event of state.usage) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const ok = !event.error_class && Number(event.http_status) === 200;
    const model = event.model ? event.model.split("/").pop().replace(/:free$/, "") : "Prueba";
    const label = ok ? "Correcto" : USAGE_LABELS[event.error_class] || event.error_class || "Error";
    const status = cell("", "usage-status");
    const dot = cell("", "status-dot " + (ok ? "ok" : "bad"));
    status.append(dot, document.createTextNode((event.http_status || "—") + " · " + label));
    const modelCell = cell(model, "usage-model");
    modelCell.title = event.model || "";
    row.append(cell(timeLabel(event.created_at)), modelCell, status);
    list.appendChild(row);
  }
}

const USAGE_LABELS = {
  "401": "Key inválida",
  "402": "Sin créditos",
  "429": "Límite",
  "429_global": "Límite del proveedor",
  "429_personal": "Límite personal",
  "502": "Sin respuesta",
  parse_empty: "Respuesta vacía",
  unknown: "Error",
};
