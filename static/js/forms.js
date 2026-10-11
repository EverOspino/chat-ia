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
    foto: $("f-foto").value,
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
  $("f-foto").value = data.foto || "";
  $("delete-character").disabled = !state.editingCharacterId;
  characterHead(version);
  state.dirty.character = false;
  requestAnimationFrame(growFormAreas);
}

// Recorta al centro y achica a 160 px: alcanza para el avatar y pesa poco.
async function photoFromFile(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Elegí una imagen.");
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  canvas.getContext("2d").drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    160,
    160
  );
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

function setCharacterPhoto(dataUrl) {
  $("f-foto").value = dataUrl || "";
  characterHead();
  $("character-form").dispatchEvent(new Event("input", { bubbles: true }));
}

function characterUsed(id) {
  return state.threads.some((thread) => thread.character_id === id);
}

function characterHead(version) {
  const name = $("f-nombre").value.trim();
  $("character-title").textContent = name || (state.editingCharacterId ? "Sin nombre" : "Nuevo personaje");
  const foto = $("f-foto").value;
  paintAvatar($("character-avatar"), name, foto);
  paintAvatar($("photo-preview"), name, foto);
  $("photo-clear").disabled = !foto;
  const badge = $("character-badge");
  if (version !== undefined) badge.dataset.version = version || "";
  const v = badge.dataset.version;
  const parts = [];
  if (v) parts.push("Versión " + v);
  if (state.editingCharacterId && characterUsed(state.editingCharacterId)) parts.push("En uso");
  badge.textContent = parts.join(" · ") || "Sin guardar";
  badge.classList.remove("hidden");
}

function selectCharacter(id) {
  const found = state.characters.find((item) => item.id === id);
  if (!found) return;
  if (found.id !== state.editingCharacterId && !confirmDiscard("character")) return;
  state.editingCharacterId = found.id;
  fillCharacterForm(found.fields, found.version);
  $("prompt-preview").textContent = found.prompt_compiled;
  setStatus("character-status", "");
  renderCharacters();
}

async function newCharacter() {
  if (!confirmDiscard("character")) return false;
  state.editingCharacterId = null;
  const defaults = await api("/api/defaults");
  fillCharacterForm(defaults.fields, "");
  $("prompt-preview").textContent = defaults.prompt_compiled;
  setStatus("character-status", "");
  renderCharacters();
  return true;
}

// Al entrar a Personajes siempre hay una ficha a la vista: la elegida, la primera o una nueva.
function ensureCharacterEditor() {
  if (state.editingCharacterId && state.characters.some((c) => c.id === state.editingCharacterId)) return;
  if (state.characters.length) selectCharacter(state.characters[0].id);
  else newCharacter().catch((err) => toast(err.message));
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
