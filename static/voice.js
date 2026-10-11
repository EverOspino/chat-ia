const Voice = (() => {
  let gen = 0;
  let queue = [];
  let playing = false;
  let buffer = "";
  let account = null;
  let audio = null;
  let onError = null;
  let volume = 1;
  let pending = "";
  let holdTimer = null;
  let startTimer = null;
  let flushed = false;
  const FISH_CHUNK = 720;

  function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return volume;
    return Math.min(1, Math.max(0, n));
  }

  function speakable(text) {
    return (text || "")
      .replace(/\*/g, " ")
      .replace(/[«»""“”]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function consume(raw) {
    let stripped = raw;
    let held = "";
    if ((stripped.match(/\*/g) || []).length % 2 === 1) {
      const cut = stripped.lastIndexOf("*");
      held = stripped.slice(cut);
      stripped = stripped.slice(0, cut);
    }
    const prepared = stripped.replace(/\*/g, " ").replace(/[«»""“”]/g, " ").replace(/[ \t]+/g, " ");
    const parts = [];
    let rest = prepared;
    const pattern = /^(.+?[.!?…])(?:\s+|$)/;
    while (rest) {
      const newline = rest.indexOf("\n");
      const match = rest.match(pattern);
      if (newline === 0) {
        rest = rest.slice(1);
        continue;
      }
      if (match && (newline < 0 || match[0].length <= newline)) {
        const sentence = match[1].trim();
        rest = rest.slice(match[0].length);
        if (sentence) parts.push(sentence);
        continue;
      }
      if (newline > 0) {
        const sentence = rest.slice(0, newline).trim();
        rest = rest.slice(newline + 1);
        if (sentence) parts.push(sentence);
        continue;
      }
      break;
    }
    return { parts, rest: rest + held };
  }

  function emit(detail) {
    window.dispatchEvent(new CustomEvent("chat-ia-scene", { detail }));
  }

  function browserVoice(name) {
    const synth = window.speechSynthesis;
    if (!synth) return null;
    const voices = synth.getVoices();
    if (name) {
      const found = voices.find((item) => item.name === name);
      if (found) return found;
    }
    return voices.find((item) => (item.lang || "").toLowerCase().startsWith("es")) || voices[0] || null;
  }

  function playUrl(url, token) {
    return new Promise((resolve, reject) => {
      if (token !== gen) {
        URL.revokeObjectURL(url);
        resolve();
        return;
      }
      const node = new Audio(url);
      node.volume = volume;
      audio = node;
      const started = performance.now();
      node.onplay = () => emit({ type: "audio-start", at: started, audio: node });
      node.onended = () => {
        URL.revokeObjectURL(url);
        if (audio === node) audio = null;
        emit({ type: "audio-end", at: performance.now() });
        resolve();
      };
      node.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo reproducir el audio."));
      };
      node.play().catch((err) => reject(err));
    });
  }

  function ensureVoices() {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve([]);
    const ready = synth.getVoices();
    if (ready.length) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener("voiceschanged", done, { once: true });
      setTimeout(done, 700);
    });
  }

  function playBrowser(text, token, boundAccount) {
    return new Promise((resolve, reject) => {
      const synth = window.speechSynthesis;
      if (!synth) {
        reject(new Error("Este navegador no tiene síntesis de voz."));
        return;
      }
      ensureVoices().then((voices) => {
        if (token !== gen) {
          resolve();
          return;
        }
        const local = boundAccount || account;
        if (!voices.length) {
          if (!local || !local.id) {
            reject(new Error("Brave no ve voces y no hay una cuenta de navegador para el respaldo local."));
            return;
          }
          emit({ type: "audio-start", at: performance.now(), local: true });
          fetch("/api/voices/" + local.id + "/speak", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          }).then(async (res) => {
            if (token !== gen) {
              resolve();
              return;
            }
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              reject(new Error(typeof data.detail === "string" ? data.detail : "La voz local no pudo leer."));
              return;
            }
            emit({ type: "audio-end", at: performance.now() });
            resolve();
          }).catch((err) => reject(err));
          return;
        }
        const utter = new SpeechSynthesisUtterance(text);
        const named = boundAccount && boundAccount.voice_id
          ? voices.find((item) => item.name === boundAccount.voice_id)
          : null;
        const voice = named || voices.find((item) => (item.lang || "").toLowerCase().startsWith("es")) || voices[0];
        utter.voice = voice;
        utter.lang = voice.lang || "es-AR";
        utter.volume = volume;
        const started = performance.now();
        utter.onstart = () => emit({ type: "audio-start", at: started, text });
        utter.onboundary = (event) => emit({
          type: "boundary",
          name: event.name,
          charIndex: event.charIndex,
          at: performance.now(),
        });
        utter.onend = () => {
          emit({ type: "audio-end", at: performance.now() });
          resolve();
        };
        utter.onerror = (event) => {
          const code = event.error || "";
          if (token !== gen || code === "interrupted" || code === "canceled") {
            resolve();
            return;
          }
          if (code === "language-unavailable" || code === "voice-unavailable" || code === "synthesis-failed") {
            reject(new Error("El navegador no pudo usar una voz. En Windows agregá una voz en español (Configuración > Hora e idioma > Voz); en Linux instalá speech-dispatcher y espeak-ng. Después reiniciá el navegador."));
            return;
          }
          reject(new Error("El navegador no pudo leer el texto (" + (code || "error") + ")."));
        };
        setTimeout(() => {
          if (token !== gen) {
            resolve();
            return;
          }
          synth.speak(utter);
        }, 80);
      });
    });
  }

  function fishAudio(use, text) {
    return fetch("/api/voices/" + use.id + "/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const detail = data.detail;
        throw new Error(typeof detail === "string" ? detail : "Fish Audio no pudo leer el texto.");
      }
      return res.blob();
    });
  }

  function isFish(use) {
    return Boolean(use && use.provider === "fish");
  }

  function attachFetch(item) {
    if (!item || item.fetch || !isFish(item.account)) return;
    item.fetch = fishAudio(item.account, item.text);
  }

  function armPlay() {
    if (playing) {
      if (queue[0]) attachFetch(queue[0]);
      return;
    }
    if (!isFish(account)) {
      if (flushed && queue.length) pump();
      return;
    }
    if (flushed || queue.length >= 2) {
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      pump();
      return;
    }
    if (queue.length >= 1 && !startTimer) {
      startTimer = setTimeout(() => {
        startTimer = null;
        pump();
      }, 700);
    }
  }

  async function speakOne(item, token) {
    const spoken = speakable(item.text);
    const use = item.account || account;
    if (!spoken || token !== gen) return;
    item.locked = true;
    emit({ type: "speak", text: spoken, provider: use && use.provider });
    if (!isFish(use)) {
      await playBrowser(spoken, token, use);
      return;
    }
    if (pending.length >= 80) releasePending();
    if (queue[0]) attachFetch(queue[0]);
    const blob = await (item.fetch || fishAudio(use, spoken));
    if (token !== gen) return;
    if (queue[0]) attachFetch(queue[0]);
    await playUrl(URL.createObjectURL(blob), token);
  }

  async function pump() {
    if (playing) return;
    playing = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        if (item.gen !== gen) continue;
        await speakOne(item, item.gen);
      }
    } catch (err) {
      if (onError) onError(err.message || "Falló la voz.");
      queue = [];
    } finally {
      playing = false;
      if (queue.length) pump();
    }
  }

  function enqueue(text, bound) {
    const spoken = speakable(text);
    if (!spoken) return;
    const use = bound || account;
    const last = queue[queue.length - 1];
    const limit = isFish(use) ? FISH_CHUNK : 4000;
    const canMerge = last && last.gen === gen && last.account === use && !last.locked && !last.fetch && (last.text + " " + spoken).length <= limit;
    if (canMerge) {
      last.text += " " + spoken;
      armPlay();
      return;
    }
    const item = { text: spoken, gen, account: use, locked: false, fetch: null };
    queue.push(item);
    attachFetch(item);
    armPlay();
  }

  function releasePending() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    const spoken = speakable(pending);
    pending = "";
    if (spoken) enqueue(spoken);
  }

  function hold(text) {
    const piece = speakable(text);
    if (!piece) return;
    pending = pending ? pending + " " + piece : piece;
    const fish = isFish(account);
    if (!fish) {
      if (flushed || pending.length >= 4000) releasePending();
      return;
    }
    if (pending.length >= FISH_CHUNK || (playing && pending.length >= 100) || (!playing && pending.length >= 180)) {
      releasePending();
      return;
    }
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(releasePending, playing ? 180 : 400);
  }

  return {
    setError(fn) { onError = fn; },
    setAccount(next) { account = next; },
    setVolume(next) {
      volume = clampVolume(next);
      if (audio) audio.volume = volume;
    },
    busy() { return playing || queue.length > 0 || Boolean(pending); },
    browserVoices() {
      return new Promise((resolve) => {
        const synth = window.speechSynthesis;
        if (!synth) { resolve([]); return; }
        const read = () => synth.getVoices();
        if (read().length) { resolve(read()); return; }
        const done = () => resolve(read());
        synth.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, 500);
      });
    },
    feed(delta) {
      buffer += delta || "";
      const taken = consume(buffer);
      buffer = taken.rest;
      for (const sentence of taken.parts) hold(sentence);
    },
    flush() {
      flushed = true;
      const rest = speakable(buffer);
      buffer = "";
      if (rest) hold(rest);
      releasePending();
      armPlay();
    },
    cancel() {
      gen += 1;
      buffer = "";
      pending = "";
      flushed = false;
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      queue = [];
      if (audio) {
        audio.pause();
        audio = null;
      }
      if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) {
        speechSynthesis.cancel();
      }
    },
    preview(text) {
      this.cancel();
      flushed = true;
      enqueue(text);
    },
  };
})();
