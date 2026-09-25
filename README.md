# 221 — Arnés de creación de contenido

Una sola caja de chat donde **soltás (drag & drop), pegás o elegís videos, audios, fotos y texto**, y tres modos que se eligen con un toque arriba de la caja (o solos: si soltás un audio o escribís "edición", pasa a Edición):

1. **💡 Ideas de contenido**: a partir de **fotos y una descripción del negocio**, decide qué contenido crear para Instagram/TikTok (orgánico). Entrega **4 ideas de contenido** (título + subtítulo, con hook, desarrollo, caption y cómo producirla sin filmar).
2. **🎬 Edición con música**: una **música** (grabación de voz, MP3, M4A, o el sonido de uno de tus videos) + tus **videos y fotos**. El **Director** (Opus) orquesta todo y el **Oído** (Gemini) entiende el sonido y cómo fluye. El Oído escucha **una vez**, vos le corregís lo que haga falta, y el Director monta **3 videos distintos** (una llamada por versión), para ver y exportar.
3. **✨ Intuition** (motion design): un **video vertical** + hasta **3 clips de hasta 5 s** que marcás en su línea de tiempo, cada uno con su pedido y sus referencias (imágenes, videos, GIFs, texto). Opus escribe **motion design como código** para cada clip, con un único sistema visual para los tres. Movés y redimensionás la **ventana** de cada clip, pedís cambios clip por clip, y al exportar el motion queda **quemado en el video**, en el lugar que elegiste.

## Cómo correrlo

Requiere Node 22+. No tiene dependencias.

```bash
cp .env.example .env      # poné tu OPENROUTER_API_KEY
npm start                 # http://127.0.0.1:3000
npm run demo              # modo demo: respuestas simuladas, sin API key
npm test
```

Sin `OPENROUTER_API_KEY`, la app arranca en **modo demo** automáticamente.

## Edición con música (modo 🎬)

```
Soltás música + videos/fotos + (opcional) qué querés transmitir
  │                         (el navegador decodifica el audio y extrae cuadros de cada video)
  ▼
[0] Análisis automático (código) → tempo, beats, compases, golpes, curva de energía
  ▼
[1] Director (Opus 5.5, ve cuadros y fotos) → intención, historia, catálogo de tomas,
    3 VERSIONES distintas (A, B, C) y ENCARGO para el Oído
  ▼
[2] Oído (Gemini 3.8 Flash, escucha el audio UNA vez) → mapa musical: secciones, energía, hit points,
    ritmo de corte, cómo fluye el tema y respuestas al Director
  ▼
 ✋ VOS: le decís al Oído si escuchó bien o lo corregís ("el estribillo arranca en 0:45")
  ▼
[3] Director × 3 llamadas en paralelo (cada una sigue su conversación de [1], con otra versión
    y otra temperatura) → qué toma va en cada segundo, con efecto y transición
  ▼
[4] Código → engancha cada corte al golpe más cercano y valida cada montaje
  ▼
3 reproductores: ves cada video sobre la música, elegís 9:16 / 1:1 / 16:9 y exportás el que quieras (MP4 o WebM)
```

- Si no tenés un audio aparte, tocá ♪ en un video para usar su sonido como música.
- Los videos no se suben al servidor: solo viajan el audio (WAV mono 16 kHz) y algunos cuadros. El render y la exportación se hacen en el navegador (en tiempo real: dejá la pestaña visible).
- Criterio de edición y por qué esta arquitectura: [investigacion/03-edicion-guiada-por-musica.md](investigacion/03-edicion-guiada-por-musica.md).

## Intuition: motion design sobre tu video (modo ✨)

```
Soltás UN video + marcás hasta 3 clips (≤ 5 s) + pedido y referencias por clip + (opcional) dirección general
  │                        (el navegador saca 6 cuadros de cada clip; el video no se sube)
  ▼
[1] Director de Arte (Opus 5.5, ve los cuadros y las referencias) → UN sistema visual para todo el video:
    paleta, tipografías, gramática de movimiento, easing, motivo recurrente; la idea de cada clip,
    con qué momento del video se sincroniza y dónde va su ventana por defecto
  ▼
[2] Motion Designer × clip, en paralelo (Opus 5.5) → notas + código Canvas 2D: draw(ctx, t, env)
    (el servidor verifica la sintaxis y el contrato; si falla, le pide la corrección)
  ▼
Reproductor: el código corre en un worker aislado (sin DOM ni red) y se dibuja encima del video
  ├─ ✋ VOS: movés y redimensionás la ventana de cada clip (el diseño se adapta a cualquier proporción)
  ├─ ✋ VOS: "Rehacer este clip" con tu pedido → solo ese clip, sin salirse del sistema visual
  │        (si el código falla o se cuelga, "Pedir que lo arregle" le manda el error al modelo)
  ▼
Exportar → MP4/WebM con el motion quemado en cada ventana y el sonido original
```

- **El criterio de gusto** que leen los dos agentes está en [src/MOTION_DESIGN.md](src/MOTION_DESIGN.md): mirar antes de diseñar, una idea por clip, estructura entrada/sostén/salida, easing, tipografía cinética, color, composición en 9:16, coherencia entre clips, qué evitar. Editalo para cambiar cómo diseña el equipo.
- **El contrato técnico** (helpers de animación, tipografías permitidas, reglas de determinismo) sale de [public/motion-lib.js](public/motion-lib.js), el mismo archivo que usa el reproductor: lo que se le documenta al modelo es lo que existe.
- Cada cuadro es una función pura del tiempo (sin `Math.random` ni reloj), así se puede adelantar, retroceder y exportar igual.
- Las tipografías (Google Fonts) se bajan en la página y se pasan al worker; si no cargan, se usan las del sistema.

