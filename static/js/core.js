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
