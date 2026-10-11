import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { loadMixamoClip } from "./mixamo.js";

const canvas = document.getElementById("avatar-canvas");
const picker = document.getElementById("avatar-pick");
const status = document.getElementById("avatar-status");
if (!canvas || !picker) throw new Error("falta el escenario");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
camera.position.set(0, 1.35, 1.55);
const hemi = new THREE.HemisphereLight(0xfff4e8, 0x2a241c, 1.1);
const key = new THREE.DirectionalLight(0xfff1df, 1.3);
key.position.set(0.4, 1.6, 1.2);
scene.add(hemi, key);

let vrm = null;
let rest = new Map();
let clock = new THREE.Clock();
let speaking = false;
let emotion = "idle";
let emotionUntil = 0;
const expr = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, happy: 0, angry: 0, sad: 0, surprised: 0, relaxed: 0 };
const FACE_ALIAS = {
  happy: ["happy"],
  sad: ["sad", "sorrow"],
  relaxed: ["relaxed", "fun"],
  aa: ["aa", "a"],
  ih: ["ih", "i"],
  ou: ["ou", "u"],
  ee: ["ee", "e"],
  oh: ["oh", "o"],
};
const target = { ...expr };
let audioCtx = null;
let analyser = null;
let freq = null;
let boundAudio = null;
let blink = 0;
let blinkTarget = 0;
let nextBlink = 0;
let blinkCloseUntil = 0;
let blinksLeft = 0;
let look = { x: 0, y: 0 };
let lookGoal = { x: 0, y: 0 };
let nextLook = 0;
let facePulse = { kind: "", until: 0, next: 0, side: "left" };
let faceCycle = 0;
let restSmileName = null;
let lookAt = new THREE.Vector3(0, 1.2, 0);
let baseDistance = 1.6;
let zoom = Number(localStorage.getItem("chat-ia-vrm-zoom")) || 1;
let pan = {
  x: Number(localStorage.getItem("chat-ia-vrm-pan-x")) || 0,
  y: Number(localStorage.getItem("chat-ia-vrm-pan-y")) || 0,
};
let drag = null;
// En pantalla vertical (celular) el chat tapa la mitad de abajo: se sube al personaje.
let portrait = false;

function setStatus(text) {
  if (status) status.textContent = text || "";
}

let lastSize = "";

function resize() {
  const w = canvas.clientWidth || 280;
  const h = canvas.clientHeight || 360;
  // setSize reasigna el buffer del canvas: hacerlo en cada cuadro provocaba tirones.
  if (lastSize === w + "x" + h) return;
  lastSize = w + "x" + h;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  const tall = camera.aspect < 0.8;
  if (tall !== portrait) {
    portrait = tall;
    applyZoom();
  }
}

function expression(name, value) {
  if (!vrm || !vrm.expressionManager) return;
  const names = FACE_ALIAS[name] || [name];
  for (const n of names) vrm.expressionManager.setValue(n, value);
}

function pickRestSmile() {
  restSmileName = null;
  const mgr = vrm && vrm.expressionManager;
  if (!mgr) return;
  const listed = (mgr.expressions || []).map((item) => item.expressionName).filter(Boolean);
  const extras = [];
  for (const key of ["happy", "joy", "fun", "aa", "blink"]) {
    try {
      if (mgr.getExpression && mgr.getExpression(key)) extras.push(key);
    } catch {
      extras.push(key);
    }
  }
  const names = listed.concat(extras);
  restSmileName = names.find((n) => /mouthsmile/i.test(n))
    || names.find((n) => /smile/i.test(n) && !/open|aa|joy|sad|frown/i.test(n))
    || names.find((n) => n === "happy")
    || (mgr.getExpression && mgr.getExpression("happy") ? "happy" : null)
    || "happy";
}

function bone(name) {
  if (!vrm || !vrm.humanoid) return null;
  return vrm.humanoid.getNormalizedBoneNode(name);
}

