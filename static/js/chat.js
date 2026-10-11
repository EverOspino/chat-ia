function hideSuggestMenu() {
  const menu = $("suggest-menu");
  menu.classList.add("hidden");
  menu.replaceChildren();
  $("suggest").setAttribute("aria-expanded", "false");
}

function showSuggestMenu(replies) {
  const menu = $("suggest-menu");
  menu.replaceChildren();
  state.suggestions = replies;
  const labels = ["Continuar", "Empujar", "Desviar"];
  replies.forEach((text, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggest-item";
    btn.setAttribute("role", "option");
    btn.dataset.suggest = String(index);
    const tag = document.createElement("small");
    tag.className = "suggest-label";
    tag.textContent = labels[index] || "";
    const body = document.createElement("span");
    body.textContent = text;
    btn.append(tag, body);
    menu.appendChild(btn);
  });
  menu.classList.remove("hidden");
  $("suggest").setAttribute("aria-expanded", "true");
}

function pickSuggestion(text) {
  $("draft").value = text;
  growDraft();
  hideSuggestMenu();
  focusDraft();
}

async function loadSuggestions() {
  if (!state.thread || state.streaming || state.suggesting) return;
  state.suggesting = true;
  $("suggest").classList.add("on");
  chatControls();
  hideSuggestMenu();
  try {
    const data = await api("/api/threads/" + state.thread.id + "/suggestions", { method: "POST" });
    const replies = data.replies || [];
    if (replies.length < 3) throw new Error("No se pudieron armar 3 opciones. Probá de nuevo.");
    showSuggestMenu(replies);
  } catch (err) {
    toast(err.message);
  } finally {
    state.suggesting = false;
    $("suggest").classList.remove("on");
    chatControls();
  }
}

function retryFrom(messageId) {
  const idx = state.messages.findIndex((msg) => msg.id === messageId);
  if (idx < 0) return;
  const laterUsers = state.messages.slice(idx + 1).filter((msg) => msg.role === "user");
  if (laterUsers.length && !confirm("Esto borra los turnos de después y genera de nuevo.")) return;
  streamTurn({ content: state.messages[idx].content, retryMessageId: messageId });
}

function send() {
  const content = $("draft").value.trim();
  if (!content) return;
  streamTurn({ content });
}

async function streamTurn(opts) {
  if (!state.thread || state.streaming) return;
  const content = (opts.content || "").trim();
  const retryMessageId = opts.retryMessageId || "";
  if (!retryMessageId && !content) return;
  const threadId = state.thread.id;
  state.streaming = true;
  state.voiceStopped = false;
  Voice.cancel();
  chatControls();
  if (retryMessageId) {
    const idx = state.messages.findIndex((msg) => msg.id === retryMessageId);
    if (idx >= 0) state.messages = state.messages.slice(0, idx + 1);
  } else {
    state.messages.push({ role: "user", content });
  }
  state.messages.push({ role: "assistant", content: "" });
  renderMessages();
  const box = $("messages");
  const nodes = box.querySelectorAll(".bubble.assistant");
  const target = nodes[nodes.length - 1];
  let acc = "";
  state.abort = new AbortController();
  try {
    const res = await fetch("/api/threads/" + threadId + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        retry_message_id: retryMessageId || null,
        model: $("chat-model").value.trim(),
        context_tokens: Number($("chat-context").value || 8192),
      }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const detail = data.detail;
      if (!retryMessageId) {
        $("draft").value = content;
        growDraft();
      }
      throw new Error(typeof detail === "string" ? detail : "No se pudo enviar.");
    }
    if (!retryMessageId) {
      $("draft").value = "";
      growDraft();
    }
    await readSSE(res, (evt) => {
      if (evt.event === "delta" && evt.data.text) {
        acc += evt.data.text;
        if (target) fillFormatted(target, acc);
        box.scrollTop = box.scrollHeight;
        window.dispatchEvent(new CustomEvent("chat-ia-scene", { detail: { type: "line", text: acc } }));
        if (state.thread && state.thread.speak) Voice.feed(evt.data.text);
      }
      if (evt.event === "error") toast(evt.data.message || "Error del proveedor.");
    });
  } catch (err) {
    if (err.name !== "AbortError") toast(err.message);
  } finally {
    if (!state.voiceStopped && state.thread && state.thread.speak) Voice.flush();
    state.streaming = false;
    state.abort = null;
    chatControls();
    try {
      await refreshCore();
      await openThread(threadId);
    } catch {
      chatControls();
    }
  }
}

async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseSSE(raw);
      if (evt) onEvent(evt);
    }
  }
  if (buf.trim()) {
    const evt = parseSSE(buf);
    if (evt) onEvent(evt);
  }
}

function parseSSE(raw) {
  let event = "message";
  const data = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: { message: "No se pudo leer un evento del stream." } };
  }
}
