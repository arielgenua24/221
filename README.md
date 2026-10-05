# 221 — Arnés de creación de contenido

Una sola caja de chat donde **soltás (drag & drop), pegás o elegís videos, audios, fotos y texto**, y tres modos que se eligen con un toque arriba de la caja (o solos: si soltás un audio o escribís "edición", pasa a Edición):

1. **💡 Ideas de contenido**: a partir de **fotos y una descripción del negocio**, decide qué contenido crear para Instagram/TikTok (orgánico). Entrega **4 ideas de contenido** (título + subtítulo, con hook, desarrollo, caption y cómo producirla sin filmar).
2. **🎬 Edición con música**: una **música** (grabación de voz, MP3, M4A, o el sonido de uno de tus videos) + tus **videos y fotos**. El **Director** (Opus) orquesta todo y el **Oído** (Gemini) entiende el sonido y cómo fluye. El Oído escucha **una vez**, vos le corregís lo que haga falta, y el Director monta **3 videos distintos** (una llamada por versión), para ver y exportar.
3. **✨ Intuition** (motion design): un **video vertical** + hasta **3 clips de hasta 5 s** que marcás en su línea de tiempo, cada uno con su pedido y sus referencias (imágenes, videos, GIFs, texto). Opus escribe **motion design como código** para cada clip, con un único sistema visual para los tres. Movés y redimensionás la **ventana** de cada clip, pedís cambios clip por clip, y al exportar el motion queda **quemado en el video**, en el lugar que elegiste.

## Raw (pestaña principal)

Tus **proyectos por carpetas** (ej. `pes13`, con subcarpetas si querés) y, adentro de cada uno, una **conversación por voz** con Raw, un director de arte que genera imágenes.

```
Entrás a la carpeta → Raw saluda en voz alta: "Hola, dime qué quieres trabajar hoy."
  │   (el micrófono está encendido por defecto; se apaga con el botón 🎙)
  ▼
Subís personas (👤) y referencias (🖼) → quedan guardadas en el proyecto, a mano para siempre
  ▼
Hablás: "convierteme a esta persona en un dibujo estilo PES 13 con la última referencia"
  ▼
Raw (RAW_MODEL, ve las imágenes con su código P1, R3, G2…) → categoriza las nuevas (estilo, personaje, pose…)
  ├─ ¿duda? → "A ver, espera: estas 3 son las últimas referencias. ¿A cuál te refieres?" + te las muestra
  │           ✋ VOS: tocás una o decís "a esta" / "la segunda"
  └─ ¿seguro? → modal "¿Te parece si hago esto?": referencias + resumen del plan
                ✋ VOS: aprobás por voz o botón → el generador elegido lo ejecuta
                ↳ si corregís: nueva propuesta, sin generar hasta que la apruebes
  ▼
La imagen aparece en "Generadas antes" (y también queda en el proyecto para seguir editándola)
```

