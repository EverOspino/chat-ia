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
