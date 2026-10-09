// Dentro del iframe aislado del Laboratorio: monta el <Player> de Remotion con el componente de UN agente.
// No se sirve suelto: src/lab/routes.js lo pega (junto con el runtime) en el documento del iframe,
// que la página carga como srcdoc con sandbox (origen opaco). Protocolo con la página (postMessage):
//   ← { type: 'boot' }                                         el runtime está listo para recibir código
//   → { type: 'load', js, video: Blob, meta, zones, images, transform, legacy }
//                                                              montar (js = CommonJS ya compilado en el servidor).
//                                                              El video va debajo y la capa del agente encima, con la
//                                                              transformación del humano { scale, x, y } (x, y en % del cuadro).
//                                                              legacy: código v1, que renderizaba el video él mismo.
//   → { type: 'transform', transform }                         escalar / mover la capa en vivo
//   → { type: 'segments', segments }                           cortes de la animación: [{ from, len, to }] en cuadros
//                                                              (el tramo [from, from+len) de la capa se muestra desde `to`)
//   → { type: 'render' }                                       renderizar a video en el navegador (@remotion/web-renderer)
//   ← { type: 'render_progress', progress } | { type: 'rendered', blob, ext, overlay? } | { type: 'render_error', message }
//     Si el navegador no puede decodificar el video de base, se renderiza SOLO la capa (fondo transparente, WebM con alfa)
//     y llega con overlay: true: la página la compone encima del video original.
//   ← { type: 'loaded' } | { type: 'error', phase, message }   phase: 'eval' | 'runtime'
//   ← { type: 'checked', ok, message? }                        prueba de humo: se recorrieron las zonas
//   → { type: 'play' | 'pause' | 'seek', frame? }              controles sincronizados desde afuera
//   ← { type: 'frame', frame, playing }                        posición actual (para el cursor compartido)
(() => {
  const post = (msg) => parent.postMessage({ source: 'lab-frame', ...msg }, '*');
  // Con origen opaco, leer localStorage/sessionStorage tira SecurityError (y el renderizador web los consulta):
  // se reemplazan por almacenes en memoria, que mueren con el iframe y no comparten nada con la app.
  for (const k of ['localStorage', 'sessionStorage']) {
    try { void window[k]; } catch {
      const data = new Map();
      const store = {
        getItem: (key) => (data.has(String(key)) ? data.get(String(key)) : null),
        setItem: (key, v) => { data.set(String(key), String(v)); },
        removeItem: (key) => { data.delete(String(key)); },
        clear: () => data.clear(),
        key: (i) => [...data.keys()][i] ?? null,
        get length() { return data.size; },
      };
      try { Object.defineProperty(window, k, { value: store, configurable: true }); } catch { /* sigue sin almacenamiento */ }
    }
  }
  const R = window.LabRuntime;
  if (!R) { post({ type: 'error', phase: 'eval', message: 'no cargó el runtime de Remotion' }); return; }
  const { modules, createRoot, Player, React } = R;
  const h = React.createElement;
  const rootEl = document.getElementById('root');
  let root = null;
  let videoUrl = null;
  let player = null;
  let lastError = null;
  let checking = false;

  const describe = (err) => {
    const e = err instanceof Error ? err : new Error(String(err?.message || err));
    // El primer cuadro del stack alcanza para ubicar el problema sin mandar todo el bundle.
    const at = (e.stack || '').split('\n').slice(1).find((l) => /MotionLayer|anonymous|eval/.test(l));
    return `${e.name}: ${e.message}${at ? `\n${at.trim()}` : ''}`.slice(0, 900);
  };
  let renderingNow = false; // mientras se renderiza a archivo, los errores son del render, no del código del agente
  // Errores de red (fuentes bloqueadas por la CSP, recursos del renderizador): son del entorno, no del código del agente.
  const NETWORK = /Failed to fetch|NetworkError|Load failed|net::ERR/i;
  const fail = (phase, err) => {
    if (renderingNow) return;
    const message = describe(err);
    if (NETWORK.test(message)) return;
    if (lastError === message) return;
    lastError = message;
    if (!checking) post({ type: 'error', phase, message });
  };

  // Ejecuta el CommonJS del agente con los módulos permitidos y devuelve su export default.
  function evaluate(js) {
    const module = { exports: {} };
    const require = (spec) => {
      const m = modules[spec];
      if (!m) throw new Error(`módulo no disponible: ${spec}`);
      return m;
    };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', js)(require, module, module.exports);
    const C = module.exports.default;
    if (!C || (typeof C !== 'function' && typeof C !== 'object')) throw new Error('el export default no es un componente de React');
    return C;
  }

  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error) { fail('runtime', error); }
    render() {
      if (this.state.error) return h('div', { className: 'lab-frame-error' }, `Error al reproducir\n\n${describe(this.state.error)}`);
      return this.props.children;
    }
  }

  // La composición: el video original debajo y la capa del agente encima (con la escala y posición del humano),
  // envuelta para atrapar sus errores. El código v1 renderizaba el video él mismo: se monta tal cual.
  const { AbsoluteFill, Sequence } = modules.remotion;
  const { Video } = modules['@remotion/media'];
  // Cortes del humano: cada tramo de la capa se reproduce en otro momento. Dos Sequence anidadas:
  // la externa decide CUÁNDO se ve (desde `to`, durante `len`); la interna corre el reloj para que
  // la capa crea estar en su cuadro original (`from` + lo que pasó desde `to`).
  const segmentsOf = (Layer, props, segments) => segments.map((s, i) => h(Sequence, { key: s.id || i, from: s.to, durationInFrames: Math.max(1, s.len), name: s.id },
    h(Sequence, { from: -s.from }, h(Boundary, null, h(Layer, props)))));
  const Root = ({ Layer, legacy, videoSrc, transform, segments, noVideo, ...props }) => {
    if (legacy) return h(Boundary, null, h(Layer, { videoSrc, ...props }));
    const t = transform || { scale: 1, x: 0, y: 0 };
    return h(AbsoluteFill, { style: noVideo ? {} : { backgroundColor: '#000' } },
      noVideo ? null : h(Video, { src: videoSrc, objectFit: 'cover', style: { position: 'absolute', width: '100%', height: '100%' } }),
      h(AbsoluteFill, { style: { scale: String(t.scale), translate: `${t.x}% ${t.y}%` } },
        Array.isArray(segments) ? segmentsOf(Layer, props, segments) : h(Boundary, null, h(Layer, props))));
  };

  // Esperar a que el cuadro se pinte (si el iframe está oculto, rAF no corre: alcanza con el timeout).
  const nextPaint = () => new Promise((r) => {
    const t = setTimeout(r, 250);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); setTimeout(r, 60); }));
  });

  // Prueba de humo: recorre el comienzo, el medio y el final de cada zona buscando errores de ejecución.
  async function smokeTest(zones, total) {
    checking = true;
    lastError = null;
    const frames = [...new Set(zones.flatMap((z) => [z.from, z.from + Math.floor(z.durationInFrames / 2), z.from + z.durationInFrames - 1]))]
      .filter((f) => f >= 0 && f < total);
    for (const f of frames) {
      player?.seekTo(f);
      await nextPaint();
      if (lastError) break;
    }
    checking = false;
    const ok = !lastError;
    player?.seekTo(zones[0]?.from || 0);
    post({ type: 'checked', ok, message: lastError || undefined });
    // Que un error ya reportado en la prueba no se repita.
  }

  let current = null; // lo que se le pasó al Player (para volver a renderizar con otra transformación)
  function render() {
    root.render(h(Player, current));
  }

  let meta0 = null;
  // Renderiza la composición tal cual se ve (con escala, posición y cortes) a un archivo de video, en el navegador.
  async function renderVideo() {
    if (!current || !R.renderMediaOnWeb) { post({ type: 'render_error', message: 'este navegador no puede renderizar con Remotion' }); return; }
    const composition = { id: 'laboratorio', component: Root, durationInFrames: current.durationInFrames, fps: current.fps, width: meta0.width, height: meta0.height };
    const attempt = async ({ container, muted, overlay = false }) => {
      const out = await R.renderMediaOnWeb({
        composition, container, muted,
        inputProps: overlay ? { ...current.inputProps, noVideo: true } : current.inputProps,
        ...(overlay ? { transparent: true, videoCodec: 'vp9' } : {}),
        onProgress: (p) => post({ type: 'render_progress', progress: p.progress, overlay }),
      });
      return out.getBlob();
    };
    renderingNow = true;
    let lastErr = null;
    try {
      // 1) La composición entera (video + capa), con sonido si se puede.
      for (const [container, muted] of [['mp4', false], ['webm', false], ['mp4', true], ['webm', true]]) {
        try {
          post({ type: 'rendered', blob: await attempt({ container, muted }), ext: container, muted });
          return;
        } catch (err) {
          lastErr = err;
          if (/decod/i.test(String(err?.message))) break; // el video de base no se puede leer: no tiene sentido otro contenedor
        }
      }
      // 2) Solo la capa, transparente: la página la compone sobre el video original.
      if (!current.inputProps.legacy) {
        try {
          post({ type: 'rendered', blob: await attempt({ container: 'webm', muted: true, overlay: true }), ext: 'webm', overlay: true });
          return;
        } catch (err) { lastErr = err; }
      }
      post({ type: 'render_error', message: describe(lastErr) });
    } finally {
      // Lo que el renderizador deja corriendo (cargas que terminan tarde) no se le cuenta al agente.
      setTimeout(() => { renderingNow = false; }, 3000);
    }
  }

  function mount({ js, video, meta, zones, images = {}, transform, segments = null, legacy = false }) {
    meta0 = meta;
    lastError = null;
    let Layer;
    try {
      Layer = evaluate(js);
    } catch (err) {
      post({ type: 'error', phase: 'eval', message: describe(err) });
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(video);
    const durationInFrames = Math.max(1, Math.ceil(meta.duration * meta.fps));
    const ref = React.createRef();
    root ??= createRoot(rootEl);
    current = {
      ref,
      component: Root,
      inputProps: { Layer, legacy, videoSrc: videoUrl, zones, images, transform, segments },
      durationInFrames,
      fps: meta.fps,
      compositionWidth: meta.width,
      compositionHeight: meta.height,
      controls: true,
      // Mudo de entrada: dos players sonando a la vez no sirve, y sin gesto adentro del iframe el navegador no deja reproducir con sonido.
      initiallyMuted: true,
      loop: true,
      clickToPlay: true,
      spaceKeyToPlayOrPause: true,
      style: { width: '100%', height: '100%' },
      errorFallback: ({ error }) => { fail('runtime', error); return h('div', { className: 'lab-frame-error' }, `Error al reproducir\n\n${describe(error)}`); },
    };
    render();
    // El Player expone su API recién después de montar.
    const wait = (n = 0) => {
      if (ref.current) {
        player = ref.current;
        player.addEventListener('error', (e) => fail('runtime', e.detail?.error));
        let last = -1;
        player.addEventListener('frameupdate', (e) => {
          const f = e.detail.frame;
          if (Math.abs(f - last) >= 3 || !player.isPlaying()) { last = f; post({ type: 'frame', frame: f, playing: player.isPlaying() }); }
        });
        player.addEventListener('play', () => post({ type: 'frame', frame: player.getCurrentFrame(), playing: true }));
        player.addEventListener('pause', () => post({ type: 'frame', frame: player.getCurrentFrame(), playing: false }));
        post({ type: 'loaded' });
        smokeTest(zones, durationInFrames);
      } else if (n < 200) setTimeout(() => wait(n + 1), 25);
      else post({ type: 'error', phase: 'runtime', message: 'el Player no terminó de montar' });
    };
    wait();
  }

  window.addEventListener('error', (e) => fail('runtime', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => fail('runtime', e.reason));
  window.addEventListener('message', ({ data: msg }) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'load') return mount(msg);
    if (msg.type === 'transform' && current) {
      current = { ...current, inputProps: { ...current.inputProps, transform: msg.transform } };
      render();
      return;
    }
    if (msg.type === 'segments' && current) {
      current = { ...current, inputProps: { ...current.inputProps, segments: msg.segments } };
      render();
      return;
    }
    if (msg.type === 'render') { renderVideo(); return; }
    if (!player) return;
    if (msg.type === 'play') player.play();
    if (msg.type === 'pause') player.pause();
    if (msg.type === 'seek') player.seekTo(Math.max(0, Math.round(msg.frame || 0)));
  });
  post({ type: 'boot' });
})();
