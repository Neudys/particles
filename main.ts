import * as THREE from "three";
import "./style.css";
import "./glitch.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";

// LOADER
const loader = new GLTFLoader();

const DEFAULT_MODEL = "falling.glb";
let currentModelUrl = DEFAULT_MODEL;

const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();

const params = {
  radius: 26.6,
  strength: 2.5,
  returnSpeed: 0.01,
  points: 80000,
  space: 1,
  pointSize: 0.3,
  fluffScale: 1.011,
  fluffJitterX: 0.5,
  fluffJitterY: 1.0,
  fluffJitterZ: 0.5,
  fluffStrengthMul: 1.15,
  baseVisible: true,
  fluffVisible: true,
};

// SCENE
const scene = new THREE.Scene();

// RENDERER (USANDO CANVAS #canvas)
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "high-performance",
  alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);

// CAMERA + CONTROLS
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);
camera.position.z = 155;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.005;
controls.minDistance = 50;
controls.maxDistance = 150;

// MULTI-MESH SAMPLING
let samplers: MeshSurfaceSampler[] = [];
let meshCumWeights: number[] = [];
let allMeshes: THREE.Mesh[] = [];

function buildSamplersFromScene(root: THREE.Object3D) {
  samplers = [];
  meshCumWeights = [];
  allMeshes = [];

  const weights: number[] = [];

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const geo = obj.geometry;
      if (!geo || !geo.attributes?.position) return;

      allMeshes.push(obj);
      samplers.push(new MeshSurfaceSampler(obj).build());

      geo.computeBoundingSphere();
      const r = geo.boundingSphere?.radius ?? 1;
      weights.push(Math.max(1e-6, r * r));
    }
  });

  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] / total;
    meshCumWeights.push(acc);
  }
}

function pickSamplerIndex(): number {
  if (samplers.length <= 1) return 0;
  const r = Math.random();
  for (let i = 0; i < meshCumWeights.length; i++) {
    if (r <= meshCumWeights[i]) return i;
  }
  return meshCumWeights.length - 1;
}

// POINTS
const pointsGeometry = new THREE.BufferGeometry();
const vertices: number[] = [];
const tempPosition = new THREE.Vector3();

let pointsRef: THREE.Points | null = null;
let pointsCopyRef: THREE.Points | null = null;

let originalPositions: Float32Array | null = null;
let originalPositionsCopy: Float32Array | null = null;

let pointsMaterialBase: THREE.PointsMaterial | null = null;
let pointsMaterialFluff: THREE.PointsMaterial | null = null;

const particleTexture = new THREE.TextureLoader().load("particle.jpg");

// HELPERS
function returnToOriginalGeometry(
  geometry: THREE.BufferGeometry,
  original: Float32Array,
) {
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;

  for (let i = 0; i < arr.length; i++) {
    arr[i] = arr[i] + (original[i] - arr[i]) * params.returnSpeed;
  }
  posAttr.needsUpdate = true;
}

const _invMat = new THREE.Matrix4();
const _localOrigin = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();

function applyRaycastPushGeometryLocal(
  owner: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  strength: number,
) {
  raycaster.setFromCamera(mouseNDC, camera);

  owner.updateMatrixWorld(true);
  _invMat.copy(owner.matrixWorld).invert();

  _localOrigin.copy(raycaster.ray.origin).applyMatrix4(_invMat);
  _localDir
    .copy(raycaster.ray.direction)
    .transformDirection(_invMat)
    .normalize();

  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  const arr = posAttr.array as Float32Array;

  for (let i = 0; i < posAttr.count; i++) {
    const ix = i * 3;

    _p.set(arr[ix], arr[ix + 1], arr[ix + 2]);

    _v.copy(_p).sub(_localOrigin);
    const t = _v.dot(_localDir);

    _closest.copy(_localOrigin).add(_dirTmp.copy(_localDir).multiplyScalar(t));

    const dist = _p.distanceTo(_closest);

    if (dist < params.radius) {
      const falloff = (1 - dist / params.radius) ** 2;
      _dirTmp.copy(_p).sub(_closest).normalize();
      _p.add(_dirTmp.multiplyScalar(falloff * strength));

      arr[ix] = _p.x;
      arr[ix + 1] = _p.y;
      arr[ix + 2] = _p.z;
    }
  }

  posAttr.needsUpdate = true;
}