let armPose = [];
let mixer = null;
let clips = {};
let idleAlts = [];
let idleAction = null;
// Capas sobre el reposo: cada una sube y baja su peso con su propio fundido, así nunca hay cortes.
let layers = [];
let nextIdleAlt = 0;
const ARM_SPREAD = 0.16;
const IDLE_FADE = 0.9;
const GESTURE_FADE = 0.55;
// Las variantes de reposo no llegan al 100%: "Looking Around" completo le da la espalda a la cámara.
const IDLE_ALT_WEIGHT = 0.8;
// Los gestos duran entre estos segundos: "Clapping" dura 0,8 s y se repite; "Angry" dura 19 s y se corta.
const GESTURE_MIN = 2.4;
const GESTURE_MAX = 4.5;
const GESTURES = {
  kiss: /kiss/i,
  crazy: /crazy/i,
  angry: /angry/i,
  sad: /defeat/i,
  clap: /clap/i,
  thanks: /thank/i,
};
// Poses de reposo que sostienen objetos: sin el objeto, la mano queda rara.
const IDLE_SKIP = /dwarf|holding|briefcase/i;

function rawBone(name) {
  if (!vrm || !vrm.humanoid) return null;
  return vrm.humanoid.getRawBoneNode(name);
}

function armScore(upper, hand) {
  vrm.update(0);
  const handPos = hand.getWorldPosition(new THREE.Vector3());
  const shoulderPos = upper.getWorldPosition(new THREE.Vector3());
  const hips = bone("hips") || rawBone("hips");
  const hipPos = hips ? hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  const side = Math.sign(shoulderPos.x - hipPos.x) || Math.sign(shoulderPos.x) || 1;
  const outward = (handPos.x - hipPos.x) * side;
  const shoulderOut = Math.max(0.12, Math.abs(shoulderPos.x - hipPos.x));
  const target = shoulderOut + 0.045;
  const below = shoulderPos.y - handPos.y;
  const forward = Math.abs(handPos.z - shoulderPos.z);
  return below * 2 - Math.abs(outward - target) * 4 - forward * 0.3;
}

function relaxBone(node, child) {
  if (!node || !child) return null;
  const origin = { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z };
  let best = { ...origin };
  let bestScore = -Infinity;
  for (const axis of ["x", "y", "z"]) {
    for (const sign of [-1, 1]) {
      for (let i = 0; i <= 16; i += 1) {
        node.rotation.set(origin.x, origin.y, origin.z);
        node.rotation[axis] = origin[axis] + sign * (i / 16) * 1.7;
        const score = armScore(node, child);
        if (score > bestScore) {
          bestScore = score;
          best = { x: node.rotation.x, y: node.rotation.y, z: node.rotation.z };
        }
      }
    }
  }
  const open = 0.9;
  const rotation = {
    x: origin.x + (best.x - origin.x) * open,
    y: origin.y + (best.y - origin.y) * open,
    z: origin.z + (best.z - origin.z) * open,
  };
  node.rotation.set(rotation.x, rotation.y, rotation.z);
  return { node, rotation };
}

function dropArms() {
  armPose = [];
  if (!vrm) return;
  const sides = [
    ["leftUpperArm", "leftLowerArm", "leftHand"],
    ["rightUpperArm", "rightLowerArm", "rightHand"],
  ];
  for (const [upperName, lowerName, handName] of sides) {
    let upper = bone(upperName);
    let hand = bone(handName);
    let posed = relaxBone(upper, hand);
    vrm.update(0);
    if (posed && hand && upper) {
      const handPos = hand.getWorldPosition(new THREE.Vector3());
      const shoulderPos = upper.getWorldPosition(new THREE.Vector3());
      if (handPos.y > shoulderPos.y - 0.05) {
        upper.rotation.set(0, 0, 0);
        posed = relaxBone(rawBone(upperName), rawBone(handName) || hand);
      }
    }
    if (posed) armPose.push(posed);
  }
  applyArmPose();
  vrm.update(0);
}

function applyArmPose() {
  for (const pose of armPose) {
    pose.node.rotation.set(pose.rotation.x, pose.rotation.y, pose.rotation.z);
  }
}

function ensureIdle() {
  if (!mixer || !clips.idle) return;
  if (idleAction) return;
  idleAction = mixer.clipAction(clips.idle);
  idleAction.setLoop(THREE.LoopRepeat, Infinity);
  idleAction.enabled = true;
  idleAction.setEffectiveTimeScale(1);
  idleAction.setEffectiveWeight(1);
  idleAction.play();
}

function currentLayer() {
  return layers.find((layer) => layer.target > 0) || null;
}

function layerName() {
  const layer = currentLayer();
  return layer ? layer.key : "";
}

