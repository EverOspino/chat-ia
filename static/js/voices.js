const VOICE_ICONS = {
  fish: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/></svg>',
  browser: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M9 20h6M12 16v4"/></svg>',
};

function renderVoices() {
  const list = $("voice-list");
  list.replaceChildren();
  if (!state.voices.length) emptyNote(list, "Todavía no hay voces.");
  for (const voice of state.voices) {
    list.appendChild(listRow({
      active: state.editingVoiceId === voice.id,
      data: { voice: voice.id },
      icon: VOICE_ICONS[voice.provider] || VOICE_ICONS.fish,
      name: voice.name,
      sub: voice.provider === "fish" ? (voice.has_key ? "Fish Audio" : "Fish Audio · sin key") : "Voz del sistema",
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
  const fish = $("v-provider").value === "fish";
  $("v-fish-fields").classList.toggle("hidden", !fish);
  $("voice-badge").textContent = fish ? "Síntesis de voz" : "Voz del sistema";
  $("voice-badge").classList.remove("hidden");
}

function voiceHead() {
  const name = $("v-name").value.trim();
  $("voice-title").textContent = name || (state.editingVoiceId ? "Sin nombre" : "Nueva voz");
  if (!$("v-sample").dataset.touched) {
    const who = (state.thread && state.thread.character_name) || (state.characters[0] && state.characters[0].name);
    $("v-sample").value = who ? "Hola, soy " + who + ". Me alegra verte por acá." : "Hola. Esta es una prueba de voz.";
  }
}

function selectVoice(id) {
  const found = state.voices.find((item) => item.id === id);
  if (found) fillVoiceForm(found);
}

function newVoice() {
  state.editingVoiceId = null;
  $("voice-form").reset();
  $("v-key").placeholder = "key de fish.audio";
  $("v-test").disabled = true;
  $("v-delete").disabled = true;
  $("v-listed").classList.add("hidden");
  delete $("v-sample").dataset.touched;
  syncVoiceFields();
  voiceHead();
  renderVoices();
  setStatus("voice-status", "");
}

function ensureVoiceEditor() {
  if (state.editingVoiceId && state.voices.some((v) => v.id === state.editingVoiceId)) return;
  if (state.voices.length) selectVoice(state.voices[0].id);
  else newVoice();
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
  Voice.preview($("v-sample").value.trim() || "Hola. Esta es una prueba de voz.");
  setStatus("voice-status", found.provider === "fish" ? "Pidiendo audio a Fish…" : "Leyendo con el navegador.", "ok");
}

async function deleteVoice() {
  if (!state.editingVoiceId) return;
  if (!confirm("¿Borrar esta voz?")) return;
  try {
    await api("/api/voices/" + state.editingVoiceId, { method: "DELETE" });
    state.editingVoiceId = null;
    await refreshCore();
    ensureVoiceEditor();
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
