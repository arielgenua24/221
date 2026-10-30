// Modo demo del Laboratorio: simula a los modelos con componentes de Remotion (o escenas del motor canvas) escritos a mano,
// así se puede probar todo el flujo (iframe, Player, métricas, historial) sin API key.
// Los modelos "flash/mini/luna" fallan la primera compilación a propósito: muestra la corrección automática.
// Los demás usan las herramientas (una búsqueda y, si hay generador, una imagen) para mostrar ese camino.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelado')); }, { once: true });
});

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const TITLE = `import { AbsoluteFill, Sequence, Img, interpolate, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont } from "@remotion/google-fonts/Syne";

const { fontFamily } = loadFont("normal", { weights: ["800"], subsets: ["latin"] });

type Zone = { id: string; from: number; durationInFrames: number; prompt: string; notes: string };

const Title: React.FC<{ text: string; dur: number }> = ({ text, dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const u = Math.min(width, height) / 100;
  const words = text.split(" ");
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: 7 * u, paddingBottom: 14 * u }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 * u, maxWidth: "88%" }}>
        {words.map((w, i) => (
          <span
            key={i}
            style={{
              fontFamily, fontWeight: 800, fontSize: 9 * u, lineHeight: 1, color: "#F4F1EA",
              textShadow: "0 0.4vmin 2vmin rgba(0,0,0,.35)",
              opacity: interpolate(frame, [i * 3, i * 3 + 0.35 * fps, dur - 0.4 * fps, dur - 4], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              translate: interpolate(frame, [i * 3, i * 3 + 0.5 * fps], [\`0px \${6 * u}px\`, "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
            }}
          >
            {w}
          </span>
        ))}
      </div>
      <div style={{ height: 0.7 * u, marginTop: 3 * u, background: "#FF5A1F", width: \`\${interpolate(frame, [0.2 * fps, 1.2 * fps], [0, 38], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) })}%\` }} />
    </AbsoluteFill>
  );
};

const Sticker: React.FC<{ src: string; dur: number }> = ({ src, dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const u = Math.min(width, height) / 100;
  return (
    <Img
      src={src}
      style={{
        position: "absolute", right: 6 * u, top: 8 * u, width: 26 * u, height: 26 * u, objectFit: "cover", borderRadius: 3 * u,
        boxShadow: "0 2vmin 5vmin rgba(0,0,0,.35)",
        scale: interpolate(frame, [0, 0.5 * fps, dur - 0.4 * fps, dur - 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.spring({ damping: 14 }) }),
        rotate: "-6deg",
      }}
    />
  );
};

export default function MotionLayer({ zones, images, sounds = {} }: { zones: Zone[]; images: Record<string, string>; sounds?: Record<string, string> }) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {zones.map((z, i) => (
        <Sequence key={z.id} name={z.id} from={z.from} durationInFrames={z.durationInFrames} premountFor={fps}>
          <Title text={(z.prompt || "Hecho a mano").split(" ").slice(0, 6).join(" ")} dur={z.durationInFrames} />
          {i === 0 && images.gen1 ? <Sticker src={images.gen1} dur={z.durationInFrames} /> : null}
          {sounds.sfx1 ? <Audio src={sounds.sfx1} volume={0.6} /> : null}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}`;

const LOWER_THIRD = `import { AbsoluteFill, Sequence, Img, interpolate, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", { weights: ["400", "800"], subsets: ["latin"] });

type Zone = { id: string; from: number; durationInFrames: number; prompt: string; notes: string };

const LowerThird: React.FC<{ text: string; index: string; dur: number }> = ({ text, index, dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const u = Math.min(width, height) / 100;
  const inOut = (a: number, b: number) => interpolate(frame, [a, b, dur - 0.5 * fps, dur - 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.65, 0, 0.35, 1) });
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", left: 6 * u, top: 8 * u, display: "flex", alignItems: "stretch", gap: 2 * u, opacity: inOut(0, 0.4 * fps) }}>
        <div style={{ width: 1.2 * u, background: "#3b82f6", scale: \`1 \${inOut(0, 0.5 * fps)}\` }} />
        <div style={{ background: "rgba(10,10,12,.72)", padding: \`\${2 * u}px \${3 * u}px\`, clipPath: \`inset(0 \${100 - 100 * inOut(0.1 * fps, 0.8 * fps)}% 0 0)\` }}>
          <div style={{ fontFamily, fontWeight: 400, fontSize: 2.8 * u, color: "#93c5fd", letterSpacing: "0.2em" }}>{index}</div>
          <div style={{ fontFamily, fontWeight: 800, fontSize: 5.2 * u, color: "white", maxWidth: 70 * u }}>{text}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Badge: React.FC<{ src: string; dur: number }> = ({ src, dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const u = Math.min(width, height) / 100;
  return (
    <Img
      src={src}
      style={{
        position: "absolute", left: 6 * u, bottom: 12 * u, width: 30 * u, height: 30 * u, objectFit: "cover", borderRadius: "50%",
        opacity: interpolate(frame, [0.3 * fps, 0.8 * fps, dur - 0.5 * fps, dur - 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        translate: interpolate(frame, [0.3 * fps, 1 * fps], ["0px 40px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
      }}
    />
  );
};

export default function MotionLayer({ zones, images, sounds = {} }: { zones: Zone[]; images: Record<string, string>; sounds?: Record<string, string> }) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {zones.map((z, i) => (
        <Sequence key={z.id} name={z.id} from={z.from} durationInFrames={z.durationInFrames} premountFor={fps}>
          <LowerThird text={z.prompt || "Motion de ejemplo"} index={String(i + 1).padStart(2, "0") + " / " + String(zones.length).padStart(2, "0")} dur={z.durationInFrames} />
          {i === 0 && images.gen1 ? <Badge src={images.gen1} dur={z.durationInFrames} /> : null}
          {sounds.sfx1 ? <Audio src={sounds.sfx1} volume={0.6} /> : null}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}`;