function kissPlaying() {
  return layerName() === "kiss";
}

function gesturePlaying() {
  const layer = currentLayer();
  return Boolean(layer && layer.gesture);
}

function playLayer(key, gesture) {
  const clip = clips[key];
  if (!mixer || !clip) return false;
  ensureIdle();
  for (const layer of layers) layer.target = 0;
  const action = mixer.clipAction(clip);
  let layer = layers.find((item) => item.action === action);
  if (!layer) {
    layer = { action, key, weight: 0, target: 0, fade: IDLE_FADE, gesture: false };
    layers.push(layer);
  }
  const reps = gesture && clip.duration < GESTURE_MIN ? Math.ceil(GESTURE_MIN / clip.duration) : 1;
  // Un clip nuevo arranca con peso 1: sin esto se veía un cuadro entero del gesto antes del fundido.
  const w = layer.weight;
  action.setEffectiveWeight((layer.max || 1) * w * w * (3 - 2 * w));
  action.reset();
  // Ida y vuelta en vez de repetir: el último cuadro de "Clapping" no empalma con el primero y la mano saltaba.
  action.setLoop(reps > 1 ? THREE.LoopPingPong : THREE.LoopOnce, reps);
  action.clampWhenFinished = true;
  action.enabled = true;
  action.setEffectiveTimeScale(1);
  action.play();
  layer.elapsed = 0;
  layer.length = gesture ? Math.min(clip.duration * reps, GESTURE_MAX) : clip.duration;
  layer.key = key;
  layer.gesture = gesture;
  layer.fade = gesture ? GESTURE_FADE : IDLE_FADE;
  layer.max = gesture ? 1 : IDLE_ALT_WEIGHT;
  layer.target = 1;
  return true;
}

function fadeOutLayers() {
  for (const layer of layers) layer.target = 0;
}

function updateLayers(dt) {
  let others = 0;
  for (const layer of layers) {
    layer.elapsed += dt;
    // Antes de que termine se empieza a volver al reposo: si el clip acaba antes, su último cuadro queda fijo.
    if (layer.target > 0 && layer.length - layer.elapsed <= layer.fade) layer.target = 0;
    const step = dt / Math.max(layer.fade, 0.05);
    if (layer.weight < layer.target) layer.weight = Math.min(layer.target, layer.weight + step);
    else layer.weight = Math.max(layer.target, layer.weight - step);
    const w = layer.weight;
    const eased = (layer.max || 1) * w * w * (3 - 2 * w);
    layer.action.setEffectiveWeight(eased);
    others += eased;
  }
  layers = layers.filter((layer) => {
    if (layer.target > 0 || layer.weight > 0) return true;
    layer.action.stop();
    layer.action.enabled = false;
    return false;
  });
  if (idleAction) idleAction.setEffectiveWeight(Math.max(0, 1 - Math.min(1, others)));
}

// Un gesto nuevo reemplaza al que esté sonando (con fundido); el límite de uno por respuesta lo pone quien llama.
function playGesture(key) {
  if (!clips[key] || layerName() === key) return false;
  return playLayer(key, true);
}

function updateIdleClips(now, dt) {
  if (!clips.idle) return;
  ensureIdle();
  updateLayers(dt);
  if (speaking && currentLayer() && !gesturePlaying()) fadeOutLayers();
  if (currentLayer() || speaking || emotion !== "idle") return;
  if (!nextIdleAlt) nextIdleAlt = now + 7000 + Math.random() * 6000;
  if (now < nextIdleAlt) return;
  nextIdleAlt = now + 9000 + Math.random() * 13000;
  const roll = Math.random();
  if (clips.kiss && roll < 0.07) {
    emotion = "kiss";
    emotionUntil = now + 3200;
    playGesture("kiss");
    return;
  }
  if (clips.crazy && roll < 0.12) {
    emotion = "crazy";
    emotionUntil = now + 4000;
    playGesture("crazy");
    return;
  }
  if (!idleAlts.length) return;
  playLayer(idleAlts[Math.floor(Math.random() * idleAlts.length)], false);
}

