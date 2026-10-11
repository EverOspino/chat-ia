const state = {
  tab: "chat",
  providers: [],
  characters: [],
  threads: [],
  threadQuery: "",
  dirty: { character: false, provider: false, voice: false },
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

function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).includes("T") ? iso : String(iso).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = parseDate(iso);
  if (!d) return String(iso).slice(0, 10);
  return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

function daysAgo(d) {
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((start(new Date()) - start(d)) / 86400000);
}

function dayLabel(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  const ago = daysAgo(d);
  if (ago === 0) return "Hoy";
  if (ago === 1) return "Ayer";
  return d.toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
}

function timeLabel(iso) {
  const d = iso ? parseDate(iso) : new Date();
  return d ? d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Algunos navegadores bloquean la API del portapapeles: se usa el método viejo.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function initial(name) {
  const t = String(name || "?").trim();
  return t ? t[0].toUpperCase() : "?";
}

// Cada personaje tiene un tono propio, estable, sacado del nombre.
function nameHue(name) {
  let hue = 0;
  for (const ch of String(name || "").toLowerCase()) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  return hue;
}

function paintAvatar(node, name, foto) {
  if (!node) return;
  const photo = typeof foto === "string" && foto.startsWith("data:image/") ? foto : "";
  node.textContent = photo ? "" : initial(name);
  node.classList.toggle("has-photo", Boolean(photo));
  node.style.backgroundImage = photo ? 'url("' + photo + '")' : "";
  node.style.setProperty("--hue", String(nameHue(name)));
}

function characterOf(thread) {
  if (!thread) return null;
  return state.characters.find((item) => item.id === thread.character_id) || null;
}

function characterFoto(character) {
  return (character && character.fields && character.fields.foto) || "";
}

function confirmDiscard(kind) {
  if (!state.dirty[kind]) return true;
  if (!confirm("Hay cambios sin guardar en esta ficha. ¿Descartarlos?")) return false;
  state.dirty[kind] = false;
  return true;
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