// La misma idea para el motor canvas (src/engines/canvas/): un título por zona con resorte, línea de acento,
// la imagen generada (si hay) y el primer efecto de sonido (si hay) al entrar la primera zona.
const CANVAS = `const FONTS = ['Syne:800'];
const AUDIO = Object.keys(sounds).slice(0, 1).map((id) => ({ sound: id, at: zones[0].from + 0.1, volume: 0.6 }));
const SCENES = zones.map((z, i) => ({
  from: z.from, to: z.to,
  draw(t) {
    const dur = z.to - z.from;
    const u = Math.min(W, H) / 100;
    const out = 1 - seg(t, dur - 0.4, dur - 0.05);
    const words = (z.prompt || 'Motion de ejemplo').split(' ');
    g.font = font(800, 9 * u, 'Syne');
    g.fillStyle = '#F4F1EA';
    g.shadowColor = 'rgba(0, 0, 0, .35)'; g.shadowBlur = 2 * u;
    let x = 7 * u;
    const y = H - 18 * u;
    words.forEach((w, k) => {
      const s = spring(t - k * 0.1, 220, 22);
      g.globalAlpha = clamp(s) * out;
      g.fillText(w, x, y + (1 - s) * 6 * u);
      x += g.measureText(w + ' ').width;
    });
    g.globalAlpha = out;
    g.shadowBlur = 0;
    g.fillStyle = '#FF5A1F';
    g.fillRect(7 * u, y + 3 * u, W * 0.38 * ease.outExpo(seg(t, 0.2, 1.2)), 0.7 * u);
    if (i === 0 && images.gen1) {
      const k = spring(t - 0.3, 180, 14);
      g.save();
      g.translate(W - 19 * u, 21 * u); g.rotate(-0.1); g.scale(k, k);
      drawFit(g, images.gen1, -13 * u, -13 * u, 26 * u, 26 * u);
      g.restore();
    }
  },
}));`;

// Precios aproximados (US$ por millón de tokens) para que el costo simulado tenga sentido entre modelos.
const PRICE = [[/opus|fable|astra/, 5, 25], [/sonnet|sol|grok|max/, 2, 10], [/flash|mini|luna|haiku|glm|deepseek|spark/, 0.15, 0.6]];