async function loadClips() {
  clips = {};
  idleAlts = [];
  idleAction = null;
  layers = [];
  nextIdleAlt = performance.now() + 7000 + Math.random() * 6000;
  if (mixer) mixer.stopAllAction();
  if (!vrm) return;
  mixer = new THREE.AnimationMixer(vrm.scene);
  let files = [];
  try {
    const data = await fetch("/api/animations").then((res) => res.json());
    files = data.clips || [];
  } catch {
    files = ["Idle.fbx"];
  }
  const base = files.find((n) => n.replace(/\.fbx$/i, "").toLowerCase() === "idle") || "Idle.fbx";
  const gestureFiles = {};
  for (const [key, re] of Object.entries(GESTURES)) {
    const found = files.find((n) => re.test(n));
    if (found) gestureFiles[found] = key;
  }
  const extras = files.filter((n) => n !== base && !gestureFiles[n] && !IDLE_SKIP.test(n) && /idle|looking around/i.test(n));
  const toLoad = [base, ...extras, ...Object.keys(gestureFiles)];
  await Promise.all(toLoad.map(async (file) => {
    const gestureKey = gestureFiles[file];
    const key = gestureKey || (file === base ? "idle" : "alt:" + file);
    try {
      // Los gestos se anclan en el lugar: si el clip camina, el personaje se saldría del cuadro.
      const clip = await loadMixamoClip("/api/animations/file?name=" + encodeURIComponent(file), vrm, key, {
        inPlace: Boolean(gestureKey),
      });
      if (!clip) return;
      clips[key] = clip;
      if (!gestureKey && key !== "idle") idleAlts.push(key);
    } catch {
      return;
    }
  }));
  ensureIdle();
}

function frameModel() {
  if (!vrm) return;
  vrm.scene.updateWorldMatrix(true, true);
  const head = bone("head");
  const hips = bone("hips");
  const headPos = head ? head.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 1.5, 0);
  const hipPos = hips ? hips.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 0.9, 0);
  const top = headPos.y + 0.16;
  const bottom = hipPos.y - 0.08;
  const focusY = (top + bottom) / 2;
  const height = Math.max(top - bottom, 0.7);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  lookAt = new THREE.Vector3(headPos.x, focusY, 0);
  baseDistance = (height / 2) / Math.tan(fov / 2) * 1.25;
  applyZoom();
}

function viewDistance() {
  // En vertical se aleja: la cara queda arriba y la cintura justo sobre el chat.
  return baseDistance * zoom * (portrait ? 1.6 : 1);
}

function applyZoom() {
  zoom = Math.min(2.4, Math.max(0.45, zoom));
  const limit = 1.4;
  pan.x = Math.min(limit, Math.max(-limit, pan.x));
  pan.y = Math.min(limit, Math.max(-limit, pan.y));
  const dist = viewDistance();
  const lift = portrait ? 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 0.17 : 0;
  const x = lookAt.x + pan.x;
  const y = lookAt.y + pan.y - lift;
  camera.position.set(x, y, lookAt.z + dist);
  camera.lookAt(x, y, lookAt.z);
  localStorage.setItem("chat-ia-vrm-zoom", String(zoom));
  localStorage.setItem("chat-ia-vrm-pan-x", String(pan.x));
  localStorage.setItem("chat-ia-vrm-pan-y", String(pan.y));
}

function rememberRest() {
  rest = new Map();
  for (const name of ["hips", "chest", "spine", "neck", "head"]) {
    const node = bone(name);
    if (node) rest.set(name, node.rotation.clone());
  }
}

