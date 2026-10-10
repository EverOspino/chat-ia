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
let mouth = 0;
let speaking = false;
let localSpeak = false;
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

function setStatus(text) {
  if (status) status.textContent = text || "";
}

function resize() {
  const w = canvas.clientWidth || 280;
  const h = canvas.clientHeight || 360;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
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

function closeMouth() {
  expression("aa", 0);
  expression("a", 0);
  expression("ih", 0);
  expression("i", 0);
  expression("ou", 0);
  expression("u", 0);
  expression("ee", 0);
  expression("e", 0);
  expression("oh", 0);
  expression("o", 0);
  expression("joy", 0);
  const jaw = bone("jaw");
  if (jaw) jaw.rotation.set(0, 0, 0);
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
let altAction = null;
let altMix = 0;
let altMixFrom = 0;
let altMixTo = 0;
let altMixStart = 0;
let altMixDur = 700;
let nextIdleAlt = 0;
const CLIP_FADE = 0.7;
const KISS_FADE = 1.2;

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

function unstickArms() {
  const spread = 0.16;
  const left = bone("leftUpperArm");
  const right = bone("rightUpperArm");
  if (left) left.rotation.z -= spread;
  if (right) right.rotation.z += spread;
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

function altName() {
  return (altAction && altAction.getClip() && altAction.getClip().name) || "";
}

function kissPlaying() {
  return altName() === "kiss";
}

function gesturePlaying() {
  const n = altName();
  return n === "kiss" || n === "crazy";
}

function setAltMix(to, dur) {
  altMixFrom = altMix;
  altMixTo = to;
  altMixStart = performance.now();
  altMixDur = dur;
}

function startAlt(key, force) {
  const clip = clips[key];
  if (!mixer || !clip) return;
  if (altAction && !force) return;
  if (altAction && force) {
    altAction.stop();
    altAction = null;
    altMix = 0;
  }
  ensureIdle();
  const gesture = key === "kiss" || key === "crazy";
  altAction = mixer.clipAction(clip);
  altAction.setLoop(THREE.LoopOnce, 1);
  altAction.clampWhenFinished = false;
  altAction.reset();
  altAction.enabled = true;
  altAction.setEffectiveTimeScale(1);
  altAction.setEffectiveWeight(0);
  altAction.play();
  setAltMix(gesture ? 0.94 : 0.6, (gesture ? KISS_FADE : CLIP_FADE) * 1000);
}

function stopAlt() {
  if (!altAction || !idleAction) return;
  if (altMixTo === 0) return;
  const clip = altAction.getClip();
  if (clip && clip.duration) {
    altAction.time = Math.min(altAction.time, Math.max(0, clip.duration - 0.02));
  }
  altAction.paused = true;
  altAction.clampWhenFinished = true;
  idleAction.paused = false;
  idleAction.enabled = true;
  idleAction.play();
  setAltMix(0, (gesturePlaying() ? KISS_FADE : CLIP_FADE) * 1000);
}

function updateFade(now) {
  const span = Math.max(altMixDur, 1);
  const t = Math.min(1, (now - altMixStart) / span);
  const k = t * t * (3 - 2 * t);
  altMix = altMixFrom + (altMixTo - altMixFrom) * k;
  if (t >= 1) altMix = altMixTo;
  if (idleAction) idleAction.setEffectiveWeight(1 - altMix);
  if (altAction) altAction.setEffectiveWeight(altMix);
  if (altMixTo === 0 && altMix <= 0.001 && altAction) {
    altAction.setEffectiveWeight(0);
    altAction.paused = true;
    altAction.enabled = false;
    altAction = null;
    altMix = 0;
    altMixFrom = 0;
  }
}

function updateIdleClips(now) {
  if (!clips.idle) return;
  ensureIdle();
  updateFade(now);
  if (emotion === "kiss" || emotion === "crazy" || gesturePlaying()) {
    if (altAction) {
      const clip = altAction.getClip();
      const tail = gesturePlaying() ? KISS_FADE : CLIP_FADE;
      if (clip && clip.duration - altAction.time <= tail) stopAlt();
    }
    return;
  }
  if (speaking || emotion !== "idle") {
    if (altAction && !gesturePlaying()) stopAlt();
    return;
  }
  if (altAction) {
    const clip = altAction.getClip();
    if (clip && clip.duration - altAction.time <= CLIP_FADE) stopAlt();
    return;
  }
  if (!nextIdleAlt) nextIdleAlt = now + 12000 + Math.random() * 8000;
  if (now < nextIdleAlt) return;
  nextIdleAlt = now + 16000 + Math.random() * 22000;
  const roll = Math.random();
  if (clips.kiss && roll < 0.12) {
    emotion = "kiss";
    emotionUntil = now + 3200;
    startAlt("kiss", true);
    return;
  }
  if (clips.crazy && roll < 0.22) {
    emotion = "crazy";
    emotionUntil = now + 4000;
    startAlt("crazy", true);
    return;
  }
  if (!idleAlts.length) return;
  startAlt(idleAlts[Math.floor(Math.random() * idleAlts.length)]);
}

async function loadClips() {
  clips = {};
  idleAlts = [];
  idleAction = null;
  altAction = null;
  altMix = 0;
  altMixFrom = 0;
  altMixTo = 0;
  nextIdleAlt = performance.now() + 10000 + Math.random() * 10000;
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
  const extras = files.filter((n) => n !== base && !/dwarf/i.test(n) && (/idle/i.test(n) || /looking around/i.test(n)) && !/kiss|angry|clap|defeat|thank/i.test(n));
  const kissFile = files.find((n) => /kiss/i.test(n));
  const crazyFile = files.find((n) => /crazy/i.test(n));
  const toLoad = [base, ...extras];
  if (kissFile) toLoad.push(kissFile);
  if (crazyFile) toLoad.push(crazyFile);
  await Promise.all(toLoad.map(async (file) => {
    const key = file === kissFile ? "kiss" : file === crazyFile ? "crazy" : file === base ? "idle" : "alt:" + file;
    try {
      const clip = await loadMixamoClip("/api/animations/file?name=" + encodeURIComponent(file), vrm, key);
      if (!clip) return;
      clips[key] = clip;
      if (key !== "idle" && key !== "kiss" && key !== "crazy") idleAlts.push(key);
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

function applyZoom() {
  zoom = Math.min(2.4, Math.max(0.45, zoom));
  const limit = 1.4;
  pan.x = Math.min(limit, Math.max(-limit, pan.x));
  pan.y = Math.min(limit, Math.max(-limit, pan.y));
  const dist = baseDistance * zoom;
  const x = lookAt.x + pan.x;
  const y = lookAt.y + pan.y;
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

function readTags(text) {
  const blob = (text || "").toLowerCase();
  if (/beso|besu|besa |un beso|blow a kiss|manda un beso|sopla un beso/.test(blob)) return "kiss";
  if (/crazy|loco|loca|locura|demente|chalad|insensat/.test(blob)) return "crazy";
  const scores = { laugh: 0, angry: 0, surprise: 0, lean_in: 0, sad: 0 };
  const rules = [
    ["laugh", /ríe|rie |risa|jaj[aeo]|jeje|jiji|carcaj|sonríe|sonrie|se ríe|haha|jaja/g],
    ["angry", /enoja|enfada|grita|furios|rabia|odio|carajo|basta|ceño|molesta/g],
    ["surprise", /sorpren|asombr|abre los ojos|no puede ser|en serio|wow|¡eh|boquiabiert/g],
    ["lean_in", /acerca|inclina|se acerca|susurr|al oído|muy cerca|horcajadas|mima|caricia|cerca de la oreja/g],
    ["sad", /triste|llora|suspir|pena|solloz|lástima|lastima|melancol/g],
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
  const t = performance.now();
  target.happy = 0;
  target.angry = 0;
  target.sad = 0;
  target.surprised = 0;
  target.relaxed = 0;
  target.ih = 0;
  target.ou = 0;
  target.ee = 0;
  target.oh = 0;
  if (emotion === "laugh") {
    target.happy = 0.7;
    target.relaxed = 0.4;
  } else if (emotion === "kiss") {
    target.ou = 0.7;
    target.oh = 0.45;
  } else if (emotion === "crazy") {
    target.surprised = 0.55;
    target.happy = 0.35;
    target.relaxed = 0.25;
  } else if (emotion === "angry") target.angry = 0.75;
  else if (emotion === "surprise") target.surprised = 0.7;
  else if (emotion === "sad") target.sad = 0.65;
  else target.happy = 0;
}

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
  if (facePulse.kind === "surprise" && on) {
    target.surprised = 0.85;
    expr.surprised = 0.85;
    expression("surprised", 0.85);
  } else if (facePulse.kind === "giggle" && on) {
    target.relaxed = 0.55;
    expr.relaxed = 0.55;
    expression("relaxed", 0.55);
    if (restSmileName) expression(restSmileName, 0.5);
  } else if (facePulse.kind === "wink" && on && restSmileName) {
    expression(restSmileName, 0.4);
  }
}

function scheduleBlink(now) {
  const gap = speaking ? 3800 + Math.random() * 4200 : 3200 + Math.random() * 5200;
  nextBlink = now + gap;
  blinksLeft = 0;
}

function updateBlink(now) {
  if (facePulse.kind === "wink" && now < facePulse.until) {
    const left = facePulse.side === "left";
    expression("blink", 0);
    expression("blinkLeft", left ? 1 : 0);
    expression("blinkRight", left ? 0 : 1);
    return;
  }
  if (!nextBlink) scheduleBlink(now + 600);
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
  blink += (blinkTarget - blink) * (blinkTarget === 1 ? 0.62 : 0.38);
  expression("blink", blink);
  expression("blinkLeft", blink);
  expression("blinkRight", blink);
}

function updateLook(now) {
  look.x += (lookGoal.x - look.x) * 0.1;
  look.y += (lookGoal.y - look.y) * 0.1;
  expression("lookLeft", Math.max(0, -look.x));
  expression("lookRight", Math.max(0, look.x));
  expression("lookUp", Math.max(0, look.y));
  expression("lookDown", Math.max(0, -look.y));
}

function amplitude() {
  if (localSpeak) return 0.35 + Math.sin(performance.now() / 90) * 0.2;
  if (!analyser || !freq) return 0;
  analyser.getByteFrequencyData(freq);
  let sum = 0;
  const n = Math.min(freq.length, 24);
  for (let i = 0; i < n; i += 1) sum += freq[i];
  return Math.min(1, sum / n / 140);
}

function hookAudio(node) {
  if (!node || boundAudio === node) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const source = audioCtx.createMediaElementSource(node);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    freq = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    boundAudio = node;
  } catch {
    analyser = null;
  }
}

async function loadModel(name) {
  setStatus("Cargando " + name + "…");
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  clips = {};
  idleAction = null;
  altAction = null;
  altMix = 0;
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
  if (emotionUntil && now > emotionUntil && !speaking) emotion = "idle";
  if (speaking && emotion === "idle") emotion = "speak";
  aimEmotion();
  updateIdleFace(now);
  mouth += (amplitude() - mouth) * 0.35;
  target.aa = speaking ? Math.min(mouth * 0.8, 0.4) : 0;
  for (const key of Object.keys(expr)) {
    expr[key] += (target[key] - expr[key]) * 0.28;
    expression(key, expr[key]);
  }
  if (!speaking && !kissPlaying() && emotion !== "kiss") closeMouth();
  if (restSmileName && emotion !== "angry" && emotion !== "sad" && facePulse.kind !== "surprise") {
    const pulseOn = now < facePulse.until;
    let smile = 0.32;
    if (emotion === "kiss") smile = 0.4;
    else if (pulseOn && facePulse.kind === "giggle") smile = 0.5;
    else if (pulseOn && facePulse.kind === "wink") smile = 0.4;
    expression(restSmileName, smile);
  }
  if (emotion === "laugh") {
    expression("happy", 0.7);
    expression("relaxed", 0.42);
    if (restSmileName) expression(restSmileName, 0.5);
  }
  updateBlink(now);
  updateLook(now);
  updateIdleClips(now);
  if (mixer) mixer.update(dt);
  if (!speaking && !kissPlaying() && emotion !== "kiss") closeMouth();
  if (clips.idle) unstickArms();
  const ht = now / 1000;
  const head = bone("head");
  const neck = bone("neck");
  if (head) {
    head.rotation.y += Math.sin(ht * 0.28) * 0.006 + look.x * 0.03;
    head.rotation.x += Math.sin(ht * 0.35) * 0.004;
  }
  if (neck) {
    neck.rotation.y += Math.sin(ht * 0.28) * 0.003;
  }
  if (!clips.idle) {
    const t = now / 1000;
    const sway = Math.sin(t * 0.65) * 0.035;
    const drift = Math.sin(t * 0.37 + 0.8) * 0.02;
    const breath = Math.sin(t * 1.15) * 0.012;
    const hips = bone("hips");
    const hipRest = rest.get("hips");
    if (hips && hipRest) {
      hips.rotation.y = THREE.MathUtils.lerp(hips.rotation.y, hipRest.y + sway, 0.06);
      hips.rotation.z = THREE.MathUtils.lerp(hips.rotation.z, hipRest.z + drift * 0.35, 0.06);
    }
    const chest = bone("chest");
    if (chest && rest.get("chest")) {
      const base = rest.get("chest");
      const lean = emotion === "lean_in" ? -0.1 : (speaking ? -0.035 : 0) + sway * 0.25;
      chest.rotation.x = THREE.MathUtils.lerp(chest.rotation.x, base.x + lean + breath, 0.08);
      chest.rotation.y = THREE.MathUtils.lerp(chest.rotation.y, base.y + sway * 0.4, 0.08);
    }
    const head = bone("head");
    const headRest = rest.get("head");
    if (head && headRest) {
      head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, headRest.y - sway * 0.55 + drift, 0.07);
      head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, headRest.z - drift * 0.8, 0.07);
      head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, headRest.x + Math.sin(t * 0.5) * 0.015, 0.07);
    }
    applyArmPose();
  }
  if (vrm) vrm.update(dt);
  renderer.render(scene, camera);
}

window.addEventListener("chat-ia-scene", (event) => {
  const detail = event.detail || {};
  if (detail.type === "line" && detail.text) {
    const next = readTags(detail.text);
    if (next !== "speak" && next !== "idle") {
      emotion = next;
      emotionUntil = performance.now() + (next === "kiss" || next === "crazy" ? 3500 : 4200);
      if (next === "kiss" || next === "crazy") {
        if (altName() !== next) startAlt(next, true);
      }
    }
  }
  if (detail.type === "audio-start") {
    speaking = true;
    localSpeak = Boolean(detail.local);
    if (detail.audio) hookAudio(detail.audio);
    if (emotion === "idle") emotion = "speak";
  }
  if (detail.type === "boundary") mouth = 0.55;
  if (detail.type === "audio-end") {
    speaking = false;
    localSpeak = false;
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
  const dist = baseDistance * zoom;
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
