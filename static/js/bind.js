function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  $("menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
}

function bind() {
  $("menu-btn").addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
  $("menu-backdrop").addEventListener("click", () => setMenu(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("menu-open")) setMenu(false);
  });
  document.body.addEventListener("click", async (event) => {
    const threadMenuBtn = event.target.closest("[data-thread-menu]");
    if (threadMenuBtn) {
      toggleThreadMenu(threadMenuBtn);
      return;
    }
    const threadAction = event.target.closest("[data-thread-action]");
    if (threadAction) {
      const id = $("thread-menu").dataset.thread;
      hideThreadMenu();
      if (!id) return;
      const run = threadAction.dataset.threadAction === "rename" ? renameThread : removeThread;
      run(id).catch((err) => toast(err.message));
      return;
    }
    if (!event.target.closest("#thread-menu")) hideThreadMenu();
    // En celular el menú es un panel lateral: se cierra al elegir algo.
    if (event.target.closest("[data-tab], [data-thread], #new-thread-btn")) setMenu(false);
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
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const msg = state.messages[Number(copy.dataset.copy)];
      if (!msg || !msg.content) return;
      if (!(await copyText(msg.content))) {
        toast("No se pudo copiar.");
        return;
      }
      const label = copy.querySelector("span");
      if (label) {
        label.textContent = "Copiado";
        setTimeout(() => { label.textContent = "Copiar"; }, 1400);
      }
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
    const character = event.target.closest("[data-character]");
    if (character) {
      selectCharacter(character.dataset.character);
      return;
    }
    const voiceItem = event.target.closest("[data-voice]");
    if (voiceItem) {
      selectVoice(voiceItem.dataset.voice);
      return;
    }
    const provider = event.target.closest("[data-provider]");
    if (provider) {
      selectProvider(provider.dataset.provider);
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

  $("delete-thread").addEventListener("click", () => {
    if (!state.thread) return;
    removeThread(state.thread.id).catch((err) => toast(err.message));
  });

  $("character-form").addEventListener("input", (event) => {
    if (event.target.id === "photo-file") return;
    state.dirty.character = true;
    growFormAreas();
    scheduleCompile();
    if (event.target.id === "f-nombre") characterHead();
  });
  $("photo-file").addEventListener("change", async () => {
    const file = $("photo-file").files[0];
    $("photo-file").value = "";
    if (!file) return;
    try {
      setCharacterPhoto(await photoFromFile(file));
    } catch (err) {
      setStatus("character-status", err.message || "No se pudo leer la imagen.", "bad");
    }
  });
  $("photo-clear").addEventListener("click", () => setCharacterPhoto(""));
  $("thread-list").addEventListener("scroll", hideThreadMenu);
  window.addEventListener("resize", hideThreadMenu);
  $("provider-form").addEventListener("input", () => {
    state.dirty.provider = true;
  });
  $("voice-form").addEventListener("input", (event) => {
    if (event.target.id !== "v-sample") state.dirty.voice = true;
  });
  window.addEventListener("beforeunload", (event) => {
    if (!Object.values(state.dirty).some(Boolean)) return;
    event.preventDefault();
    event.returnValue = "";
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
      if (state.thread && state.thread.character_id === saved.id) {
        paintAvatar($("chat-avatar"), saved.name, characterFoto(saved));
        renderMessages();
      }
      setStatus("character-status", "Guardado. El próximo turno usa esta versión.", "ok");
    } catch (err) {
      setStatus("character-status", err.message, "bad");
    }
  });

  $("new-character-btn").addEventListener("click", async () => {
    try {
      if (!(await newCharacter())) return;
      $("f-nombre").focus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("delete-character").addEventListener("click", async () => {
    if (!state.editingCharacterId) return;
    if (!confirm("¿Borrar este personaje?")) return;
    try {
      await api("/api/characters/" + state.editingCharacterId, { method: "DELETE" });
      state.editingCharacterId = null;
      state.dirty.character = false;
      await refreshCore();
      ensureCharacterEditor();
      setStatus("character-status", "Borrado.", "ok");
    } catch (err) {
      setStatus("character-status", err.message, "bad");
    }
  });

  $("copy-prompt").addEventListener("click", async () => {
    const ok = await copyText($("prompt-preview").textContent);
    setStatus("character-status", ok ? "Prompt copiado." : "No se pudo copiar.", ok ? "ok" : "bad");
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
      providerHead(saved);
      state.dirty.provider = false;
      setStatus("provider-status", "Guardado. La key no se vuelve a mostrar entera.", "ok");
    } catch (err) {
      setStatus("provider-status", err.message, "bad");
    }
  });

  $("new-provider-btn").addEventListener("click", () => {
    if (!newProvider()) return;
    $("p-name").focus();
  });

  $("p-name").addEventListener("input", () => {
    providerHead(state.providers.find((item) => item.id === state.editingProviderId) || null);
  });

  $("p-key-eye").addEventListener("click", () => {
    const show = $("p-key").type === "password";
    $("p-key").type = show ? "text" : "password";
    $("p-key-eye").setAttribute("aria-pressed", show ? "true" : "false");
    $("p-key-eye").title = show ? "Ocultar clave" : "Mostrar clave";
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
    state.dirty.provider = false;
    await refreshCore();
    ensureProviderEditor();
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
  // Sin valor guardado, Number(null) daba 0 y la voz arrancaba muda.
  const rawVol = localStorage.getItem("chat-ia-volume");
  const savedVol = rawVol === null ? NaN : Number(rawVol);
  const vol = Number.isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : 1;
  const showVolume = (value) => {
    $("voice-volume").value = String(Math.round(value * 100));
    $("volume-value").textContent = Math.round(value * 100) + "%";
    $("voice-volume").style.setProperty("--fill", Math.round(value * 100) + "%");
  };
  showVolume(vol);
  Voice.setVolume(vol);
  $("voice-volume").addEventListener("input", () => {
    const next = Number($("voice-volume").value) / 100;
    showVolume(next);
    Voice.setVolume(next);
    localStorage.setItem("chat-ia-volume", String(next));
  });
  $("thread-search").addEventListener("input", () => {
    state.threadQuery = $("thread-search").value;
    renderThreads();
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
    if (!newVoice()) return;
    $("v-name").focus();
  });
  $("v-name").addEventListener("input", voiceHead);
  $("v-sample").addEventListener("input", () => {
    $("v-sample").dataset.touched = "1";
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
      hideThreadMenu();
      const ids = ["settings-modal", "new-thread-modal"];
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