- **Selector de voz en Raw e Historia**: `gemini` conserva la arquitectura anterior y es la opción inicial. `gpt audio` usa `openai/gpt-audio-mini` vía OpenRouter para escuchar audio directamente y responder con audio. La elección se guarda en el navegador y se comparte entre ambas pestañas.
- **Voz en modo gemini**: Gemini 3.8 Flash TTS en WaveSpeed (`RAW_TTS_MODEL`, voz `RAW_TTS_VOICE`). Cada frase se cachea en disco. Sin `WAVESPEED_API_KEY` (o si falla) habla la voz del navegador. La entrada usa reconocimiento de voz del navegador; en Chrome lo procesa Google. Mientras el agente piensa o habla, la escucha se pausa.
- **Voz en modo gpt audio**: el navegador captura WAV PCM16 mono a 24 kHz y detecta el fin de cada frase por silencio. GPT recibe `input_audio` y devuelve su propio audio PCM16 por streaming; su transcripción se muestra en la conversación. La entrada se transcribe mediante una herramienta del mismo modelo para conservar el historial, sin Web Speech API ni un servicio STT separado. El micrófono permanece disponible durante la respuesta para interrumpirla (se recomienda auriculares para reducir el eco). Es audio a audio **por turnos REST**, no una sesión WebRTC de OpenAI Realtime. Requiere `OPENROUTER_API_KEY`, modo demo desactivado y HTTPS o localhost para el micrófono; ante un error lo muestra y no cambia de arquitectura automáticamente.
- **Trabajo visual en gpt audio**: GPT Audio Mini no recibe imágenes. Consulta a los agentes visuales existentes mediante `work_on_project`; las tareas corren en el servidor y sus resultados vuelven a GPT para que los explique por voz. En Historia se conservan los botones de dibujo y aprobación de videos. Cambiar de modo/pestaña/proyecto corta la voz y libera el micrófono; los trabajos ya aceptados continúan. El historial sólo confirma como oídas las respuestas reproducidas completamente.
- **Configuración y registros**: `GPT_AUDIO_MODEL` (por defecto `openai/gpt-audio-mini`) y `GPT_AUDIO_VOICE` (por defecto `alloy`). Los recibos/resultados están en `runs/voice/`; las conversaciones se guardan en los proyectos habituales. Al reiniciar el servidor, los trabajos de voz inconclusos se marcan como error y no se vuelven a enviar automáticamente. [Documentación de audio de OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/audio).
- **Carpetas**: una subcarpeta ve las personas y referencias de sus carpetas padre. Todo se guarda en `runs/raw/` (`index.json` + `files/`).
- **Generador opcional en Raw e Historia**: el selector `GPT Image 2.5` / `Seedream 5 Pro` funciona con ambas opciones de voz. GPT Image conserva su configuración actual. [Seedream 5 Pro](https://wavespeed.ai/models/bytedance/seedream-v5.0-pro/edit) usa la misma clave WaveSpeed y `SEEDREAM_RESOLUTION` (`1k` por defecto; también `1.5k` o `2k`). Raw recuerda la elección en el navegador; Historia la guarda en cada proyecto para sus cuadros, revisiones y planchas. Los trabajos ya iniciados mantienen el generador elegido al pedirlos. Sin referencias, Historia usa la variante text-to-image de Seedream.
- **Tocar una imagen** la "señala": viaja con tu próximo mensaje ("esta").
- Mientras se genera una imagen podés seguir hablando.
- **Confirmación antes de generar, solo en RAW**: funciona con ambas voces y ambos generadores. El modal muestra las referencias reales en orden, el resumen, la proporción y el generador. Podés aprobar, rechazar o dar feedback por voz o con sus controles, conservando la conversación. El servidor espera la aprobación explícita de esa revisión después de mostrar todas sus referencias; «sí, pero…» requiere una propuesta nueva. Una confirmación repetida no vuelve a enviar la imagen. Las propuestas se guardan en `runs/raw-approvals/`; reiniciar no reintenta generaciones pendientes. Preparar/corregir el plan utiliza el modelo conversacional, pero no solicita imágenes a WaveSpeed hasta aprobar.

## Historia (pestaña)

Entrás a una carpeta de Raw y abrís Historia desde esa carpeta. Historia comparte **solo las personas, referencias e imágenes generadas de esa carpeta**. Contás la historia por voz o texto, y el equipo la arma en **tomas de 5 segundos**, la dibuja, la genera con **Wan 3.0** y la montás sobre tu música.

```
Elegís carpeta Raw y creás una historia (9:16, 16:9 o 1:1). La biblioteca muestra sus imágenes disponibles: tocarlas elige o quita referencias para el próximo mensaje, sin modificar el material de la historia. Las elegidas aparecen dentro del compositor. Al enviar texto o empezar a hablar, se captura esa selección y se limpia el borrador: las miniaturas quedan junto a ese mensaje humano y sobreviven a una recarga. Las referencias que elijas mientras hablás o se procesa un turno quedan para el siguiente. El Guionista recibe los adjuntos explícitos de cada turno separados del contexto previo. Las historias anteriores conservan material, guion y tomas. También podés agregar fotos a la carpeta o cuadros de video a la historia → M1, M2…; las cargas nuevas se seleccionan para el próximo mensaje. Hasta 16 referencias por mensaje.
  ▼
[1] Guionista (STORY_MODEL, ve el material) ⇄ VOS, en una conversación
    → historia (emoción, arco, estilo visual, personajes con nombre) + tomas: acción, seis viñetas, encuadre, cámara, luz, refs, prompt del cuadro
    → si le falta algo, pregunta con opciones para tocar; si pedís un cambio, toca SOLO esa toma
  ▼
[2] Storyboard: GPT Image 2.5 dibuja el PRIMER CUADRO y una plancha de seis momentos (2 filas × 3 columnas) para cada toma, en paralelo (con tu material como referencia;
    sin material, el primer cuadro fija el mundo y los demás lo usan para mantener personajes y look)
  ├─ ✋ VOS, toma por toma: "Pedir cambios" (el Guionista mira el cuadro y lo corrige) · editar el prompt a mano
  └─ ✋ VOS: "Aprobar y generar" (o "Aprobar todas")
  ▼  cada aprobación arranca su propia tarea, en paralelo:
[3] Director de Fotografía (STORY_DP_MODEL, ve el cuadro aprobado y las tomas vecinas) → acción, un movimiento de cámara,
    beats en 5 s, luz y sonido → prompt → Wan 3.0 image→video (480p, 5 s, con audio propio) → se baja a runs/story/files/
  ▼
[4] Montaje: las tomas en orden (arrastrar o ‹ ›), la pista de música con su volumen y desde qué segundo empieza
    (con fundido al final) → reproducir y exportar (MP4 o WebM, en el navegador)
```

- **El criterio**: los agentes leen [agents-film/](agents-film/) con [src/film-knowledge.js](src/film-knowledge.js). El Guionista recibe completas las guías de edición y emoción (Kuleshov, regla de seis, emoción no narrativa), estructura visual y encuadre; el Director de Fotografía, las de cinematografía (cámara, movimiento, encuadre, color) y luz. Los dos reciben el catálogo de reglas de toda la biblioteca y citan por id las que usan. Los prompts están en [src/story-prompts.js](src/story-prompts.js).
- **El cuadro aprobado ES el primer cuadro del video**: lo que aprobás es lo que se anima.
- **Todo lo largo corre en el servidor** ([src/story-pipeline.js](src/story-pipeline.js)): podés cerrar la pestaña mientras se generan las tomas. Si el servidor se reinicia con una toma ya enviada a WaveSpeed, la retoma sin volver a pagarla.
- Las tomas que todavía no tienen video se ven en el montaje como su cuadro (y así se exportan, si querés).
- Las tomas nuevas generan sonidos propios sincronizados con la acción; el montaje conserva ese sonido y mezcla la música opcional. Las tomas anteriores que salieron mudas se rehacen desde “Cambiar esta toma” → “Rehacer el video”.
- Los diálogos de Historia usan por defecto español rioplatense de Buenos Aires, con acento porteño natural. Se conservan las frases dadas por el usuario, y puede pedir otro idioma o acento en la conversación.
- Cada proyecto se guarda en `runs/story/projects/<id>.json`; los nuevos archivos de Historia, en `runs/story/files/`. Las imágenes vinculadas conservan su archivo en `runs/raw/files/` y su nombre de Raw se actualiza antes de conversar con el modelo.

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

### Clips "Video IA + texto" (opción por clip)

A veces la mejor animación no es animar: es **dirigir**. En cada clip elegís **Motion en código** (lo de arriba) o **Video IA + texto**:

```
[2'] Director de Video IA (Opus 5.5, perfeccionista) → elige el mejor cuadro real del clip como primer cuadro
     y escribe la toma al detalle: cámara, lente, luz, física, tiempos, qué no puede cambiar, y el prompt (en inglés)
  ▼
Storyboard: GPT Image 2.5 (WaveSpeed) dibuja 6 viñetas a partir del cuadro base
  ├─ ✋ VOS: "Generar el video", o "Pedir cambios" (Opus mira el storyboard y corrige) · podés editar el prompt a mano
  ▼
En paralelo:
  ├─ Seedance 2.0 o Wan 3.0 Prime (WaveSpeed, image→video) genera la toma a partir del cuadro real (1–5 min)
  └─ Tipógrafo (Opus 5.5) → capa de SOLO palabras (+ velo/subrayado de legibilidad), sincronizada con los tiempos de la toma
  ▼
Reproductor: durante el clip se ve la toma generada (muda: sigue el audio original) y encima, las palabras
```

- Necesita `WAVESPEED_API_KEY`. Sin clave, la opción no aparece; en modo demo el storyboard es el cuadro base y no se genera video.
- Los storyboards y las tomas se guardan en `runs/media/` y se sirven en `/media/…` (mismo origen: así se pueden exportar).
- "Rehacer el texto" en un clip de video IA manda cuadros de la **toma generada**, para que el texto se ubique sobre lo que realmente se ve.

### Clips "Cinematic Pro" (opción por clip)

Tu clip ya está filmado: la idea es que **se vea como cine sin perder lo que tiene** (lo que la persona hace y dice, el audio, el momento). En cada clip elegís **🎞️ Cinematic Pro**:

```
[2''] Director de Fotografía (Opus 5.5) lee la biblioteca agents-film (luz, color, cámara, encuadre, estructura visual)
      y mira los cuadros del clip → diagnóstico por componente, reglas aplicadas (citadas por id) y un TRATAMIENTO:
      grade (balance, contraste, split toning, negros), luz motivada (ventana, key, contraluz, práctica, sombra),
      cámara virtual (push-in, drift, temblor de mano) y textura (grano, halation, viñeta), con entrada/salida suave
  ▼
Reproductor: el tratamiento se aplica en WebGL sobre tu video real, cuadro a cuadro (se ve al instante y se exporta igual)
  ├─ ✋ VOS: control de intensidad (0–150 %), "Mantener: ver original" para comparar, "Rehacer el tratamiento" con tu pedido
  └─ RE-FILMAR con IA (el corazón de Cinematic Pro: se propone siempre):
     1. contrato de intención: el DP pone cada cambio en un eje (punto de vista, elementos, acción, lugar, luz, look);
        lo que no cambia se conserva. Si tu pedido admite dos lecturas (¿"cámara espía" es desde dónde se ve o un objeto?),
        ✋ VOS elegís antes de que se dibuje nada
     2. GPT Image dibuja a mano el storyboard de la toma (6 viñetas, 3 × 2) → ✋ VOS lo aprobás o pedís cambios (el DP rehace y se redibuja)
     3. ✋ VOS elegís el modelo (Wan 3.0 Prime reference→video o Seedance 2.5 con referencias; WaveSpeed, 480p) y re-filma
        siguiendo el storyboard aprobado (la fuente de la verdad).
        Misma cámara: el navegador graba el tramo en MP4 y va como "Video 1". Cámara nueva: no se manda el clip
        (empujaría a copiar la cámara original), solo el storyboard + 3 cuadros del clip para la identidad
     → durante el clip se ve la toma re-filmada (con la textura del tratamiento encima)
```

- **La biblioteca** es [agents-film/](agents-film/): cada guía en `.md` (para aprender) y `.json` (reglas accionables). El DP recibe completas las guías de luz, color, movimiento de cámara, encuadre y estructura visual, y el catálogo de reglas de todas. Se lee al arrancar: sumar una guía nueva la incorpora sola ([src/film-knowledge.js](src/film-knowledge.js)). Va primero en el prompt y marcada para el caché del proveedor.
- **El contrato del tratamiento** (parámetros, rangos, cómo se dibuja) está en [public/cine-lib.js](public/cine-lib.js), que usan el servidor (valida y documenta) y el reproductor (dibuja).
- Funciona sin WaveSpeed (solo tratamiento). Re-filmar necesita `WAVESPEED_API_KEY`; el modelo y la resolución se cambian con `CINE_REFILM_MODEL` y `CINE_REFILM_RESOLUTION`. Los clips de Cinematic Pro duran al menos 1.2 s (el modelo pide ≥ 1 s de video de referencia).

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
| `src/story-store.js` | Historia: proyectos (material, conversación, historia, tomas, montaje) en `runs/story/` |
| `src/story-prompts.js` | Historia: prompts del Guionista y del Director de Fotografía, con la biblioteca agents-film |
| `src/story-pipeline.js` | Historia: turno de conversación + tareas en segundo plano por toma (cuadro, dirección, video Wan 3.0) |
| `public/story.js` / `public/story-timeline.js` | Historia: la pestaña (chat, storyboard, tomas) y el montaje (orden, música, volumen, exportación) |
| `src/raw-store.js` | Raw: carpetas, imágenes (personas, referencias, generadas) y conversación, en `runs/raw/` |
| `src/raw-agent.js` / `src/raw-prompts.js` | Raw: un turno de conversación (qué ve el agente, qué contesta, cuándo pregunta, cuándo genera) |
| `src/raw-voice.js` | Raw: texto → voz (TTS de WaveSpeed) con caché |
| `public/raw.js` | Raw: la pestaña (carpetas, tarjeta, micrófono, reproducción de voz, biblioteca, generadas) |
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
| `src/intuition-pipeline.js` | Flujo de Intuition: validación, sistema visual, un motion por clip (o toma de video IA + capa de texto), revisiones |
| `src/film-knowledge.js` | Carga la biblioteca agents-film (guías .md + reglas .json) y arma el manual de cine de los agentes |
| `src/cine-prompts.js` | Prompts del Director de Fotografía (Cinematic Pro) y del re-filmado con IA |
| `src/wavespeed.js` | Cliente de WaveSpeed: subida de cuadros, storyboard (GPT Image 2.5) y video (Seedance 2.0 / Wan 3.0 Prime) |
| `src/server.js` | Servidor HTTP + streaming de eventos (NDJSON) a la UI; `POST /api/run`, `POST /api/edit`, `POST /api/intuition`, `POST /api/intuition/revise`, `POST /api/decide` reanuda el flujo pausado |
| `public/` | Interfaz: `app.js` (caja única, soltar archivos, modos), `shared.js`, `media.js` (audio/cuadros), `ideas.js`, `edit.js`, `player.js` (reproductor y exportación), `intuition.js` (estudio de clips), `intuition-player.js` (overlay, ventana y exportación), `motion-lib.js` + `motion-worker.js` (runtime aislado del código generado), `cine-lib.js` (tratamiento de Cinematic Pro en WebGL) |

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
| `WAVESPEED_API_KEY` | — | Intuition · Video IA + texto. Sin clave, la opción no aparece. |
| `VIDEO_MODEL` | `seedance` | Modelo de video por defecto (`seedance` o `wan`); se cambia en cada clip. |
| `VIDEO_RESOLUTION` | `720p` | `480p`, `720p` o `1080p`. |
| `STORYBOARD_MODEL` / `STORYBOARD_QUALITY` | `openai/gpt-image-2.5-flare/edit` / `high` | Modelo y calidad del storyboard. |
| `SEEDANCE_MODEL` / `WAN_MODEL` | rutas de WaveSpeed | Por si WaveSpeed publica otra versión. |
| `STORY_MODEL` / `STORY_DP_MODEL` | = orquestador | Historia: Guionista y Director de Fotografía. Tienen que aceptar imágenes. |
| `STORY_FRAME_MODEL` / `STORY_FRAME_EDIT_MODEL` | GPT Image 2.5 Flare text-to-image / edit | Cuadros del storyboard (sin / con material de referencia). |
| `STORY_VIDEO_MODEL` / `STORY_VIDEO_RESOLUTION` | `alibaba/wan-3.0-prime/image-to-video` / `480p` | Video de cada toma (5 s). |
| `OPENROUTER_RETRIES` | `3` | Reintentos ante errores pasajeros (429 del pool compartido, 5xx, cortes de red) |

Cualquier variable de modelo acepta una **lista separada por comas**: si el primero no llega a responder
(saturado, sin cupo, inexistente), el paso sigue con el siguiente y la interfaz lo avisa. Antes de eso,
cada llamada reintenta sola los errores pasajeros, respetando el `Retry-After` del proveedor.
