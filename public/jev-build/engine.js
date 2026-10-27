// JEV construye · el motor 3D (three.js). Dibuja la escena de spec.js: objetos (grupos con su origen en el suelo)
// hechos de piezas, y cada pieza de nodos primitivos. Dos renderers: la vista que el usuario gira y uno fuera de
// pantalla, con una cámara fija, que saca las fotos que mira JEV (la escena y cada opción de una pregunta).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraRig, recordCanvas } from './camera.js';

const SKY = 0xdfe6ea, GROUND = 0xd8ccb0;
export const SHOT = { width: 640, height: 448 }; // JEV acepta de 280 a 1568 px por lado
const POP_MS = 450;

// Geometrías de tamaño 1×1×1 (la caja que ocupan); `fix` corrige las que no llegan a 1 en algún eje.
const GEOMETRY = {
  sphere: { make: () => new THREE.SphereGeometry(0.5, 28, 18) },
  ellipsoid: { make: () => new THREE.SphereGeometry(0.5, 28, 18) },
  box: { make: () => new THREE.BoxGeometry(1, 1, 1) },
  cylinder: { make: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 28) },
  cone: { make: () => new THREE.ConeGeometry(0.5, 1, 28) },
  capsule: { make: () => new THREE.CapsuleGeometry(0.25, 0.5, 6, 18), fix: [2, 1, 2] },
  torus: { make: () => new THREE.TorusGeometry(0.35, 0.15, 14, 36), fix: [1, 1, 1 / 0.3] },
  prism: { make: prismGeometry },
};

// Prisma triangular (techo a dos aguas): triángulo con la punta arriba mirando a +Z, largo en Z. Caras planas.
function prismGeometry() {
  const A = [-0.5, -0.5, 0.5], B = [0.5, -0.5, 0.5], C = [0, 0.5, 0.5];
  const A2 = [-0.5, -0.5, -0.5], B2 = [0.5, -0.5, -0.5], C2 = [0, 0.5, -0.5];
  const tris = [[A, B, C], [A2, C2, B2], [A, A2, B2], [A, B2, B], [A, C, C2], [A, C2, A2], [B, B2, C2], [B, C2, C]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3));
  g.computeVertexNormals();
  return g;
}
const geometries = new Map();
const materials = new Map();
const geometry = (p) => { if (!geometries.has(p)) geometries.set(p, GEOMETRY[p].make()); return geometries.get(p); };
const material = (c) => { if (!materials.has(c)) materials.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0 })); return materials.get(c); };
const DEG = Math.PI / 180;

function nodeMesh(node) {
  const mesh = new THREE.Mesh(geometry(node.primitive), material(node.color));
  const fix = GEOMETRY[node.primitive].fix || [1, 1, 1];
  mesh.position.set(...node.position);
  mesh.rotation.set(node.rotation[0] * DEG, node.rotation[1] * DEG, node.rotation[2] * DEG);
  mesh.scale.set(node.size[0] * fix[0], node.size[1] * fix[1], node.size[2] * fix[2]);
  mesh.userData.scale = mesh.scale.clone();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Escena de datos → grupo de three.js. Cada malla sabe a qué pieza pertenece (objeto/pieza).
export function buildGroup(scene) {
  const root = new THREE.Group();
  for (const o of Object.values(scene.objects || {})) {
    const g = new THREE.Group();
    g.position.set(...o.position);
    g.name = o.id;
    for (const p of (scene.parts || []).filter((x) => x.object === o.id)) {
      for (const n of p.nodes) {
        const m = nodeMesh(n);
        m.userData.key = `${o.id}/${p.id}`;
        g.add(m);
      }
    }
    root.add(g);
  }
  return root;
}

function stage() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(6, 10, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(30, 30, 0x9a8f78, 0xbdb19a);
  grid.position.y = 0.002;
  scene.add(grid);
  return scene;
}

// Cámara que encuadra una caja desde arriba y adelante (+Z), siempre con el mismo ángulo.
function frame(camera, box, dir = new THREE.Vector3(0.25, 0.42, 1)) {
  const b = box.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1.5, 0, -1.5), new THREE.Vector3(1.5, 2.5, 1.5)) : box.clone();
  b.expandByScalar(0.3);
  const center = b.getCenter(new THREE.Vector3());
  const radius = Math.max(1.2, b.getSize(new THREE.Vector3()).length() * 0.4);
  const fov = (camera.fov * DEG) / 2;
  const dist = radius / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)));
  camera.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
  camera.near = 0.05;
  camera.far = dist * 4 + 50;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return center;
}

