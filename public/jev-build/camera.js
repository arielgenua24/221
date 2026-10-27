// JEV construye · cámara para grabar.
// Una "toma" es una lista de puntos de cámara (dónde está y adónde mira). Al reproducirla, la cámara recorre una curva
// suave que pasa por todos (Catmull-Rom centrípeta), a velocidad pareja según la distancia entre puntos y con
// arranque y frenado suaves. Grabar = capturar el canvas en video mientras pasa (o mientras la manejás a mano).
import * as THREE from 'three';

const ease = (u) => u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: velocidad cero en los extremos

export function createCameraRig({ camera, controls, scene }) {
  let points = []; // [{ position: Vector3, target: Vector3 }]
  let play = null;
  let hidden = false; // guía oculta mientras se graba
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn(points.length));

  // El recorrido dibujado en la escena (no sale en las fotos de JEV, que usan otra escena, ni en la grabación).
  const guide = new THREE.Group();
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff4d00 }));
  guide.add(line);
  scene.add(guide);
  const dot = new THREE.SphereGeometry(1, 12, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff4d00 });

  function curves() {
    if (points.length < 2) return null;
    return {
      pos: new THREE.CatmullRomCurve3(points.map((p) => p.position), false, 'centripetal'),
      tgt: new THREE.CatmullRomCurve3(points.map((p) => p.target), false, 'centripetal'),
    };
  }

  function redraw() {
    guide.children.filter((c) => c !== line).forEach((c) => guide.remove(c));
    const c = curves();
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry().setFromPoints(c ? c.pos.getPoints(points.length * 24) : []);
    const size = Math.max(0.04, camera.position.distanceTo(controls.target) * 0.012);
    for (const p of points) {
      const m = new THREE.Mesh(dot, dotMat);
      m.position.copy(p.position);
      m.scale.setScalar(size);
      guide.add(m);
    }
  }

  // Tiempo de cada tramo proporcional a lo que se mueve la cámara (y algo de lo que gira la mirada).
  function timeline() {
    const lens = [];
    for (let i = 1; i < points.length; i++) {
      lens.push(Math.max(0.01, points[i].position.distanceTo(points[i - 1].position), points[i].target.distanceTo(points[i - 1].target) * 0.5));
    }
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    return lens.map((l) => { const from = acc / total; acc += l; return { from, to: acc / total }; });
  }

  const target = new THREE.Vector3();
  // Avanza la toma; devuelve true mientras está sonando (así el motor no mueve la cámara por su cuenta).
  function update(now) {
    if (!play) return false;
    const u = Math.min(1, (now - play.t0) / play.ms);
    const s = ease(u);
    const i = Math.max(0, play.spans.findIndex((sp) => s <= sp.to));
    const sp = play.spans[i];
    const f = sp.to > sp.from ? (s - sp.from) / (sp.to - sp.from) : 1;
    const t = (i + f) / (points.length - 1);
    camera.position.copy(play.c.pos.getPoint(t));
    play.c.tgt.getPoint(t, target);
    camera.lookAt(target);
    controls.target.copy(target);
    if (u >= 1) stop();
    return true;
  }

  function stop() {
    if (!play) return;
    const done = play.resolve;
    play = null;
    controls.enabled = true;
    guide.visible = !hidden;
    done();
  }

  return {
    get count() { return points.length; },
    get playing() { return !!play; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    add() {
      points.push({ position: camera.position.clone(), target: controls.target.clone() });
      redraw();
      changed();
    },
    clear() { points = []; redraw(); changed(); },
    get() { return points.map((p) => ({ position: p.position.toArray(), target: p.target.toArray() })); },
    set(list) {
      points = (Array.isArray(list) ? list : []).filter((p) => p?.position?.length === 3 && p?.target?.length === 3)
        .map((p) => ({ position: new THREE.Vector3(...p.position), target: new THREE.Vector3(...p.target) }));
      redraw();
      changed();
    },
    // Reproduce la toma en `seconds`; la promesa se cumple al terminar (o al detenerla).
    play(seconds) {
      if (points.length < 2) return Promise.reject(new Error('Marcá al menos 2 puntos de cámara.'));
      stop();
      return new Promise((resolve) => {
        play = { t0: performance.now(), ms: Math.max(0.5, seconds) * 1000, c: curves(), spans: timeline(), resolve };
        controls.enabled = false;
        guide.visible = false;
      });
    },
    stop,
    update,
    hideGuide(on) { hidden = on; guide.visible = !on && !play; },
  };
}

// Graba el canvas en video. MP4 si el navegador lo sabe hacer (Safari, Chrome nuevo); si no, WebM.
export function recordCanvas(canvas, { fps = 60, bitrate = 16_000_000 } = {}) {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('Este navegador no puede grabar el canvas.');
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.start(250);
  return {
    mime: rec.mimeType || mime || 'video/webm',
    stop: () => new Promise((resolve) => {
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type: rec.mimeType || mime || 'video/webm' })); };
      rec.stop();
    }),
  };
}
