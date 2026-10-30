// JEV construye · filmar la actuación. Fuera de pantalla y cuadro a cuadro: para cada cuadro se pone el objeto donde
// estaba en la actuación, la cámara elegida (tu POV o la cámara B) y se dibuja; mediabunny (WebCodecs) lo codifica
// con su tiempo exacto, así el video sale sin saltos aunque la compu sea lenta. Sin guías ni marcas de la vista.
// Es la calidad final: con las luces del look (la héroe sigue al sujeto cuadro a cuadro) y sombras de 4096 px.
import * as THREE from 'three';
import { buildGroup, stage, createLights } from './engine.js';
import { poseAt, cameraBPath, frameCount, TAKE } from './take.js';

// take: la actuación · data: la escena · view: 'pov' | 'b' · camB: { position, target, mode } (para 'b') · rig: el look.
// → { blob, ext }. onProgress(0..1) después de cada cuadro; signal corta la filmación.
export async function filmTake({ take, data, view, camB, rig = null, fps = TAKE.fps, width = TAKE.width, height = TAKE.height, onProgress, signal }) {
  if (view === 'b' && !camB) throw new Error('Primero poné la cámara B.');
  let M;
  try { M = await import('mediabunny'); } catch {
    throw new Error('no se pudo cargar el codificador de video (/vendor/mediabunny). Reiniciá el servidor para que lo sirva.');
  }
  const mp4 = await M.canEncodeVideo('avc', { width, height });
  if (!mp4 && !(await M.canEncodeVideo('vp9', { width, height }))) throw new Error('Este navegador no puede codificar video (WebCodecs).');

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = stage();
  const root = buildGroup(data);
  scene.add(root);
  const subject = root.children.find((g) => g.name === take.subject) || null;
  const lights = createLights(scene, renderer, { originOf: (id) => root.getObjectByName(id)?.position || null, shadowSize: 4096 });
  lights.set(rig);
  const camera = new THREE.PerspectiveCamera(take.fov || 45, width / height, 0.05, 400);
  const path = view === 'b' ? cameraBPath(take, camB, fps) : null;

  const output = new M.Output({ format: mp4 ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(), target: new M.BufferTarget() });
  const source = new M.CanvasSource(canvas, { codec: mp4 ? 'avc' : 'vp9', quality: M.QUALITY_HIGH });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  try {
    const n = frameCount(take, fps);
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
      const p = poseAt(take, i / fps);
      if (subject && p.object) { subject.position.fromArray(p.object); subject.quaternion.fromArray(p.object, 3); }
      lights.update();
      if (path) {
        camera.position.fromArray(path[i].position);
        camera.lookAt(...path[i].target);
      } else {
        camera.position.fromArray(p.camera);
        camera.quaternion.fromArray(p.camera, 3);
      }
      renderer.render(scene, camera);
      await source.add(i / fps, 1 / fps);
      onProgress?.((i + 1) / n);
    }
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  } finally {
    renderer.dispose();
  }
  return { blob: new Blob([output.target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), ext: mp4 ? 'mp4' : 'webm' };
}
