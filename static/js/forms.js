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
