// JEV construye · el motor 3D (three.js). Dibuja la escena de spec.js: objetos (grupos con su origen en el suelo)
// hechos de piezas, y cada pieza de nodos primitivos. Dos renderers: la vista que el usuario gira y uno fuera de
// pantalla, con una cámara fija, que saca las fotos que mira JEV (la escena y cada opción de una pregunta).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCameraRig, recordCanvas } from './camera.js';
import { createTakeRecorder, poseAt, cameraBPath, TAKE } from './take.js';
import { ROLE_COLORS } from './look.js';

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

// La cámara B dibujada en la vista: un cuerpo y una lente que apunta hacia donde mira (+Z, con lookAt).
// Solo existe en la vista del usuario: no sale en las fotos de JEV, ni en las grabaciones, ni en los videos.
function cameraMarker() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xc8ff1a, toneMapped: false });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.3), mat));
  const lens = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 18, 1, true), mat);
  lens.rotation.x = -Math.PI / 2; // la punta hacia el cuerpo, la boca hacia adelante
  lens.position.z = 0.24;
  g.add(lens);
  g.visible = false;
  return g;
}

// Escena de datos → grupo de three.js. Cada malla sabe a qué pieza pertenece (objeto/pieza).
export function buildGroup(scene) {
  const root = new THREE.Group();
  for (const o of Object.values(scene.objects || {})) {
    const g = new THREE.Group();
    g.position.set(...o.position);
    if (o.rotation) g.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG);
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

export function stage() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  const sky = new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.6);
  sky.userData.base = 'sky';
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.userData.base = 'key';
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

