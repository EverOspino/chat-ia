import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

const mixamoVRMRigMap = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

const fbxCache = new Map();
const loader = new FBXLoader();

function findMixamo(asset, name) {
  return asset.getObjectByName(name) || asset.getObjectByName(name.replace("mixamorig", "mixamorig:"));
}

export async function loadMixamoClip(url, vrm, clipName) {
  if (!fbxCache.has(url)) fbxCache.set(url, loader.loadAsync(url));
  const asset = await fbxCache.get(url);
  const clip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com") || asset.animations[0];
  if (!clip || !vrm.humanoid) return null;

  const tracks = [];
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const quatA = new THREE.Quaternion();
  const vec3 = new THREE.Vector3();

  const hips = findMixamo(asset, "mixamorigHips");
  const motionHipsHeight = hips ? hips.position.y : 1;
  const vrmHipsY = vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(vec3).y || 1;
  const vrmRootY = vrm.scene.getWorldPosition(vec3).y;
  const hipsPositionScale = Math.abs(vrmHipsY - vrmRootY) / (motionHipsHeight || 1);
  const vrm0 = vrm.meta?.metaVersion === "0";

  for (const track of clip.tracks) {
    const parts = track.name.split(".");
    const mixamoRigName = (parts[0] || "").replace(/:/g, "");
    const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
    const vrmNodeName = vrmBoneName && vrm.humanoid.getNormalizedBoneNode(vrmBoneName)?.name;
    const mixamoRigNode = findMixamo(asset, mixamoRigName);
    if (!vrmNodeName || !mixamoRigNode) continue;
    const propertyName = parts[1];
    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
    if (mixamoRigNode.parent) mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);
    else parentRestWorldRotation.identity();

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        quatA.fromArray(values, i);
        quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        quatA.toArray(values, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(
        vrmNodeName + "." + propertyName,
        track.times,
        values.map((v, i) => (vrm0 && i % 2 === 0 ? -v : v)),
      ));
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map((v, i) => (vrm0 && i % 3 !== 1 ? -v : v) * hipsPositionScale);
      tracks.push(new THREE.VectorKeyframeTrack(vrmNodeName + "." + propertyName, track.times, values));
    }
  }

  if (!tracks.length) return null;
  return new THREE.AnimationClip(clipName || "vrmAnimation", clip.duration, tracks);
}