// Suavizado que no depende de los cuadros por segundo: mismo ritmo en 60 o en 144 Hz.
function ease(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

// Gestos del cuerpo según lo que dice el texto. A lo sumo uno por respuesta.
const EMOTION_GESTURE = { kiss: "kiss", crazy: "crazy", angry: "angry", sad: "sad", laugh: "clap", thanks: "thanks" };
let turnLength = 0;
let turnGestured = false;

function readTags(text) {
  const blob = (text || "").toLowerCase();
  if (/beso|besu|besa |un beso|blow a kiss|manda un beso|sopla un beso/.test(blob)) return "kiss";
  if (/crazy|loco|loca|locura|demente|chalad|insensat/.test(blob)) return "crazy";
  const scores = { laugh: 0, angry: 0, surprise: 0, lean_in: 0, sad: 0, thanks: 0 };
  const rules = [
    ["laugh", /ríe|rie |risa|jaj[aeo]|jeje|jiji|carcaj|sonríe|sonrie|se ríe|haha|jaja|aplaud/g],
    ["angry", /enoja|enfada|grita|furios|rabia|odio|carajo|basta|ceño|molesta/g],
    ["surprise", /sorpren|asombr|abre los ojos|no puede ser|en serio|wow|¡eh|boquiabiert/g],
    ["lean_in", /acerca|inclina|se acerca|susurr|al oído|muy cerca|horcajadas|mima|caricia|cerca de la oreja/g],
    ["sad", /triste|llora|suspir|pena|solloz|lástima|lastima|melancol|abatid|derrotad/g],
    ["thanks", /gracias|agradec|te lo debo/g],
  ];
  for (const [name, re] of rules) {
    const hits = blob.match(re);
    if (hits) scores[name] = hits.length;
  }
  if ((blob.match(/!/g) || []).length >= 2) scores.laugh += 1;
  let best = speaking ? "speak" : "idle";
  let n = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > n) {
      n = score;
      best = name;
    }
  }
  return best;
}

function aimEmotion() {
  target.happy = 0;
  target.angry = 0;
  target.sad = 0;
  target.surprised = 0;
  target.relaxed = 0;
  if (emotion === "laugh") {
    target.happy = 0.7;
    target.relaxed = 0.4;
  } else if (emotion === "thanks") {
    target.happy = 0.45;
    target.relaxed = 0.35;
  } else if (emotion === "crazy") {
    target.surprised = 0.55;
    target.happy = 0.35;
    target.relaxed = 0.25;
  } else if (emotion === "angry") target.angry = 0.75;
  else if (emotion === "surprise") target.surprised = 0.7;
  else if (emotion === "sad") target.sad = 0.65;
}

// Microgestos de la cara en reposo. Solo mueven el objetivo: la transición la hace el suavizado.
function updateIdleFace(now) {
  if (emotion !== "idle" && emotion !== "speak") return;
  if (now >= facePulse.next) {
    const kinds = ["surprise", "giggle", "wink"];
    facePulse.kind = kinds[faceCycle % 3];
    faceCycle += 1;
    if (facePulse.kind === "surprise") facePulse.until = now + 1400;
    else if (facePulse.kind === "giggle") facePulse.until = now + 1600;
    else {
      facePulse.side = faceCycle % 2 ? "left" : "right";
      facePulse.until = now + 480;
    }
    facePulse.next = facePulse.until + 15000 + Math.random() * 10000;
  }
  const on = now < facePulse.until;
  if (facePulse.kind === "surprise" && on) target.surprised = 0.6;
  else if (facePulse.kind === "giggle" && on) target.relaxed = 0.5;
}

function scheduleBlink(now) {
  const gap = speaking ? 3800 + Math.random() * 4200 : 3200 + Math.random() * 5200;
  nextBlink = now + gap;
  blinksLeft = 0;
}

function updateBlink(now, dt) {
  if (facePulse.kind === "wink" && now < facePulse.until) {
    const left = facePulse.side === "left";
    expression("blink", 0);
    expression("blinkLeft", left ? 1 : 0);
    expression("blinkRight", left ? 0 : 1);
    return;
  }
  if (!nextBlink) scheduleBlink(now + 600);
  // Al mover mucho la mirada se parpadea: así lo hacen las personas.
  if (now >= nextBlink && blinkTarget === 0 && blink < 0.08) {
    if (blinksLeft <= 0) blinksLeft = Math.random() < 0.16 ? 2 : 1;
    blinkTarget = 1;
    blinkCloseUntil = now + 70 + Math.random() * 55;
    nextBlink = blinkCloseUntil + 400;
  }
  if (blinkTarget === 1 && now >= blinkCloseUntil) {
    blinkTarget = 0;
    blinksLeft -= 1;
    if (blinksLeft > 0) nextBlink = now + 90 + Math.random() * 70;
    else scheduleBlink(now);
  }
  blink += (blinkTarget - blink) * ease(blinkTarget === 1 ? 45 : 22, dt);
  expression("blink", blink);
  expression("blinkLeft", blink);
  expression("blinkRight", blink);
}

// La mirada salta de un punto a otro (rápido) y la cabeza la sigue (lento).
let headLook = { x: 0, y: 0 };