## Cómo trabaja el equipo de ideas (v1)

```
Fotos + texto
  │
  ▼
[1] Orquestador (Opus 5.5, ve las fotos) → brief compartido + plan de 3 investigaciones
  ▼
 ✋ VOS: confirmás el brief y respondés sus preguntas (opciones para tocar)
  ├─► [2a] Investigador (Muse Spark) ┐
  ├─► [2b] Investigador (Muse Spark) ├─ en paralelo, con búsqueda web
  └─► [2c] Investigador (Muse Spark) ┘
  ▼
[3] Orquestador → 8 conceptos distintos (matriz Función × Ángulo × Formato × Consciencia × Emoción)
  ▼
[4] Crítico (otro modelo) → rúbrica de 7 criterios
  ▼
 ✋ VOS: marcás los conceptos que te gustan (o "que decida el equipo")
  ▼
[5] Orquestador → termina las 4 finales respetando tu elección
```

- Interfaz tipo chat, pensada primero para el celular: mandás un mensaje con fotos y en el centro aparecen los agentes trabajando y las decisiones que te tocan.
- La interfaz muestra en vivo las **notas de trabajo** de cada agente (y su razonamiento, si el modelo lo expone).
- Cada ejecución completa (entradas, salida cruda de cada agente, costos) se guarda en `runs/` para evaluar y mejorar.
- Por qué esta arquitectura: [investigacion/02-orquestacion-de-agentes.md](investigacion/02-orquestacion-de-agentes.md).
- El criterio de contenido que usan los agentes: [src/knowledge.js](src/knowledge.js), basado en [investigacion/01-fundamentos-creacion-de-contenido.md](investigacion/01-fundamentos-creacion-de-contenido.md).

## Estructura

| Archivo | Qué hace |
|---|---|
| `src/knowledge.js` | Manual de contenido compartido por todos los agentes |
| `src/prompts.js` | Rol de cada agente y encargo de cada etapa |
| `src/pipeline.js` | Orquestación: etapas, paralelismo, extracción/reparación de JSON |
| `src/openrouter.js` | Cliente de streaming de OpenRouter |
| `src/mock.js` | Modelos simulados para el modo demo |
| `src/agent.js` | Ejecuta un agente: streaming de notas, extracción/reparación de JSON, costos (compartido por ambos flujos) |
| `src/audio.js` | Análisis de audio sin dependencias: tempo, beats, compases, golpes, energía |
| `src/edit-prompts.js` | Manual de edición guiada por la música + prompts del Director y del Oído |
| `src/edit-pipeline.js` | Flujo de edición musical |
| `src/timeline.js` | Valida el montaje y engancha los cortes al ritmo |
| `src/MOTION_DESIGN.md` | Manual de motion design (el criterio de gusto de Intuition) |
| `src/intuition-prompts.js` | Prompts del Director de Arte y del Motion Designer + lectura de su respuesta (JSON + código) |
| `src/intuition-pipeline.js` | Flujo de Intuition: validación, sistema visual, un motion por clip, revisiones |
| `src/server.js` | Servidor HTTP + streaming de eventos (NDJSON) a la UI; `POST /api/run`, `POST /api/edit`, `POST /api/intuition`, `POST /api/intuition/revise`, `POST /api/decide` reanuda el flujo pausado |
| `public/` | Interfaz: `app.js` (caja única, soltar archivos, modos), `shared.js`, `media.js` (audio/cuadros), `ideas.js`, `edit.js`, `player.js` (reproductor y exportación), `intuition.js` (estudio de clips), `intuition-player.js` (overlay, ventana y exportación), `motion-lib.js` + `motion-worker.js` (runtime aislado del código generado) |

## Configuración (`.env`)

| Variable | Por defecto | Nota |
|---|---|---|
| `ORCHESTRATOR_MODEL` | `anthropic/claude-opus-5.5` | |
| `RESEARCHER_MODEL` | `meta/muse-spark-1.3-contributor` | La variante *contributor* permite a Meta entrenar con prompts y respuestas. |
| `CRITIC_MODEL` | = investigador | Distinto al orquestador a propósito |
| `RESEARCH_WEB` | `1` | Plugin web de OpenRouter; si falla, sigue sin web |
| `RESEARCHER_VISION` | `0` | Por defecto las fotos solo las ve el orquestador |
| `EAR_MODEL` | `google/gemini-3.8-flash,google/gemini-3.7-flash,qwen/qwen3.8-omni-flash` | Edición musical: el modelo que escucha. Tiene que aceptar audio. |
| `DIRECTOR_MODEL` | = orquestador | Edición musical: el que orquesta y monta. Tiene que aceptar imágenes. |
| `MOTION_MODEL` | = orquestador | Intuition: Director de Arte y Motion Designers. Tiene que aceptar imágenes. |
| `OPENROUTER_RETRIES` | `3` | Reintentos ante errores pasajeros (429 del pool compartido, 5xx, cortes de red) |

Cualquier variable de modelo acepta una **lista separada por comas**: si el primero no llega a responder
(saturado, sin cupo, inexistente), el paso sigue con el siguiente y la interfaz lo avisa. Antes de eso,
cada llamada reintenta sola los errores pasajeros, respetando el `Retry-After` del proveedor.