// Caja que abarca todas las escenas (o solo el objeto `focus` en cada una).
const boundsOf = (scenes, focus) => {
  const box = new THREE.Box3();
  for (const s of scenes) {
    const g = buildGroup(s);
    box.union(new THREE.Box3().setFromObject((focus && g.getObjectByName(focus)) || g));
  }
  return box;
};

export function createViewport(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.append(renderer.domElement);
  const scene = stage();
  const camera = new THREE.PerspectiveCamera(45, 1.5, 0.05, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI - 0.01; // también se puede mirar desde abajo
  controls.screenSpacePanning = true; // clic derecho desplaza en el plano de la pantalla (arriba/abajo de verdad)

  // Cámara libre con teclado (con el foco en la vista: un clic encima). W/S adelante/atrás hacia donde mira, A/D a los
  // costados, E/Espacio sube, Q/C baja; las flechas giran. Shift = rápido. Mueve cámara y punto de giro juntos, así
  // el mouse sigue orbitando alrededor de donde llegaste.
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
  const keys = new Set();
  const MOVE = { KeyW: 1, KeyS: 1, KeyA: 1, KeyD: 1, KeyQ: 1, KeyE: 1, KeyC: 1, Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
  canvas.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') { fit(); return; }
    if (e.code === 'KeyK' && !e.repeat) { rig.add(); return; } // K marca un punto de la toma
    if (!MOVE[e.code]) return;
    e.preventDefault();
    keys.add(e.code);
    keys[e.shiftKey ? 'add' : 'delete']('fast');
  });
  canvas.addEventListener('keyup', (e) => { keys.delete(e.code); if (e.key === 'Shift') keys.delete('fast'); });
  canvas.addEventListener('blur', () => keys.clear());

  // Suavidad (0 = seco, 1 = muy suave) y velocidad (1 = normal). Con inercia, la cámara acelera y frena en lugar de
  // arrancar y pararse de golpe: es lo que hace que una grabación a mano no se vea frenética.
  let smooth = 0.6, speedMul = 1;
  function setSmooth(v) {
    smooth = Math.min(1, Math.max(0, v));
    controls.dampingFactor = 0.2 - smooth * 0.165; // 0,2 → 0,035: el mouse sigue deslizando al soltar
    controls.rotateSpeed = 1 - smooth * 0.65;
    controls.zoomSpeed = 1 - smooth * 0.6;
    controls.panSpeed = 1 - smooth * 0.5;
  }
  setSmooth(smooth);
  const fwd = new THREE.Vector3(), side = new THREE.Vector3(), want = new THREE.Vector3(), vel = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  let yawVel = 0, pitchVel = 0;
  function fly(dt) {
    const k = 14 - smooth * 12; // qué tan rápido la velocidad real alcanza a la pedida (por segundo)
    const a = 1 - Math.exp(-k * dt);
    const dist = Math.max(1, camera.position.distanceTo(controls.target));
    const speed = dist * 0.9 * speedMul * (keys.has('fast') ? 3 : 1); // más lejos = más rápido
    camera.getWorldDirection(fwd);
    side.crossVectors(fwd, UP).normalize();
    want.set(0, 0, 0);
    if (keys.has('KeyW')) want.add(fwd);
    if (keys.has('KeyS')) want.sub(fwd);
    if (keys.has('KeyD')) want.add(side);
    if (keys.has('KeyA')) want.sub(side);
    if (keys.has('KeyE') || keys.has('Space')) want.add(UP);
    if (keys.has('KeyQ') || keys.has('KeyC')) want.sub(UP);
    if (want.lengthSq()) want.normalize().multiplyScalar(speed);
    vel.lerp(want, a);
    if (vel.lengthSq() < 1e-8) vel.set(0, 0, 0);
    else {
      const step = vel.clone().multiplyScalar(dt);
      camera.position.add(step);
      controls.target.add(step);
    }
    // Flechas: girar la mirada sin moverse (el punto de giro rota alrededor de la cámara), también con inercia.
    const turn = 1.2 * Math.min(1.5, speedMul);
    yawVel += (((keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)) * turn - yawVel) * a;
    pitchVel += (((keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0)) * turn - pitchVel) * a;
    if (Math.abs(yawVel) > 1e-4 || Math.abs(pitchVel) > 1e-4) {
      const look = controls.target.clone().sub(camera.position);
      look.applyAxisAngle(UP, yawVel * dt);
      const angle = look.angleTo(UP) - pitchVel * dt;
      if (angle > 0.05 && angle < Math.PI - 0.05) look.applyAxisAngle(side, pitchVel * dt);
      controls.target.copy(camera.position).add(look);
    }
  }
  const rig = createCameraRig({ camera, controls, scene });
  let content = new THREE.Group();
  scene.add(content);
  let data = { objects: {}, parts: [] };

  // Fuera de pantalla: las fotos para JEV, con encuadre fijo.
  const shots = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  shots.setSize(SHOT.width, SHOT.height, false);
  shots.shadowMap.enabled = true;
  const shotScene = stage();
  const shotCamera = new THREE.PerspectiveCamera(45, SHOT.width / SHOT.height, 0.05, 200);

  function resize() {
    const w = container.clientWidth || 600, h = container.clientHeight || 400;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function fit() {
    controls.target.copy(frame(camera, new THREE.Box3().setFromObject(content)));
    controls.update();
  }

  // Muestra una escena; las piezas de `pop` aparecen creciendo.
  function show(next, { pop = [], refit = false } = {}) {
    scene.remove(content);
    content = buildGroup(next);
    scene.add(content);
    const wasEmpty = !data.parts?.length;
    data = next;
    if (refit || wasEmpty) fit(); // antes de achicar las piezas nuevas, así el encuadre las incluye
    const now = performance.now();
    content.traverse((m) => { if (m.isMesh && pop.includes(m.userData.key)) { m.userData.pop = now; m.scale.setScalar(0.001); } });
  }

  function shoot(scenes, target, focus) {
    const box = boundsOf(scenes, focus);
    frame(shotCamera, box);
    const g = buildGroup(target);
    shotScene.add(g);
    shots.render(shotScene, shotCamera);
    shotScene.remove(g);
    return shots.domElement.toDataURL('image/jpeg', 0.85);
  }

  // Una foto de la escena actual, y una por candidata con el MISMO encuadre, centrado en el objeto que se está
  // construyendo (así JEV compara solo la pieza).
  const snapshot = (s = data) => shoot([s], s);
  const previews = (candidates, focus) => candidates.map((c) => shoot(candidates, c, focus));

  let raf = 0, last = performance.now();
  const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!container.isConnected || container.offsetParent === null) return;
    const now = performance.now();
    const playing = rig.update(now);
    if (!playing) fly(Math.min(0.1, (now - last) / 1000));
    last = now;
    content.traverse((m) => {
      if (!m.isMesh || m.userData.pop === undefined) return;
      const t = Math.min(1, (now - m.userData.pop) / POP_MS);
      m.scale.copy(m.userData.scale).multiplyScalar(Math.max(0.001, easeOutBack(t)));
      if (t >= 1) delete m.userData.pop;
    });
    if (!playing) controls.update();
    renderer.render(scene, camera);
  }

  // Grabar la vista tal como se ve (a mano o con una toma). La guía de la toma no sale en el video.
  let recorder = null;
  const recording = {
    get on() { return !!recorder; },
    start() {
      if (recorder) return;
      recorder = recordCanvas(renderer.domElement);
      rig.hideGuide(true);
    },
    async stop() {
      if (!recorder) return null;
      const r = recorder;
      recorder = null;
      rig.hideGuide(false);
      return { blob: await r.stop(), mime: r.mime };
    },
  };
  fit();
  loop();

  return { show, fit, snapshot, previews, rig, recording, setSmooth, setSpeed: (v) => { speedMul = Math.min(3, Math.max(0.1, v)); }, canvas: renderer.domElement, dispose: () => { cancelAnimationFrame(raf); renderer.dispose(); shots.dispose(); } };
}