function updateLook(now, dt) {
  if (now >= nextLook) {
    const toUser = speaking ? 0.7 : 0.4;
    if (Math.random() < toUser) lookGoal = { x: 0, y: 0 };
    else lookGoal = { x: (Math.random() * 2 - 1) * 0.45, y: (Math.random() * 2 - 1) * 0.22 };
    const jump = Math.hypot(lookGoal.x - look.x, lookGoal.y - look.y);
    if (jump > 0.35 && blinkTarget === 0 && Math.random() < 0.5) nextBlink = now;
    nextLook = now + (speaking ? 1600 : 1200) + Math.random() * 2800;
  }
  look.x += (lookGoal.x - look.x) * ease(22, dt);
  look.y += (lookGoal.y - look.y) * ease(22, dt);
  headLook.x += (look.x - headLook.x) * ease(2.2, dt);
  headLook.y += (look.y - headLook.y) * ease(2.2, dt);
  expression("lookLeft", Math.max(0, -look.x));
  expression("lookRight", Math.max(0, look.x));
  expression("lookUp", Math.max(0, look.y));
  expression("lookDown", Math.max(0, -look.y));
}

// Habla: con audio (Fish) cada vocal sale de una franja del espectro;
// sin audio (voz del navegador) se generan sílabas con vocal y apertura al azar, empujadas por cada palabra.
const VOWELS = ["aa", "aa", "oh", "ee", "ih", "ou", "aa", "oh"];
let audioDriven = false;
let syllable = { start: 0, until: 0, shape: "aa", open: 0 };
let speechLevel = 0;
let nodImpulse = 0;

function nextSyllable(now) {
  const pause = Math.random() < 0.1;
  syllable = {
    start: now,
    until: now + (pause ? 140 + Math.random() * 120 : 95 + Math.random() * 120),
    shape: VOWELS[Math.floor(Math.random() * VOWELS.length)],
    open: pause ? 0 : 0.3 + Math.random() * 0.45,
  };
}

function band(from, to) {
  let sum = 0;
  for (let i = from; i < to && i < freq.length; i += 1) sum += freq[i];
  return sum / Math.max(1, to - from) / 255;
}

function speechShape(now) {
  const shape = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  if (!speaking) return { shape, level: 0 };
  if (audioDriven && analyser && freq) {
    analyser.getByteFrequencyData(freq);
    const low = band(1, 5);
    const mid = band(5, 14);
    const high = band(14, 40);
    const level = Math.min(1, (low * 0.8 + mid + high * 0.6) * 1.6);
    const total = low + mid + high + 1e-4;
    shape.ou = level * (low / total) * 0.9;
    shape.oh = level * (low / total) * 0.5;
    shape.aa = level * (mid / total) * 1.1;
    shape.ee = level * (high / total) * 0.8;
    shape.ih = level * (high / total) * 0.4;
    return { shape, level };
  }
  if (now >= syllable.until) nextSyllable(now);
  const t = Math.min(1, (now - syllable.start) / Math.max(1, syllable.until - syllable.start));
  const level = syllable.open * Math.sin(Math.PI * t);
  shape[syllable.shape] = level;
  if (syllable.shape !== "aa") shape.aa = level * 0.3;
  return { shape, level };
}

function hookAudio(node) {
  if (!node || boundAudio === node) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const source = audioCtx.createMediaElementSource(node);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.55;
    freq = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    boundAudio = node;
  } catch {
    analyser = null;
  }
}

// Desplazamientos sumados encima de la animación. Se deshacen antes del próximo cuadro
// para que no se acumulen en huesos que el clip no mueve.
const offsets = new Map();

function addOffset(name, x, y, z) {
  const node = bone(name);
  if (!node) return;
  const prev = offsets.get(node) || { x: 0, y: 0, z: 0 };
  prev.x += x;
  prev.y += y;
  prev.z += z;
  offsets.set(node, prev);
  node.rotation.x += x;
  node.rotation.y += y;
  node.rotation.z += z;
}

function clearOffsets() {
  for (const [node, off] of offsets) {
    node.rotation.x -= off.x;
    node.rotation.y -= off.y;
    node.rotation.z -= off.z;
  }
  offsets.clear();
}