const toolCall = (name, args) => ({ id: `demo_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

export async function mockLabLLM({ model, messages, tools, toolChoice, onDelta, onReasoning, signal }) {
  const cheap = /flash|mini|luna|haiku|glm|deepseek|spark/.test(model);
  const usage = (n) => ({ prompt_tokens: n, completion_tokens: 120, total_tokens: n + 120, cost: n * 2e-6 });
  // Revisión visual: el demo mira sus capturas y aprueba (los baratos corrigen una vez antes de aprobar).
  const last = messages.at(-1)?.content;
  const reviewText = Array.isArray(last) ? last[0]?.text || '' : typeof last === 'string' ? last : '';
  const reviewRound = Number(/^Visual review (\d+)\//.exec(reviewText)?.[1]);
  if (reviewRound && (!cheap || reviewRound > 1)) {
    const shots = Array.isArray(last) ? last.filter((p) => p.type === 'image_url').length : 0;
    const text = `## Work log\n1. [x] (demo) Animación de cada zona\nCheckpoint (visual review ${reviewRound}): (demo · ${model}) miré ${shots} captura${shots === 1 ? '' : 's'}: no tapa caras, se lee bien, mantiene la paleta.\nAPPROVED`;
    await sleep(200, signal);
    onDelta?.(text);
    return { text, usage: usage(15000) };
  }
  // Herramientas (solo los modelos "caros" del demo, y una sola vez cada una).
  const can = (name) => tools?.some((t) => t.function.name === name);
  const used = (name) => messages.some((m) => m.tool_calls?.some((c) => c.function.name === name));
  const generated = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => /^gen\d/.test(p.text || '')));
  // Los modelos caros del demo obedecen el tool_choice; los baratos lo ignoran y buscan recién cuando se los pide el entorno.
  const asked = typeof messages.at(-1)?.content === 'string' && messages.at(-1).content.includes('buscar_referencias');
  const forced = toolChoice?.function?.name === 'buscar_referencias';
  if (can('buscar_referencias') && !used('buscar_referencias') && (forced || asked) && (!cheap || asked)) {
    await sleep(300, signal);
    onDelta?.('(demo) Busco una referencia de tipografía cinética.\n');
    return { text: '(demo) Busco una referencia de tipografía cinética.\n', toolCalls: [toolCall('buscar_referencias', { consulta: 'kinetic typography editorial lower third' })], usage: usage(16000) };
  }
  // Generar imagen: los "creativos" del demo lo hacen solos; los demás, cuando el entorno se lo pide.
  const askedImage = typeof messages.at(-1)?.content === 'string' && messages.at(-1).content.includes('generar_imagen');
  if (can('generar_imagen') && !used('generar_imagen') && !generated && ((!cheap && /opus|sol/.test(model)) || askedImage)) {
    await sleep(300, signal);
    return { text: '', toolCalls: [toolCall('generar_imagen', { prompt: '(demo) recorte del producto como sticker', imagenes: ['C1-1'], proporcion: '1:1' })], usage: usage(18000) };
  }
  // Context Lab: video y sonido. Los "creativos" del demo los usan solos; los demás, cuando el entorno se los pide.
  const lastText = typeof messages.at(-1)?.content === 'string' ? messages.at(-1).content : '';
  const zone = /^- (C\d+):/m.exec(messages.find((m) => m.role === 'user' && Array.isArray(m.content))?.content?.[0]?.text || '')?.[1] || 'C1';
  if (can('generar_video') && !used('generar_video') && ((!cheap && /opus|sol/.test(model)) || lastText.includes('generar_video'))) {
    await sleep(300, signal);
    return { text: '', toolCalls: [toolCall('generar_video', { zona: zone, prompt: '(demo) slow push-in, soft window light, same subject' })], usage: usage(19000) };
  }
  if (can('generar_sonido') && !used('generar_sonido') && (!cheap || lastText.includes('generar_sonido'))) {
    await sleep(200, signal);
    return { text: '', toolCalls: [toolCall('generar_sonido', { descripcion: '(demo) short soft whoosh, airy', duracion: 1 })], usage: usage(19000) };
  }
  const lastUser = messages.at(-1)?.content;
  const isFix = typeof lastUser === 'string';
  // Hasta que el entorno le marca el error, el modelo barato entrega código que no cumple el contrato.
  const corrected = messages.some((m) => typeof m.content === 'string' && /^(?:The code does not compile|El código no compila)/.test(m.content));
  // Motor canvas: el contrato del prompt de sistema pide `const SCENES` en un bloque ```js.
  const canvas = /const SCENES/.test(messages[0]?.content || '');
  let code = canvas ? CANVAS : hash(model) % 2 ? LOWER_THIRD : TITLE;
  // El modelo barato se equivoca la primera vez (usa Math.random) y lo corrige al recibir el error.
  if (cheap && !corrected) code = canvas ? code.replace('const out = 1', 'const out = Math.random() * 0 + 1') : code.replace('const frame = useCurrentFrame();', 'const frame = useCurrentFrame() + Math.random() * 0;');
  const searched = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => /^S1 — /.test(p.text || '')));
  const log = `## Work log\n1. [x] (demo) Mirar el storyboard y los cuadros de cada zona\n2. [x] (demo) Una pieza por zona en el espacio libre\nCheckpoint 50%: coherence ok · consistency ok · taste ok\nCheckpoint 100%: coherence ok · consistency ok · taste ok\n\n`;
  const notes = `${log}${isFix || reviewRound
    ? `(demo · ${model}) Corrijo lo que me marcaron y mantengo la idea.`
    : `(demo · ${model}) Idea: ${code !== LOWER_THIRD ? 'título cinético palabra por palabra con una línea de acento' : 'placa editorial con índice, entra con máscara y sale limpia'} en cada zona, en el espacio negativo.`}
Referencias usadas: ${searched ? 'S1, S3' : 'ninguna'}
Paleta: ${code !== LOWER_THIRD ? '#F4F1EA, #FF5A1F, #1B1B1F' : '#3B82F6, #93C5FD, #0A0A0C'}
Objetos: ${searched ? (code !== LOWER_THIRD ? 'línea de acento, sticker' : 'placa editorial, insignia redonda') : 'ninguno'}`;
  const text = `${notes}\n\n\`\`\`${canvas ? 'js' : 'tsx'}\n${code}\n\`\`\``;
  onReasoning?.('(demo) pensando…');
  for (let i = 0; i < text.length; i += 60) {
    await sleep(cheap ? 6 : 14, signal);
    onDelta?.(text.slice(i, i + 60));
  }
  const promptTokens = 14000 + messages.length * 1800;
  const completionTokens = Math.round(text.length / 3.6);
  const [, pin, pout] = PRICE.find(([re]) => re.test(model)) || [null, 1, 5];
  return {
    text,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost: (promptTokens * pin + completionTokens * pout) / 1e6 },
  };
}