// DISPOSE
function disposeCurrentPoints() {
  if (pointsRef) {
    scene.remove(pointsRef);

    if (pointsCopyRef) {
      (pointsCopyRef.geometry as THREE.BufferGeometry).dispose();
      (pointsCopyRef.material as THREE.Material).dispose();
    }

    (pointsRef.geometry as THREE.BufferGeometry).dispose();
    (pointsRef.material as THREE.Material).dispose();
  }

  pointsRef = null;
  pointsCopyRef = null;
  originalPositions = null;
  originalPositionsCopy = null;
  pointsMaterialBase = null;
  pointsMaterialFluff = null;
  vertices.length = 0;
}

// LOAD MODEL
function loadModel(url: string) {
  disposeCurrentPoints();

  loader.load(url, (gltf) => {
    buildSamplersFromScene(gltf.scene);
    if (samplers.length === 0) return;
    transformMesh();
  });
}

// TRANSFORM MESH INTO POINTS
function transformMesh(): void {
  const COUNT = params.points;
  const SPACE = params.space;

  vertices.length = 0;

  for (let i = 0; i < COUNT; i++) {
    const si = pickSamplerIndex();
    samplers[si].sample(tempPosition);

    vertices.push(
      tempPosition.x * SPACE,
      tempPosition.y * SPACE,
      tempPosition.z * SPACE,
    );
  }

  pointsGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  pointsGeometry.center();

  pointsMaterialBase = new THREE.PointsMaterial({
    color: 0xab2929,
    size: params.pointSize,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    alphaMap: particleTexture,
  });

  const points = new THREE.Points(pointsGeometry, pointsMaterialBase);
  points.visible = params.baseVisible;

  points.rotation.x = -Math.PI / 2;

  originalPositions = new Float32Array(
    (pointsGeometry.attributes.position as THREE.BufferAttribute)
      .array as Float32Array,
  );

  pointsMaterialFluff = pointsMaterialBase.clone();
  pointsMaterialFluff.size = params.pointSize;

  const pointsCopy = new THREE.Points(
    (points.geometry as THREE.BufferGeometry).clone(),
    pointsMaterialFluff,
  );
  pointsCopy.visible = params.fluffVisible;
  pointsCopy.scale.set(params.fluffScale, params.fluffScale, params.fluffScale);

  const copyPosAttr = (pointsCopy.geometry as THREE.BufferGeometry).attributes
    .position as THREE.BufferAttribute;
  const copyArr = copyPosAttr.array as Float32Array;

  for (let i = 0; i < copyPosAttr.count; i++) {
    const ix = i * 3;
    copyArr[ix] += (Math.random() - 0.5) * params.fluffJitterX;
    copyArr[ix + 1] += (Math.random() - 0.5) * params.fluffJitterY;
    copyArr[ix + 2] += (Math.random() - 0.5) * params.fluffJitterZ;
  }
  copyPosAttr.needsUpdate = true;

  originalPositionsCopy = new Float32Array(copyArr);

  points.add(pointsCopy);
  scene.add(points);

  pointsRef = points;
  pointsCopyRef = pointsCopy;
}

loadModel(currentModelUrl);

// MOUSEMOVE
document.addEventListener("mousemove", (e) => {
  mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

let clock = new THREE.Clock();

function animate() {
  const delta = clock.getDelta();
  requestAnimationFrame(animate);

  if (pointsRef) {
    pointsRef.rotation.z += 0.2 * delta;
    pointsRef.rotation.x = -2.3;
  }

  controls.update();

  if (pointsRef && originalPositions) {
    // BASE
    returnToOriginalGeometry(
      pointsRef.geometry as THREE.BufferGeometry,
      originalPositions,
    );
    applyRaycastPushGeometryLocal(
      pointsRef,
      pointsRef.geometry as THREE.BufferGeometry,
      params.strength,
    );

    // FLUFF
    if (pointsCopyRef && originalPositionsCopy) {
      returnToOriginalGeometry(
        pointsCopyRef.geometry as THREE.BufferGeometry,
        originalPositionsCopy,
      );
      applyRaycastPushGeometryLocal(
        pointsCopyRef,
        pointsCopyRef.geometry as THREE.BufferGeometry,
        params.strength * params.fluffStrengthMul,
      );
    }
  }

  renderer.render(scene, camera);
}

animate();

// RESIZE
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});