async function loadModel(name) {
  setStatus("Cargando " + name + "…");
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  clips = {};
  idleAction = null;
  layers = [];
  offsets.clear();
  if (vrm) {
    scene.remove(vrm.scene);
    VRMUtils.deepDispose(vrm.scene);
    vrm = null;
  }
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync("/api/avatars/file?name=" + encodeURIComponent(name));
  vrm = gltf.userData.vrm;
  if (!vrm) throw new Error("Ese archivo no es un VRM.");
  VRMUtils.rotateVRM0(vrm);
  if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
  pickRestSmile();
  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  scene.add(vrm.scene);
  frameModel();
  rememberRest();
  await loadClips();
  if (!clips.idle) dropArms();
  localStorage.setItem("chat-ia-vrm", name);
  setStatus(name.replace(/\.vrm$/i, ""));
}

function tick() {
  requestAnimationFrame(tick);
  resize();
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  const t = now / 1000;
  if (emotionUntil && now > emotionUntil && !speaking) emotion = "idle";
  if (speaking && emotion === "idle") emotion = "speak";
  aimEmotion();
  updateIdleFace(now);
  const { shape, level } = speechShape(now);
  speechLevel += (level - speechLevel) * ease(18, dt);
  const faceRate = ease(9, dt);
  const mouthRate = ease(24, dt);
  for (const key of Object.keys(expr)) {
    const mouthKey = key in shape;
    let goal = mouthKey ? Math.min(shape[key], 0.75) : target[key];
    if (mouthKey && emotion === "kiss" && !speaking) goal = key === "ou" ? 0.7 : key === "oh" ? 0.45 : 0;
    expr[key] += (goal - expr[key]) * (mouthKey ? mouthRate : faceRate);
    expression(key, expr[key]);
  }
  if (restSmileName && emotion !== "angry" && emotion !== "sad" && !(facePulse.kind === "surprise" && now < facePulse.until)) {
    const pulseOn = now < facePulse.until;
    let smile = 0.3;
    if (emotion === "kiss" || emotion === "thanks") smile = 0.4;
    else if (emotion === "laugh" || (pulseOn && facePulse.kind === "giggle")) smile = 0.5;
    else if (pulseOn && facePulse.kind === "wink") smile = 0.4;
    expression(restSmileName, smile);
  }
  updateBlink(now, dt);
  updateLook(now, dt);

  clearOffsets();
  updateIdleClips(now, dt);
  if (mixer) mixer.update(dt);
  if (clips.idle) {
    // Separa un poco los brazos del cuerpo. Va como desplazamiento (se deshace cada cuadro):
    // three.js no reescribe un hueso si el clip no cambió, y sumarlo directo se acumulaba y daba un salto.
    addOffset("leftUpperArm", 0, 0, -ARM_SPREAD);
    addOffset("rightUpperArm", 0, 0, ARM_SPREAD);
  }

  // Encima de la animación: respiración, cabeza que sigue a la mirada, microvaivén y asentir al hablar.
  const breath = Math.sin(t * Math.PI * 2 * 0.24);
  addOffset("chest", breath * 0.012, 0, 0);
  addOffset("upperChest", breath * 0.008, 0, 0);
  addOffset("leftShoulder", 0, 0, breath * 0.012);
  addOffset("rightShoulder", 0, 0, -breath * 0.012);
  nodImpulse += (0 - nodImpulse) * ease(6, dt);
  const sway = Math.sin(t * 0.31) * 0.012 + Math.sin(t * 0.73 + 1.3) * 0.006;
  const tilt = Math.sin(t * 0.23 + 0.6) * 0.014;
  const nod = speechLevel * 0.06 + nodImpulse;
  addOffset("head", -headLook.y * 0.09 + nod + Math.sin(t * 0.41) * 0.006, headLook.x * 0.16 + sway, tilt);
  addOffset("neck", nod * 0.4, headLook.x * 0.06 + sway * 0.5, 0);
  const lean = emotion === "lean_in" ? -0.07 : speaking ? -0.025 : 0;
  addOffset("spine", lean, 0, 0);

  if (!clips.idle) {
    const drift = Math.sin(t * 0.37 + 0.8) * 0.02;
    const hips = bone("hips");
    const hipRest = rest.get("hips");
    if (hips && hipRest) {
      hips.rotation.y = THREE.MathUtils.lerp(hips.rotation.y, hipRest.y + Math.sin(t * 0.65) * 0.035, ease(4, dt));
      hips.rotation.z = THREE.MathUtils.lerp(hips.rotation.z, hipRest.z + drift * 0.35, ease(4, dt));
    }
    applyArmPose();
  }
  if (vrm) vrm.update(dt);
  renderer.render(scene, camera);
}