// Luces del look (look.js) sobre una escena de stage(): con un rig, el sol y el cielo de base se apagan y entran sus
// luces, su fondo, su bruma y su exposición (con tone mapping de cine). Sin rig, la luz de base de siempre.
// originOf(id) → Vector3 con el origen actual del objeto: las luces que lo siguen (la héroe) se mueven con él.
// Mapa de luces: todo en blanco mate sobre negro y cada luz pintada con el color de su papel (principal roja,
// relleno verde, contraluz azul, héroe amarilla): se ve qué luz toca cada superficie y dónde no llega ninguna.
const MAP_WHITE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
export function createLights(scene, renderer, { originOf = () => null, shadowSize = 1024 } = {}) {
  const base = scene.children.filter((c) => c.userData.base);
  const baseBackground = scene.background.clone();
  const baseColor = new Map(base.map((l) => [l, { color: l.color.clone(), intensity: l.intensity }]));
  for (const l of base) if (l.castShadow) l.shadow.mapSize.set(shadowSize, shadowSize);
  let rig = null, group = null, items = [], sky = null, map = false;
  const o = new THREE.Vector3();

  function update() {
    for (const { light, spec } of items) {
      const origin = (spec.anchor && originOf(spec.anchor)) || o.set(0, 0, 0);
      light.position.fromArray(spec.position).add(origin);
      light.target.position.fromArray(spec.target).add(origin);
      const d = Math.max(0.1, light.position.distanceTo(light.target.position));
      // La intensidad es la luz que llega al sujeto: una spot (cae con la distancia²) se compensa con d².
      light.intensity = spec.kind === 'sun' ? spec.intensity : spec.intensity * d * d;
      if (spec.kind === 'spot') light.angle = Math.min(1.1, Math.max(0.12, Math.atan((spec.radius * 1.8) / d)));
    }
  }
  function paint() {
    scene.overrideMaterial = map ? MAP_WHITE : null;
    scene.background = map ? new THREE.Color(0x0d0d0f) : rig ? new THREE.Color(rig.background) : baseBackground;
    scene.fog = !map && rig?.haze ? new THREE.FogExp2(rig.background, rig.haze * 0.06) : null;
    renderer.toneMapping = !map && rig ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
    renderer.toneMappingExposure = !map && rig ? rig.exposure : 1;
    for (const l of base) {
      l.visible = !rig;
      const b = baseColor.get(l);
      if (l.userData.base === 'sky') l.intensity = map ? 0.03 : b.intensity;
      else l.color.set(map ? ROLE_COLORS.key : b.color);
    }
    if (sky) sky.intensity = map ? 0.03 : rig.sky.intensity;
    for (const { light, spec } of items) light.color.set(map ? ROLE_COLORS[spec.role] : spec.color);
  }
  function set(next) {
    if (group) { scene.remove(group); items.forEach(({ light }) => light.dispose()); }
    rig = next || null;
    group = null; items = []; sky = null;
    if (rig) {
      group = new THREE.Group();
      sky = new THREE.HemisphereLight(rig.sky.color, rig.sky.ground, rig.sky.intensity);
      group.add(sky);
      items = rig.lights.map((spec) => {
        const light = spec.kind === 'sun' ? new THREE.DirectionalLight() : new THREE.SpotLight();
        if (spec.kind === 'spot') { light.decay = 2; light.distance = 0; light.penumbra = 0.15 + spec.softness * 0.85; }
        light.castShadow = spec.shadow;
        if (spec.shadow) {
          light.shadow.mapSize.set(shadowSize, shadowSize);
          light.shadow.bias = -0.0004;
          light.shadow.normalBias = 0.02;
          if (spec.kind === 'sun') {
            const r = Math.max(12, spec.radius * 4);
            Object.assign(light.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 60 });
          } else Object.assign(light.shadow.camera, { near: 0.1, far: 100 });
        }
        group.add(light, light.target);
        return { light, spec };
      });
      scene.add(group);
      update();
    }
    paint();
  }
  return {
    set, update,
    get rig() { return rig; },
    get map() { return map; },
    setMap(on) { map = !!on; paint(); },
    // Dónde está cada luz ahora (en el mundo), para dibujar sus marcas.
    positions: () => items.map(({ light, spec }) => ({ id: spec.id, role: spec.role, color: spec.color, position: light.position.clone(), target: light.target.position.clone() })),
  };
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
  // Las guías del director (contorno, cámara B, luces) van en otra escena que se dibuja encima: no reciben luz ni
  // niebla, no las tapa el mapa de luces y nunca salen en las fotos de JEV ni en los videos.
  const overlay = new THREE.Scene();
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

  // Tools · Attach (POV). Un clic sobre la vista elige un objeto entero; si la cámara está lo bastante cerca, Attach
  // lo pega a la cámara tal como se ve en ese momento y desde ahí la acompaña rígido: moverse y girar (teclado, mouse,
  // tomas) lo llevan, como si la cámara fuera el objeto. Detach lo suelta donde quedó.
  const REACH = 1.5; // metros desde la cámara hasta la caja del objeto; los objetos grandes dan más margen
  let selected = null; // id del objeto elegido
  let attached = null; // { id, offset }: la matriz del objeto vista desde la cámara
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0xc8ff1a);
  outline.material.toneMapped = false;
  outline.visible = false;
  overlay.add(outline);
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Matrix4(), tmpV = new THREE.Vector3();
  const groupOf = (id) => (id ? content.children.find((g) => g.name === id) || null : null);
  const toolListeners = new Set();

  function reach() {
    const g = groupOf(selected);
    if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    return { distance: box.distanceToPoint(camera.position), limit: Math.max(REACH, box.getSize(tmpV).length() * 0.6) };
  }
  function toolState() {
    const r = attached ? null : reach();
    const o = selected ? data.objects?.[selected] : null;
    return {
      selected: o ? { id: o.id, label: o.label } : null, attached: !!attached, distance: r?.distance ?? null, limit: r?.limit ?? null, near: !!r && r.distance <= r.limit,
      camB: camB ? { mode: camB.mode } : null,
      recording: takeRec ? takeRec.seconds : null,
      take: take ? { duration: take.duration, subject: take.subject, label: data.objects?.[take.subject]?.label || null } : null,
      previewing: preview?.view || null,
    };
  }
  const emitTools = () => { const s = toolState(); toolListeners.forEach((fn) => fn(s)); };

  function select(id) {
    if (attached) return;
    selected = id && data.objects?.[id] ? id : null;
    emitTools();
  }
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? [e.clientX, e.clientY] : null; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || attached || preview || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // arrastrar = girar, no elegir
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(content.children, true)[0];
    select(hit ? hit.object.parent.name : null);
  });

  function attach() {
    const g = groupOf(selected), r = reach();
    if (!g || !r || r.distance > r.limit || preview) return false;
    camera.updateMatrixWorld();
    g.updateMatrixWorld();
    attached = { id: selected, offset: camera.matrixWorld.clone().invert().multiply(g.matrixWorld) };
    emitTools();
    return true;
  }
  // Suelta el objeto y devuelve dónde quedó (origen y rotación en grados) para guardarlo en la escena.
  function detach() {
    const g = attached && groupOf(attached.id);
    const id = attached?.id;
    attached = null;
    emitTools();
    if (!g) return null;
    const r = (v) => +v.toFixed(3) + 0;
    return { id, position: g.position.toArray().map(r), rotation: [g.rotation.x, g.rotation.y, g.rotation.z].map((v) => r(v / DEG)) };
  }
  // Cada cuadro, después de mover la cámara: el objeto pegado va donde dice la cámara.
  function follow() {
    const g = attached && groupOf(attached.id);
    if (!g) return;
    camera.updateMatrixWorld();
    tmp.multiplyMatrices(camera.matrixWorld, attached.offset).decompose(g.position, g.quaternion, g.scale);
  }
  function drawOutline() {
    const g = !attached && !recorder && !preview && groupOf(selected);
    outline.visible = !!g;
    if (g) outline.box.setFromObject(g);
  }

  // Tools · actuación y cámara B (take.js). Grabar la actuación guarda, cuadro a cuadro, tu cámara y el objeto pegado;
  // "ver" la reproduce en esta vista desde tu POV o desde la cámara B. Los videos los filma film.js, fuera de pantalla.
  let camB = null; // { position, target, mode }: dónde la pusiste y adónde miraba
  let take = null; // la última actuación
  let takeRec = null, takeSubject = null;
  let preview = null; // { view: 'pov' | 'b', path, t0, saved, resolve }
  const marker = cameraMarker();
  overlay.add(marker);
  const r3 = (v) => +v.toFixed(3) + 0;

  function placeCamB(mode) {
    camB = { position: camera.position.toArray().map(r3), target: controls.target.toArray().map(r3), mode: mode || camB?.mode || 'fixed' };
    emitTools();
  }
  function setCamB(next) { camB = next; emitTools(); }
  function drawMarker() {
    // Oculto también si tu cámara está encima: si no, la tapa entera.
    marker.visible = !!camB && !recorder && preview?.view !== 'b' && camera.position.distanceTo(tmpV.fromArray(camB.position)) > 1;
    if (!marker.visible) return;
    marker.position.fromArray(camB.position);
    marker.lookAt(...camB.target);
  }

  function startTake() {
    if (takeRec || preview) return false;
    takeSubject = attached?.id || selected || null;
    takeRec = createTakeRecorder({ subject: takeSubject, fov: camera.fov });
    emitTools();
    return true;
  }
  function stopTake() {
    if (!takeRec) return take;
    const t = takeRec.finish();
    takeRec = null;
    if (t.samples.length >= 2) take = t;
    emitTools();
    return take;
  }
  function captureTake(now) {
    if (!takeRec) return;
    const g = groupOf(takeSubject);
    takeRec.add(now, [...camera.position.toArray(), ...camera.quaternion.toArray()], g ? [...g.position.toArray(), ...g.quaternion.toArray()] : null);
    if (takeRec.seconds >= TAKE.maxSeconds) stopTake();
  }

  function previewTake(view = 'pov') {
    if (!take || takeRec) return Promise.resolve(); // con algo pegado también: al terminar vuelve a tu cámara
    stopPreview();
    return new Promise((resolve) => {
      preview = { view, path: view === 'b' && camB ? cameraBPath(take, camB) : null, t0: performance.now(), resolve, saved: { position: camera.position.clone(), target: controls.target.clone() } };
      controls.enabled = false;
      emitTools();
    });
  }
  function stopPreview() {
    if (!preview) return;
    const { saved, resolve } = preview;
    preview = null;
    camera.position.copy(saved.position);
    controls.target.copy(saved.target);
    camera.lookAt(saved.target);
    controls.enabled = true;
    show(data); // el objeto vuelve a donde está en la escena
    resolve();
  }
  // Un cuadro de la vista previa: el objeto donde estaba en la actuación y la cámara elegida.
  function playPreview(now) {
    if (!preview) return false;
    const t = (now - preview.t0) / 1000;
    if (t > take.duration) { stopPreview(); return false; }
    const p = poseAt(take, t), g = groupOf(take.subject);
    if (g && p.object) { g.position.fromArray(p.object); g.quaternion.fromArray(p.object, 3); }
    if (preview.path) {
      const f = preview.path[Math.min(preview.path.length - 1, Math.round(t * TAKE.fps))];
      camera.position.fromArray(f.position);
      camera.lookAt(...f.target);
    } else {
      camera.position.fromArray(p.camera);
      camera.quaternion.fromArray(p.camera, 3);
    }
    return true;
  }

  // Luces (look.js): el rig que eligió JEV, las marcas de cada luz en la vista y "mover acá" (la única mano del
  // director: la luz va a donde está tu cámara y sigue apuntando al sujeto).
  const lights = createLights(scene, renderer, { originOf: (id) => groupOf(id)?.position || null });
  const lightListeners = new Set();
  const lightMarks = new THREE.Group();
  overlay.add(lightMarks);
  let pickedLight = null;
  function setRig(next) {
    lights.set(next);
    if (!next?.lights.some((l) => l.id === pickedLight)) pickedLight = next?.lights[0]?.id || null;
    lightListeners.forEach((fn) => fn(lights.rig));
  }
  function moveLight(id = pickedLight) {
    const cur = lights.rig, l = cur?.lights.find((x) => x.id === id);
    if (!l) return false;
    const origin = (l.anchor && groupOf(l.anchor)?.position.toArray()) || [0, 0, 0];
    const target = l.target.map((v, k) => v + origin[k]);
    if (camera.position.distanceTo(tmpV.fromArray(target)) < 0.3) return false; // encima del sujeto no hay dirección
    setRig({ ...cur, lights: cur.lights.map((x) => (x === l ? { ...x, position: camera.position.toArray().map((v, k) => r3(v - origin[k])) } : x)) });
    return true;
  }
  function lightMark() {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ toneMapped: false }));
    const ring = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc8ff1a, wireframe: true, toneMapped: false }));
    const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, toneMapped: false }));
    g.add(ball, ring, beam);
    g.userData = { ball, ring, beam };
    return g;
  }
  function drawLights() {
    const list = lights.positions();
    lightMarks.visible = !recorder && !preview && list.length > 0;
    if (!lightMarks.visible) return;
    while (lightMarks.children.length < list.length) lightMarks.add(lightMark());
    lightMarks.children.forEach((m, i) => {
      const l = list[i];
      m.visible = !!l;
      if (!l) return;
      const c = lights.map ? ROLE_COLORS[l.role] : l.color;
      m.position.copy(l.position);
      m.userData.ball.material.color.set(c);
      m.userData.beam.material.color.set(c);
      m.userData.ring.visible = l.id === pickedLight;
      m.userData.beam.geometry.attributes.position.setXYZ(1, ...l.target.clone().sub(l.position).toArray());
      m.userData.beam.geometry.attributes.position.needsUpdate = true;
    });
  }
  // A quién se ilumina: el objeto elegido (o toda la escena) y dónde está tu cámara. Es lo que necesita look.js.
  function lightFrame() {
    const g = groupOf(selected);
    const box = new THREE.Box3().setFromObject(g || content);
    const empty = box.isEmpty();
    return {
      subject: { id: g ? selected : null, origin: g ? g.position.toArray().map(r3) : [0, 0, 0], center: empty ? [0, 1, 0] : box.getCenter(tmpV).toArray().map(r3), radius: empty ? 1 : r3(Math.max(0.4, box.getSize(tmpV).length() / 2)) },
      camera: camera.position.toArray().map(r3),
    };
  }
  // Una foto por rig, desde TU encuadre (no el de las fotos de construcción): la luz se juzga en el plano que vas a filmar.
  let shotRoot = null;
  const shotLights = createLights(shotScene, shots, { originOf: (id) => shotRoot?.getObjectByName(id)?.position || null });
  function lookShots(rigs) {
    const cam = new THREE.PerspectiveCamera(camera.fov, SHOT.width / SHOT.height, 0.05, 400);
    cam.position.copy(camera.position);
    cam.quaternion.copy(camera.quaternion);
    cam.updateProjectionMatrix();
    shotRoot = content.clone();
    shotScene.add(shotRoot);
    try {
      return rigs.map((r) => { shotLights.set(r); shots.render(shotScene, cam); return shots.domElement.toDataURL('image/jpeg', 0.85); });
    } finally {
      shotScene.remove(shotRoot);
      shotRoot = null;
      shotLights.set(null); // las fotos de construcción siguen con la luz de base
    }
  }

  // Muestra una escena; las piezas de `pop` aparecen creciendo.
  function show(next, { pop = [], refit = false } = {}) {
    scene.remove(content);
    content = buildGroup(next);
    scene.add(content);
    const wasEmpty = !data.parts?.length;
    data = next;
    if (attached && !next.objects?.[attached.id]) attached = null;
    if (selected && !next.objects?.[selected]) selected = null;
    emitTools();
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

  let raf = 0, last = performance.now(), lastTools = 0;
  const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
  function loop() {
    raf = requestAnimationFrame(loop);
    if (!container.isConnected || container.offsetParent === null) return;
    const now = performance.now();
    const previewing = playPreview(now);
    const playing = previewing || rig.update(now);
    if (!playing) fly(Math.min(0.1, (now - last) / 1000));
    last = now;
    content.traverse((m) => {
      if (!m.isMesh || m.userData.pop === undefined) return;
      const t = Math.min(1, (now - m.userData.pop) / POP_MS);
      m.scale.copy(m.userData.scale).multiplyScalar(Math.max(0.001, easeOutBack(t)));
      if (t >= 1) delete m.userData.pop;
    });
    if (!playing) controls.update();
    if (!previewing) follow();
    captureTake(now);
    lights.update();
    drawOutline();
    drawMarker();
    drawLights();
    if (toolListeners.size && now - lastTools > 150) { lastTools = now; emitTools(); }
    renderer.render(scene, camera);
    renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = true;
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

  const tools = {
    select, attach, detach, placeCamB, setCamB, startTake, stopTake, previewTake, stopPreview,
    get camB() { return camB; },
    get take() { return take; },
    setTake(t) { take = t; emitTools(); },
    get state() { return toolState(); },
    onChange: (fn) => { toolListeners.add(fn); fn(toolState()); },
  };
  const lighting = {
    set: setRig, move: moveLight, frame: lightFrame, shots: lookShots,
    get rig() { return lights.rig; },
    get picked() { return pickedLight; },
    pick(id) { pickedLight = id; lightListeners.forEach((fn) => fn(lights.rig)); },
    get map() { return lights.map; },
    setMap: (on) => lights.setMap(on),
    onChange: (fn) => { lightListeners.add(fn); fn(lights.rig); },
  };
  return { show, fit, snapshot, previews, rig, recording, tools, lighting, setSmooth, setSpeed: (v) => { speedMul = Math.min(3, Math.max(0.1, v)); }, canvas: renderer.domElement, dispose: () => { cancelAnimationFrame(raf); renderer.dispose(); shots.dispose(); } };
}
