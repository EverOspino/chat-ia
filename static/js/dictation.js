function stripSpeechMarks(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function punctuateSpeech(chunk) {
  let t = String(chunk || "").trim();
  if (!t) return "";
  if (/[¿¡]/.test(t) || /[.?!…]$/.test(t)) {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  const body = t.replace(/^[¿¡\s]+/, "").replace(/[.?!…,;:]+$/g, "").trim();
  if (!body) return "";
  const plain = stripSpeechMarks(body);
  const question = /^(que|quien|cual|cuales|como|cuando|donde|adonde|por que|acaso)\b/.test(plain)
    || /\b(no|verdad|o que)$/.test(plain);
  const exclaim = /^(ay|uy|ah|oh|eh|basta|carajo|mierda|joder)\b/.test(plain);
  const capped = body.charAt(0).toUpperCase() + body.slice(1);
  if (question) return "¿" + capped + "?";
  if (exclaim) return "¡" + capped + "!";
  return capped + ".";
}

function speechDraft(event) {
  const finals = [];
  let interim = "";
  for (const result of event.results) {
    const bit = result[0].transcript;
    if (result.isFinal) finals.push(punctuateSpeech(bit));
    else interim += bit;
  }
  return [...finals, interim.trim()].filter(Boolean).join(" ");
}

function micOff() {
  state.listening = false;
  state.mediaRecorder = null;
  $("mic").classList.remove("on");
  $("mic").setAttribute("aria-pressed", "false");
  setStatus("chat-status", "");
}

async function toggleMic() {
  if (!state.thread) return;
  if (state.listening && state.mediaRecorder) {
    try { state.mediaRecorder.stop(); } catch { micOff(); }
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Este navegador no graba audio.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("El navegador bloqueó el micrófono.");
    return;
  }
  const chunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  state.mediaRecorder = rec;
  state.listening = true;
  $("mic").classList.add("on");
  $("mic").setAttribute("aria-pressed", "true");
  setStatus("chat-status", "Grabando… tocá de nuevo para transcribir");
  rec.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((track) => track.stop());
    micOff();
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    if (blob.size < 256) {
      toast("No se capturó audio. Hablá con el mic prendido y tocá de nuevo para cortar.");
      return;
    }
    setStatus("chat-status", "Transcribiendo…");
    try {
      const body = new FormData();
      body.append("file", blob, "speech.webm");
      const res = await fetch("/api/threads/" + state.thread.id + "/transcribe", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data.detail;
        throw new Error(typeof detail === "string" ? detail : "No se pudo transcribir.");
      }
      const text = punctuateSpeech(data.text || "") || (data.text || "").trim();
      if (!text) throw new Error("No se entendió el audio.");
      const prev = ($("draft").value || "").trim();
      $("draft").value = prev ? prev + " " + text : text;
      growDraft();
    } catch (err) {
      toast(err.message);
    } finally {
      setStatus("chat-status", "");
      focusDraft();
    }
  };
  rec.start();
}
