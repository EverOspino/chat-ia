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