window.addEventListener("chat-ia-scene", (event) => {
  const detail = event.detail || {};
  if (detail.type === "line" && detail.text) {
    // Un texto más corto que el anterior es una respuesta nueva: vuelve a permitir un gesto.
    if (detail.text.length < turnLength) turnGestured = false;
    turnLength = detail.text.length;
    const next = readTags(detail.text);
    if (next !== "speak" && next !== "idle" && next !== emotion) {
      emotion = next;
      emotionUntil = performance.now() + (next === "kiss" || next === "crazy" ? 3500 : 4200);
      const gesture = EMOTION_GESTURE[next];
      if (gesture && !turnGestured && playGesture(gesture)) turnGestured = true;
    }
  }
  if (detail.type === "audio-start") {
    speaking = true;
    audioDriven = Boolean(detail.audio);
    if (detail.audio) hookAudio(detail.audio);
    syllable.until = 0;
    if (emotion === "idle") emotion = "speak";
  }
  if (detail.type === "boundary") {
    // Cada palabra de la voz del navegador arranca una sílaba nueva y da un pequeño asentimiento.
    syllable.until = 0;
    nodImpulse = Math.min(0.05, nodImpulse + 0.02);
  }
  if (detail.type === "audio-end") {
    speaking = false;
    audioDriven = false;
    if (emotion === "speak") emotion = "idle";
  }
});

const stage = canvas.closest(".stage");
const chatLayout = document.getElementById("view-chat");
const savedWidth = Number(localStorage.getItem("chat-ia-stage-width"));
if (chatLayout && savedWidth >= 180) chatLayout.style.setProperty("--stage-width", savedWidth + "px");
if (stage && chatLayout) {
  const handle = document.createElement("div");
  handle.className = "stage-resize";
  handle.title = "Arrastrá para cambiar el ancho";
  stage.prepend(handle);
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = stage.getBoundingClientRect().width;
    document.body.classList.add("resizing-stage");
    const move = (ev) => {
      const next = Math.min(720, Math.max(180, startW + startX - ev.clientX));
      chatLayout.style.setProperty("--stage-width", next + "px");
    };
    const up = () => {
      document.body.classList.remove("resizing-stage");
      localStorage.setItem("chat-ia-stage-width", String(Math.round(stage.getBoundingClientRect().width)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

canvas.title = "Arrastrá para mover. Rueda: zoom. Doble clic: encuadre.";
canvas.style.cursor = "grab";
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoom *= event.deltaY > 0 ? 1.08 : 0.92;
  applyZoom();
}, { passive: false });
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = "grabbing";
  drag = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const w = Math.max(canvas.clientWidth, 1);
  const h = Math.max(canvas.clientHeight, 1);
  const dist = viewDistance();
  const worldH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const worldW = worldH * (w / h);
  pan.x = drag.panX - ((event.clientX - drag.x) / w) * worldW;
  pan.y = drag.panY + ((event.clientY - drag.y) / h) * worldH;
  applyZoom();
});
function endDrag(event) {
  if (!drag) return;
  if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  drag = null;
  canvas.style.cursor = "grab";
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("dblclick", () => {
  zoom = 1;
  pan.x = 0;
  pan.y = 0;
  applyZoom();
});

picker.addEventListener("change", () => {
  loadModel(picker.value).catch((err) => setStatus(err.message || "No se pudo cargar el VRM."));
});

async function boot() {
  resize();
  tick();
  try {
    const data = await fetch("/api/avatars").then((res) => res.json());
    picker.replaceChildren();
    for (const name of data.avatars || []) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace(/\.vrm$/i, "");
      picker.appendChild(opt);
    }
    const saved = localStorage.getItem("chat-ia-vrm");
    const pick = (data.avatars || []).includes(saved) ? saved : data.default;
    if (!pick) {
      setStatus("No hay un VRM disponible.");
      return;
    }
    picker.value = pick;
    await loadModel(pick);
  } catch (err) {
    setStatus(err.message || "No se pudo abrir el escenario.");
  }
}

boot();
