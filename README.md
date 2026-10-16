# 221 — Arnés de creación de contenido

Una sola caja de chat donde **soltás (drag & drop), pegás o elegís videos, audios, fotos y texto**, y tres modos que se eligen con un toque arriba de la caja (o solos: si soltás un audio o escribís "edición", pasa a Edición):

1. **💡 Ideas de contenido**: a partir de **fotos y una descripción del negocio**, decide qué contenido crear para Instagram/TikTok (orgánico). Entrega **4 ideas de contenido** (título + subtítulo, con hook, desarrollo, caption y cómo producirla sin filmar).
2. **🎬 Edición con música**: una **música** (grabación de voz, MP3, M4A, o el sonido de uno de tus videos) + tus **videos y fotos**. El **Director** (Opus) orquesta todo y el **Oído** (Gemini) entiende el sonido y cómo fluye. El Oído escucha **una vez**, vos le corregís lo que haga falta, y el Director monta **3 videos distintos** (una llamada por versión), para ver y exportar.
3. **✨ Intuition** (motion design): un **video en su formato original** + hasta **3 clips de hasta 5 s** que marcás en su línea de tiempo, cada uno con su pedido y sus referencias (imágenes, videos, GIFs, texto). Opus escribe **motion design como código** para cada clip, con un único sistema visual para los tres. Movés y redimensionás la **ventana** de cada clip, pedís cambios clip por clip, y al exportar el motion queda **quemado en el video**, en el lugar que elegiste.

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

## Laboratorio · Motion Design (pestaña)

Un banco de pruebas para comparar **dos modelos haciendo exactamente el mismo trabajo**: motion design programático con **Remotion** sobre un clip real. La idea es aprender qué modelo conviene para cada tipo de animación, y cuánto cuesta de verdad cada animación aprobada.

```
Modelo A                    Configuración compartida                Modelo B
selector (OpenRouter)       1 · clip + zonas marcadas (hasta 11 s)  selector (OpenRouter)
                                (el mismo marcador de ✨ Intuition)
                            2 · brief: contexto, referencias
                                visuales, instrucciones
  ▼  "Ejecutar experimento": dos ejecuciones independientes, en paralelo (ninguna ve a la otra)
[agente] mismo prompt de sistema (contrato + Remotion Agent Skills), mismo material (cuadros de cada zona + referencias)
   → SIEMPRE busca referencias en internet (Google Images vía SerpAPI) y genera al menos una imagen propia
     (Nano Banana 2.1 por WaveSpeed, hasta 2) que tiene que usar en la animación
   → escribe UN componente TSX de Remotion: la CAPA de motion (el video lo pone el entorno debajo)
   → el servidor lo compila (esbuild) y valida el contrato
   → si no compila: se le devuelve el error y corrige solo (hasta 2 veces por ejecución)
   ▼
[Player] @remotion/player en un iframe aislado → prueba de humo: recorre el inicio, el medio y el final de cada zona
   → si falla al reproducir: corrige solo (hasta 2 veces seguidas); si no, queda el botón "Corregir el error"
   ▼
3 · Comparar: los dos lado a lado (reproducción sincronizada, saltar a cada zona), tabla de métricas.
    En cada lado: arriba del video, qué buscó, con qué referencias se quedó y qué imágenes generó;
    feedback continuo (lo que escribís mientras trabaja queda en cola y se manda junto al terminar);
    ajustar tamaño y posición de la capa; cortar y mover tramos de la animación en el tiempo;
    descargar el video; aprobar / rechazar, calidad y fidelidad (1–5) y cuál preferís → todo queda en el Historial
```

- **Mismo harness para los dos** ([src/lab/harness.js](src/lab/harness.js)): las [Remotion Agent Skills](https://github.com/remotion-dev/skills) oficiales copiadas en [src/lab/remotion-skills/](src/lab/remotion-skills/) (fijadas a un commit), el mismo contrato, la misma versión de Remotion y los mismos paquetes permitidos. `HARNESS_VERSION` queda guardado en cada experimento: si cambiás el harness, subila, así el historial separa las mejoras del modelo de las del harness.
- **Composition: add-on and fullscreen**: the Motion Designer chooses the format for each scene from the user’s request and the content. An add-on occupies part of the picture and leaves unused space transparent; a fullscreen composition covers the entire picture with its own designed opaque background. Both can appear in the same video or marked zone. Zones constrain time, not screen coverage. The environment keeps the original video underneath and its audio running. Canvas draws the fullscreen background on every frame; Remotion places it inside the scene’s `Sequence`. Scale and position controls still affect the entire animation layer, so use the default size and position for edge-to-edge fullscreen coverage. This direction is shared in [src/lab/composition.js](src/lab/composition.js), with engine-specific instructions in [src/lab/canvas-contract.js](src/lab/canvas-contract.js) and [src/lab/harness.js](src/lab/harness.js). Context Lab uses the same defaults; saved custom system templates keep their own text and can be updated with **Restaurar por defecto**. The component receives `zones` (frames at 30 fps) and generated `images`. Legacy harness v1 experiments remain viewable but cannot be transformed separately.
- **Herramientas** ([src/lab/tools.js](src/lab/tools.js)), con los mismos límites para los dos modelos: `buscar_referencias` (Google Images vía SerpAPI, hasta 3 búsquedas por ejecución; solo para mirar). **Buscar es obligatorio** al diseñar y al revisar (no al corregir un error técnico): la primera llamada fuerza la herramienta con `tool_choice`; si el proveedor no lo permite, se pide por instrucción; y si el modelo igual entrega código sin buscar, no se compila y se le pide que busque primero (una vez). La otra herramienta es `generar_imagen`: Nano Banana 2.1 por WaveSpeed (`google/nano-banana-2.1/text-to-image` sin referencias y `google/nano-banana-2.1/edit` con referencias), con prompt y, si quiere, cuadros, referencias o búsquedas como entrada; hasta 2 imágenes por lado, para usar dentro de la animación. **Generar al menos una es obligatorio** en la primera ejecución: si escribe el componente sin generar, se le pide una vez; y si genera y no la usa en el código, se le pide que la integre. Las referencias tienen dos usos que el prompt le enseña: sacar una **paleta de colores** (3 a 6 hex que tiene que usar en el código) y detectar **objetos o motivos** de referencia (si los hay) para llevarlos a la animación. En las notas declara `Referencias usadas: S2, S5…`, `Paleta: #…` y `Objetos: …`; arriba del video se ven las referencias elegidas, la paleta en muestras (marcando cuáles colores aparecen de verdad en el código) y los objetos. Sin `SERPAPI_API_KEY` no hay búsqueda (la pantalla lo avisa); la generación requiere `WAVESPEED_API_KEY`. Las referencias se suben a WaveSpeed y el resultado se descarga y convierte a data URL para el iframe de Remotion. Los modelos y costos orientativos se pueden ajustar con `LAB_IMAGE_MODEL`, `LAB_IMAGE_EDIT_MODEL`, `LAB_IMAGE_COST` y `LAB_IMAGE_REFERENCE_COST`. Puede importar `remotion`, `@remotion/media`, `transitions`, `effects`, `shapes`, `paths`, `noise`, `rough-notation`, `layout-utils`, `motion-blur`, `light-leaks`, `animation-utils` y 20 familias de `@remotion/google-fonts` ([src/lab/runtime.js](src/lab/runtime.js)).
  Desde el harness v8, un timeout local de búsqueda (20 s) vuelve al agente como error recuperable: puede seguir con las referencias disponibles o reintentar si queda cupo. Cada intento consume el límite y el costo orientativo de búsqueda; detener manualmente sigue cancelando la ejecución. Las consultas buscan una necesidad visual por vez, con inspiración libre y sin exigir dos búsquedas; ante resultados pobres, se simplifica o cambia de enfoque.
- **Aislamiento**: el código de cada agente corre en un iframe `srcdoc` con `sandbox="allow-scripts"` (origen opaco: no ve la app ni su almacenamiento) y una CSP sin red, salvo Google Fonts. El video entra como `Blob` por `postMessage`.
- **Cortar y mover la animación**: cada lado tiene una pista con los tramos de la capa (al principio, uno por zona). Se pueden arrastrar a otro momento del video, recortar por los bordes, dividir en el cursor, duplicar o quitar. Es un reacomodo en el tiempo de la capa del agente (con dos `<Sequence>` anidadas en el iframe): el video no se toca.
- **Descargar video**: renderiza en el navegador, con `@remotion/web-renderer`, la composición tal cual se ve (escala, posición y cortes). Si el navegador no puede decodificar el video de base, renderiza solo la capa (WebM transparente) y la compone sobre el original en un canvas con MediaRecorder, como el export de Intuition. Hay que dejar la pestaña visible mientras tanto.
- **Métricas por ejecución**: costo (todas las llamadas, también correcciones, revisiones y herramientas; `usage.cost` de OpenRouter + costo orientativo de SerpAPI y Nano Banana 2.1 (US$ 0.04 a 1k + US$ 0.002 por referencia de entrada)), tiempo generando, intentos (componentes que tuvo que escribir: cada ejecución + cada recompilación; las vueltas de herramientas no cuentan), correcciones automáticas, herramientas usadas, intervención manual (revisiones pedidas + haber ajustado tamaño/posición + minutos de retoque que anotás) y tokens.
- **Historial**: por modelo, ejecuciones, aprobadas, veces preferido, calidad y fidelidad medias, costo medio, **costo por animación aprobada** (todo lo gastado ÷ aprobadas), tiempo, intentos e intervención medios. Cada experimento se puede reabrir (video, zonas, brief, código y evaluaciones) o exportar todo a JSON.
- **Dónde se guarda**: en el navegador. `localStorage` guarda los experimentos (configuración, métricas, evaluaciones); IndexedDB, lo pesado por referencia (el video, los cuadros, las referencias y el código de cada agente). Borrar los datos del sitio borra el historial.
- En modo demo, los agentes devuelven componentes de ejemplo; los modelos "baratos" (flash, mini, luna…) fallan la primera compilación a propósito para mostrar la corrección automática.
- Remotion tiene su propia licencia: es gratis para personas y empresas chicas, y las empresas más grandes necesitan una licencia de empresa ([remotion.dev/license](https://www.remotion.dev/license)).

## Laboratorio · Motores de animación (Remotion o motor propio)

El agente, las herramientas, las zonas, las capas, los cortes, la revisión y el render son **los mismos**; lo único que cambia es el **motor**: cómo se escribe, se compila, se reproduce y se renderiza la animación. En Motion Design se elige por experimento (los dos modelos compiten sobre el mismo motor); en Context Lab, por variante (se pueden comparar motores con el mismo modelo).

| | Remotion (`remotion`) | Motor propio (`canvas`) |
|---|---|---|
| El agente escribe | un componente React/Remotion (```` ```tsx ````) | JavaScript plano que dibuja en un `<canvas>` 2D (```` ```js ````) |
| Contrato | `export default`, `useCurrentFrame()`, `<Sequence>`… + Remotion Agent Skills | `const SCENES = [{ from, to, draw(t, p) }]` (+ `FONTS`, `AUDIO` opcionales) y helpers globales: `spring`, `rng`, `ease`, `clamp`, `seg`, `font`, `drawFit`… |
| Antes de mostrarse | esbuild + validación del contrato | esbuild + validación + **prueba de humo en node:vm** con un contexto 2D falso que falla como el real (radios negativos, `addColorStop` fuera de [0, 1], imágenes inexistentes, bucles infinitos) |
| Iframe | React + Remotion + `<Player>` (~2 MB) | kit + reproductor propio, arranca al instante |
| Descargar video | `@remotion/web-renderer` | cuadro a cuadro con WebCodecs (mediabunny): determinista y no depende de que la pestaña esté visible; si el navegador no puede, graba en tiempo real |

```
src/engines/
  index.js        registro: getEngine(id), engineList(), DEFAULT_ENGINE ('remotion'); id desconocido → Remotion
  frame-doc.js    documento del iframe aislado (CSP compartida)
  remotion.js     adaptador del motor de siempre (src/lab/runtime.js + src/lab/frame.js, sin cambios)
  canvas/
    kit.js        núcleo: helpers + evaluate() + drawAt(t). Script clásico: corre igual en el iframe, en la página suelta y en node:vm
    frame.js      reproductor del iframe: MISMO protocolo postMessage que el de Remotion (boot / load / checked / frame / render…)
    index.js      compile() + prueba de humo, frameDocument(), standaloneDocument() (página con window.seek(t))
    render.js     render headless de alta calidad: Chromium (Playwright) → PNG por subcuadro → ffmpeg tmix (motion blur) → mp4
```

Cada motor cumple el mismo contrato (`id`, `version`, `fence`, `words`, `extractCode`, `compile(code, env)`, `frameDocument()`); el iframe de cualquier motor habla el mismo protocolo, así que una página usa cualquiera sin saber cuál es. **Para usarlo en otra parte de la app:** en el servidor, `getEngine(id).compile(code, { width, height, duration, fps, zones, images, sounds })`; en el navegador, `GET /api/lab/frame.html?engine=<id>` en un iframe `sandbox="allow-scripts"` y los mismos mensajes (`load` → `loaded` / `checked`, `seek`, `render` → `rendered`). Para sumar un motor: un módulo con ese contrato y una entrada en `ENGINES`. La firma del harness incluye el motor (`v8 · canvas v1 · …`), así el historial los separa.

Render headless (opcional, fuera de la app; necesita `npm i -D playwright && npx playwright install chromium` y `ffmpeg`):

```bash
node src/engines/canvas/render.js --code scenes.js --width 1080 --height 1920 --dur 15 --fps 60 --sub 4 --video base.mp4 --out out/final.mp4
```

## Laboratorio · Context Lab (pestaña)

La idea inversa de Motion Design: **un solo modelo**, el mismo clip y las mismas zonas, y de **2 a 4 variantes de contexto**. Sirve para practicar *context engineering*: qué entra en la ventana de contexto del agente y qué herramientas le das cambia el resultado tanto como el modelo. Está en `/#laboratorio/context-lab`.

```
Modelo (uno)            1 · clip + zonas (el mismo marcador de ✨ Intuition)
                        2 · pedido base: contexto, instrucciones, referencias (lo heredan las variantes)
  ▼
3 · Variantes: cada una elige
    · herramientas, cada una Apagada / Opcional / Obligatoria, con su máximo:
        buscar referencias (SerpAPI) · generar imagen (Nano Banana 2.1) ·
        generar sonido (SFX, WaveSpeed text→audio) · generar video IA (Seedance / Wan, image→video)
    · pedido propio o heredado; referencias del pedido base, propias o ninguna
    · qué documentos .md adjuntos del pedido base recibe
    · cuántos cuadros por zona ve (0 a 6) · temperatura · nivel de razonamiento (los niveles que acepta el modelo)
    · qué Remotion Agent Skills entran (con su tamaño en tokens)
    · ejemplos (few-shot)
    · el prompt de sistema completo (plantilla editable con {{herramientas}}, {{ejemplos}} y {{skills}})
  ▼  "Ejecutar variantes": una ejecución por variante, en paralelo (ninguna ve a las otras), mismo harness de Remotion
Player por variante, en capas: video original → tomas de IA (cada una en su capa) → animación del agente
  → cada capa se oculta, mueve o escala por separado; los sonidos suenan dentro de la animación
  ▼
4 · Comparar: tabla con las perillas que cambian resaltadas, contexto inicial (tokens de entrada de la 1.ª llamada),
    costo, tiempo, intentos y herramientas usadas; aprobar, calidad, fidelidad y variante preferida → Historial
```

- **Mismo bucle que Motion Design** ([src/lab/pipeline.js](src/lab/pipeline.js)): `runLabAgent` recibe la configuración de la variante (prompt de sistema, modos, límites, cuadros, temperatura y razonamiento). Sin configuración se comporta exactamente como antes, así que Motion Design no cambia. La configuración se arma y valida en [src/lab/context.js](src/lab/context.js).
- **Modos**: *Opcional* = el modelo decide. *Obligatoria* = si escribe el componente sin usarla, se le pide una vez (la búsqueda además se fuerza con `tool_choice` en la primera llamada, como en Motion Design). Una herramienta *Apagada* no se le ofrece y, si el modelo la inventa, no se ejecuta.
- **Sonido**: `generar_sonido` deja `sounds.sfx1…` y el agente los pone con `<Audio>` de `@remotion/media`. Se mezclan sobre el audio original y quedan en la descarga. El modelo y su costo orientativo se cambian con `LAB_SFX_MODEL` y `LAB_SFX_COST`.
- **Video IA**: `generar_video(zona, imagen?, prompt)` genera una toma image→video a partir de un cuadro de la zona. **No entra en el componente**: el entorno la pone en su propia capa durante la zona, entre el video original y la animación. Tarda minutos. Se configura con `LAB_VIDEO_RESOLUTION` y `LAB_VIDEO_COST_PER_SECOND`. El agente no ve la toma generada: solo sabe de qué cuadro partió y qué pidió.
- **Rutas**: `GET /api/lab/context/info`, `POST /api/lab/context/preview` (el prompt de sistema final de una variante) y `POST /api/lab/context/run` (NDJSON, como `/api/lab/run`).
- **Dónde se guarda**: en el navegador, con su propio namespace (`lab.context.*` en localStorage e IndexedDB `lab-context`). Las variantes de trabajo se recuerdan entre visitas. Las tomas de video quedan en `runs/media/`.
- En modo demo, la "toma de IA" es un cuadro quieto del clip y el sonido, un barrido sintético: alcanza para probar las capas sin pagar.
- Pruebas: `node --test test/context-lab.test.js`. Navegador: `PLAYWRIGHT_MODULE=/ruta/a/playwright/index.mjs node test/browser/context-lab.mjs` (servidor demo; necesita ffmpeg para armar el clip de prueba).

## Laboratorio · Documentos adjuntos (.md)

En Motion Design y en Context Lab podés **adjuntar los archivos Markdown que quieras** (guía de marca, guion, notas de estilo, briefs…). El agente los recibe **enteros** en el primer mensaje, en una sección «Documentos adjuntos» entre las instrucciones y las zonas, cada uno entre etiquetas `<documento nombre="…">`.

- **Cómo se adjunta**: botón «Adjuntar .md» del brief (acepta varios a la vez) o soltando los archivos en la pestaña. Cada archivo muestra su tamaño en tokens (≈ caracteres ÷ 4) y la lista, el total. Se quitan con ×; pasar el cursor por un archivo muestra el comienzo. También se aceptan `.markdown` y `.txt`.
- **Motion Design**: los adjuntos son del brief compartido: los dos agentes reciben exactamente los mismos. Se guardan con el experimento y se restauran al reabrirlo.
- **Context Lab**: dos formas, combinables. (1) **Adjuntos propios de una variante**: cada tarjeta tiene su botón «Adjuntar .md» (bloque «Documentos adjuntos»): lo que adjuntás ahí lo recibe *solo esa variante*, así probás un documento en V1 y no en V2. (2) **Adjuntos del pedido base** (se recuerdan entre visitas): cada variante marca con casillas cuáles recibe. Cada variante recibe los base que dejó marcados + sus propios, y el bloque dice cuántos documentos y tokens recibe. Duplicar una variante copia también sus adjuntos propios. La tabla de comparación suma la fila «Adjuntos (.md)» y los tokens entran en el contexto inicial de cada variante.
- **Límites** ([src/lab/docs.js](src/lab/docs.js)): hasta 10 archivos, 120 mil caracteres por archivo (≈ 30 mil tokens) y 400 mil entre todos (≈ 100 mil tokens). Lo que se pasa se rechaza con un aviso, en vez de recortarse en silencio. No se aceptan archivos vacíos, binarios ni repetidos.
- **Prioridad**: el prompt le dice al agente que los documentos son material y criterio de diseño, y que si algo choca con el contrato del entorno (archivo único, imports permitidos, determinismo, dibujar solo en las zonas), manda el contrato. Un `</documento>` dentro del texto no corta la etiqueta.
- Pruebas: `node --test test/docs.test.js`.

## Laboratorio · Clips Automático o Manual

En la tarjeta «1 · Clip y zonas» de Motion Design y de Context Lab, el marcador tiene dos modos (se recuerda el último que usaste):

```
✨ Automático                                         ✋ Manual
cuántas animaciones querés (1 a 6)                    el marcador de siempre: "+ Marcar clip acá",
  ▼                                                   arrastrar el clip o sus bordes
transcribe el clip con Whisper (si todavía no lo hiciste)
  ▼
un agente lee la transcripción por segundo y elige, entre las ideas más útiles, EXACTAMENTE las zonas que pediste
  + de cada zona, 2 a 4 segundos concretos de los que quiere VER el cuadro  + una frase con qué se dice y qué animación iría
  ▼
el navegador recorta del video los cuadros de esos segundos (el mismo mecanismo del marcador; no hace falta ffmpeg)
  ▼
las zonas quedan dibujadas en la línea de tiempo, con las miniaturas de lo que va a ver el diseñador
  ▼  "Ejecutar": el diseñador recibe imágenes (los cuadros elegidos) + la transcripción por segundo con sus cabezales
```

- **Vos decidís cuántas animaciones**: el número que ponés es lo que se le pide al agente (de 1 a 6). Si en el video de verdad no hay tantos momentos con habla que valgan la pena, devuelve menos y el aviso lo dice («pediste 5; el agente solo encontró 3»).
- **Quién elige los momentos**: el mismo modelo del experimento (el modelo A en Motion Design; el modelo único de Context Lab), con el contexto y las instrucciones del pedido y la transcripción. Es una llamada de texto (no ve imágenes: pide los segundos y después se los recortan). Su costo se muestra al terminar y queda en el experimento (`planner`), aparte del costo de cada ejecución.
- **Plan de herramientas por zona**: el agente también dice, para cada zona, qué herramientas del diseñador piensa usar y **en qué segundo exacto** (buscar referencias, generar imagen, generar sonido, generar video IA), solo entre las que existen y no están apagadas (en Context Lab, las que alguna variante tiene encendidas). Se ve de dos formas: **íconos sobre la línea de tiempo**, en su segundo (pasá el cursor para leer la nota), y una **lista en la tarjeta de cada zona** con la hora (clic = ir a ese momento del video) y la nota; cada uso se puede quitar con ×. El plan viaja en el pedido como «Plan del editor para esta zona» (una sugerencia, no una obligación) y cada ejecución solo recibe los usos de las herramientas que tiene encendidas. Las herramientas obligatorias se le piden al agente como «al menos una zona la usa».
- **Las zonas son tuyas después**: se pueden mover (los cuadros elegidos se mueven con la zona), cambiar de largo, quitar, o pasar a Manual y sumar más. La frase de cada zona queda en su «¿Qué pasa en este clip?» y se puede editar: es el «Pedido» que ve el diseñador para esa zona.
- **Reglas del planificador** ([src/lab/plan.js](src/lab/plan.js)): zonas de 1.5 a 8 s, dentro del video y sin superponerse; el servidor ordena y corrige lo que se pase (acorta, estira, descarta superposiciones, completa a 2 cuadros mínimo y recorta a 4 máximo); si la respuesta no es un JSON utilizable, se le pide corregirla una vez.
- **Límite de zonas**: el Laboratorio sube de 3 a **6** zonas por experimento (también en Manual). Cada zona suma sus cuadros al contexto de cada variante/modelo: con 6 zonas × hasta 6 cuadros son más imágenes y más costo.
- **Sin Whisper** (sin `WAVESPEED_API_KEY`) el modo Automático avisa que no puede y queda el Manual. En modo demo, la elección es una heurística sin modelo (los segundos con más habla).
- Ruta: `POST /api/lab/plan`. Pruebas: `node --test test/plan.test.js`.

## Laboratorio · Registro de herramientas (qué hizo el agente)

Debajo del reproductor de cada lado (Motion Design) y de cada variante (Context Lab) hay un registro **abierto y en vivo** de todo lo que el agente hace con las herramientas, en orden:

- **🔎 Buscó referencias**: la consulta y las miniaturas que devolvió (con enlace a la fuente).
- **🖼️ Generó una imagen**: el prompt, de qué imágenes partió y la imagen generada.
- **🔊 Generó un efecto de sonido**: la descripción, la duración y un **reproductor** para escucharlo.
- **🎬 Generó una toma de video**: zona, cuadro de partida, prompt, modelo, y la toma.
- Cada llamada aparece **apenas empieza** («⏳ en curso…») y al terminar muestra ✓ o **✗ falló con el mensaje del error**, cuánto **tardó** y cuánto **costó**. Imagen y sonido dicen si el componente final **los usó en el código**. El encabezado resume cantidades, errores y costo de herramientas.
- Si el modo Automático dejó un plan, arriba se compara **plan del editor vs. lo que hizo** (✓ lo hizo / pendiente / no lo usó), solo con las herramientas que ese lado o variante tenía encendidas.
- Se guarda con el experimento y se restaura al reabrirlo. Los eventos `tool` / `tool_done` del servidor (`src/lab/tools.js`) alimentan el registro. Pruebas: `node --test test/tool-events.test.js`.

## Laboratorio · Nivel de razonamiento por modelo

Motion Design (un selector **por lado**, A y B) y Context Lab (uno **por variante**) dejan fijar cuánto razona el modelo. Como cada modelo acepta sus propios niveles, las opciones **no están escritas a mano**: salen del catálogo de OpenRouter (`/models`), que trae por modelo un objeto `reasoning` con `supported_efforts`, `default_effort`, `default_enabled` y `mandatory`.

- **Qué ofrece el selector**: *Por defecto del modelo* (con su nivel entre paréntesis), los niveles que ese modelo acepta (de `minimal`/`low` a `xhigh`/`max`, según el modelo) y *Apagado* solo si el modelo no exige razonar. Ej.: Claude Opus 5.5 → bajo … máximo, siempre razona; Gemini 3.8 Flash → bajo, medio, alto; DeepSeek V4 Flash → bajo, alto, máximo y apagado. Un modelo sin razonamiento ajustable deja el selector deshabilitado, y uno escrito a mano que no está en el catálogo ofrece bajo/medio/alto y se prueba tal cual. Debajo del selector se lee qué acepta el modelo elegido.
- **Al cambiar de modelo** el selector se rearma; si el nivel que tenías no existe en el nuevo modelo, vuelve a *por defecto*.
- **Qué pasa en el servidor** ([src/lab/reasoning.js](src/lab/reasoning.js)): antes de llamar al modelo se resuelve el nivel con lo que ese modelo acepta. Si pediste uno que no acepta, se usa el **más cercano** (a igual distancia, el más bajo: gasta menos) y la salida del agente lo avisa; si pediste apagar un modelo que siempre razona, o fijar nivel en uno que no expone niveles, se usa el suyo. Así no hay errores 400 de OpenRouter por un nivel no soportado. Sin catálogo (sin red) el nivel se manda tal cual.
- **Historial**: el nivel pedido queda en cada ejecución, aparece en la tabla de comparación y el historial por modelo separa el mismo modelo según su nivel (`modelo · razonamiento alto`), para comparar niveles entre sí. Los registros viejos no cambian.
- Pruebas: `node --test test/reasoning.test.js`.

## Laboratorio · Habla del video (Whisper)

Motion Design y Context Lab pueden recibir **lo que dice el video**, con su momento exacto, para que el agente decida *cuándo* entra cada animación (un título cuando se nombra eso, no antes ni mucho después).

```
clip → [Transcribir con Whisper] → POST /api/lab/transcribe (el archivo tal cual)
     → WaveSpeed wavespeed-ai/openai-whisper-with-video (enable_timestamps: true, task: transcribe, language: auto)
     → palabras con start/end → CABEZALES de 1 segundo → viajan en cada ejecución → sección «Habla del video» del pedido
```

- **Cabezal** = una línea por segundo del video con las palabras que *empiezan* a decirse en ese segundo. Cada línea trae el cuadro absoluto (30 fps, los mismos de las zonas), las zonas que toca y, si la primera palabra arranca tarde, `habla desde el cuadro N`. Los silencios seguidos se juntan en una línea. Ej.: `0:01 · cuadro 30 (habla desde el cuadro 36) · [C1] · Pixar, Nemo`.
- **Dónde**: panel «Habla del video» al final del brief de cada laboratorio. Se transcribe una vez por clip (cuesta ≈ US$ 0.002 por segundo con tiempos por palabra; el panel muestra el costo), se puede revisar la lista, desactivar con «Usar en el pedido» o quitar. Si cambiás de clip, se descarta. Se guarda con el experimento y se restaura al reabrirlo.
- **Context Lab**: la transcripción es del pedido base y **cada variante decide si la recibe** («Recibe el habla del video»), así se compara *con* y *sin* habla como cualquier otra perilla de contexto. Cuenta en los tokens de contexto inicial.
- **Formato de Whisper** (medido con una llamada real; la documentación de WaveSpeed no lo describe): `outputs[0] = { duration, language, text, srt, text_details: [{ start, end, text, words: [{ word, start, end, probability }] }] }`, tiempos en segundos. El parser, con ese caso real como fixture, está en [src/lab/transcript.js](src/lab/transcript.js).
- **Límites**: Whisper toma como máximo 10 minutos (lo demás se recorta y el panel lo avisa); el servidor acepta hasta 300 MB por video. Sin `WAVESPEED_API_KEY` el panel se oculta; en modo demo devuelve un guion de ejemplo gratis.
- **Variables**: `LAB_WHISPER_MODEL` (por defecto `wavespeed-ai/openai-whisper-with-video`) y `LAB_WHISPER_COST_PER_SECOND` (por defecto `0.002`).
- Pruebas: `node --test test/transcript.test.js`.

## Laboratorio · Cinematic Videos

En `/#laboratorio` se elige la carpeta. `/#laboratorio/motion-design` conserva el laboratorio de animación; `/#laboratorio/cinematic-videos` compara generación de video.

- Elegí un LLM de OpenRouter para conversar con el historial completo y las imágenes actuales. **Preparar prompt final** usa las decisiones de esa conversación; también podés elegir **Ya tengo el prompt** y pegarlo directamente.
- Adjuntá hasta diez imágenes y un audio opcional (archivos o URLs HTTPS). Las imágenes se usan como referencias de sujeto/estilo/escena, o como un primer cuadro explícito. Estos modos no se intercambian automáticamente.
- Seleccioná entre uno y cuatro generadores e indicá OpenRouter o WaveSpeed en cada uno. El prompt, la duración, la resolución, la proporción, todas las referencias y el pedido de sonido se congelan al enviar. Antes de generar se muestra qué modelos son compatibles. Un modelo incompatible se omite con su motivo; nunca se eliminan referencias ni se cambian parámetros para hacerlo funcionar.
- Compará los videos, descargalos y evaluá aprobación/rechazo, calidad, fidelidad, opinión y ganador/empate. El historial muestra puntajes, tiempos, victorias y costos conocidos por modelo **y proveedor**. Los costos que el proveedor no devuelve se muestran como **No informado**, no como cero. El modo demo identifica los resultados como simulados y no genera videos.
- OpenRouter usa su API asincrónica `POST /api/v1/videos`, consulta del trabajo y descarga autenticada del contenido. El catálogo se obtiene de `/videos/models` y `/models?output_modalities=video`. WaveSpeed reutiliza el cliente existente de subida/generación/consulta; sus capacidades se leen del schema publicado en `/api/v3/models`.
- Los archivos locales se suben con WaveSpeed para que ambos proveedores reciban URLs del mismo material. Con solo la clave de OpenRouter, usá URLs HTTPS para referencias. Con solo la clave de WaveSpeed, podés usar un prompt final sin conversar. Las claves permanecen en el servidor.
- Los pedidos, identificadores de proveedor y resultados se guardan en `runs/cinematic-videos/`; los videos, en `runs/media/`. Continúan al cerrar la pestaña. Recargar o reabrir consulta tareas existentes; **Consultar tarea existente** recupera trabajos pendientes sin reenviar la generación. Si un reinicio ocurre antes de guardar el ID del proveedor, se informa la interrupción y no se reenvía el pedido automáticamente.
- Conversación de borrador, historial y evaluaciones usan un namespace propio de localStorage; las referencias usan IndexedDB `lab-cinematic`. No se modifica el almacenamiento de Motion Design. Borrar los datos del navegador elimina las evaluaciones locales; borrar una evaluación no elimina videos del servidor. Se puede exportar el historial a JSON.

Rutas: `GET /api/lab/cinematic/models`, `POST /api/lab/cinematic/chat`, `POST /api/lab/cinematic/preflight`, `POST /api/lab/cinematic/run`, `GET /api/lab/cinematic/job?id=…`, `POST /api/lab/cinematic/recover`.

Documentación de proveedores: [Video de OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/video-generation), [referencias de OpenRouter](https://openrouter.ai/docs/cookbook/video-generation/reference-to-video), [HeyGen Video 1](https://openrouter.ai/heygen/heygen-video-1), [catálogo y schemas de WaveSpeed](https://wavespeed.ai/docs/wavespeed-cli).

Pruebas: `npm test`. Flujo de navegador: `PLAYWRIGHT_MODULE=/ruta/a/playwright/index.mjs node test/browser/cinematic-lab.mjs` (usa un servidor demo y almacenamiento temporal, sin generaciones pagadas).

## Laboratorio · Mesa de agentes

`#laboratorio/mesa-de-agentes`. Cuatro agentes, cada uno con su **nombre, misión/rol, indicaciones y modelo de OpenRouter**, sentados alrededor de una mesa con una **misión final** que también escribís vos. Conversan por turnos y, mientras conversan, **producen de verdad** (imágenes, voces y sonidos en WaveSpeed). Al final no entregan un prompt para copiar y pegar: entregan una **producción por tomas** que se corre parte por parte desde la misma pantalla.

```
Asiento A ─────────── MESA ─────────── Asiento B      soltar en un asiento → privado para ese agente (A1, B2…)
   │   misión final + formato + presupuesto  │         soltar en la mesa     → lo ven los cuatro (M1, M2…)
Asiento D ──────────────────────────── Asiento C
  ▼ "Sentarse y empezar": sorteo → empieza uno al azar y siguen en sentido horario
Ronda 1..10: en su turno cada agente escucha todo lo anterior y elige UNA cosa:
   aportar · responder/corregir a otro · pasar ([PASO]) · y marcar [LISTO] si cree que la misión ya está resuelta
   🛠 y, si le sirve, GENERA (los cuatro tienen las mismas herramientas, máximo 2 piezas por turno, con tope de US$ de la mesa):
      generar_imagen → Nano Banana 2.1 (cuadro de storyboard, personaje, look; puede partir de M1, A2, G3…)
      generar_voz    → ElevenLabs v4 (la línea de un personaje, con [whispers], [laughs]…)
      generar_sonido → ElevenLabs Sound Effects v2 (efecto, ambiente o música, hasta 22 s)
      lo generado queda sobre la mesa como G1, G2…: los demás VEN las imágenes y LEEN cómo es cada audio
   ✋ VOS, en cualquier momento: un mensaje o archivo a toda la mesa, o en privado a un agente
  ▼ se cierra a las 10 rondas, antes por consenso, o cuando tocás "Cerrar y redactar entrega"
Relator → ENTREGA DE PRODUCCIÓN (JSON validado): tomas S1, S2… de 2 a 6 s, cada una con
   cuadro · voz · sonido · video (+ música para toda la pieza); cada parte con su DUEÑO (un agente) y su especificación exacta
  ▼ cada parte es una tarjeta:
   ▶ RUN         → corre exactamente esa especificación (imagen/voz/sonido al instante)
   ▶ RUN · video → abre la APROBACIÓN: Wan 3.0 Prime (WaveSpeed) o HeyGen Video 1 (OpenRouter), 480p, ≤ 6 s,
                   arrancando del cuadro de la toma, con el costo estimado. Sin tu aprobación no se genera ningún video.
   💬 feedback   → le hablás al dueño de esa parte aunque la mesa haya terminado; si cambia algo, queda una versión nueva (‹ v2/3 ›)
   ▶ Ver la película → las tomas en orden, con su voz y su sonido encima, la música de fondo y la línea como subtítulo
```

- **Herramientas** (`src/table/tools.js`, `src/table/media.js`): las descripciones son el manual que lee cada modelo (cómo escribir un prompt de cuadro, cómo dirigir una voz con etiquetas, cómo describir un sonido) e incluyen el costo estimado. El turno corre un bucle de *tool calling* (hasta 3 idas y vueltas; la última con `tool_choice: none`): el agente pide una pieza, la ve (si es imagen) y recién después habla. Si un modelo no acepta herramientas en OpenRouter, ese turno sigue sin generar y la pantalla lo avisa. Sin `WAVESPEED_API_KEY` (o con la casilla apagada) los agentes no generan, pero la entrega igual sale por tomas.
- **Presupuesto**: lo fijás en la mesa (por defecto US$ 1.50; se puede subir durante la mesa). Cada pieza descuenta su costo **estimado** (WaveSpeed no informa el costo real por tarea; los valores se ajustan con `TABLE_*_COST`). Lo que se corre con RUN no sale de ese presupuesto: lo aprobás vos al tocar.
- **Qué ven los agentes de lo generado**: las 6 imágenes generadas más recientes van adjuntas en cada turno; las voces y los sonidos, como una línea con su texto, voz y descripción (los modelos de la mesa no los escuchan).
- **La entrega** (`src/table/delivery.js`): el relator devuelve JSON con forma fija; el servidor lo valida (duraciones de 2 a 6 s, hasta 12 tomas, dueños A–D, todas las tomas con cuadro y video) y, si viene roto, le pide una corrección. `base`: si una parte ya se generó en la mesa (G2…), se usa esa pieza real (su especificación manda sobre lo que copie el relator) y no se vuelve a pagar.
- **Feedback por parte**: `POST /api/lab/table/turn` con `kind: 'part'`. Responde el dueño, con su misión, la conversación de la mesa, la entrega vigente, el hilo con vos y (si es un cuadro) la imagen actual. Devuelve su respuesta y, si cambia algo, la parte completa revisada.
- **Video** (`POST /api/lab/table/video`, `GET /api/lab/table/video?id=`, `POST /api/lab/table/video/recover`): usa las mismas tareas persistentes que Cinematic Videos (`src/cinematic/jobs.js`, en `runs/table-videos/`): el ID del proveedor se guarda apenas llega, así que recargar la página o reiniciar el servidor no corta ni vuelve a cobrar. Se verifica contra el catálogo del proveedor (duración, 480p, formato, primer cuadro) y, si el modelo no lo admite, no se envía. Con HeyGen, si el catálogo dice que acepta audio de referencia, se puede sincronizar con la voz de la toma.
- **La película** (`public/table-player.js`): vista previa en el navegador, sin exportar. Si una toma tiene video se ve el video; si solo tiene cuadro, el cuadro con un movimiento lento; cada toma dura lo que dice la entrega o lo que dure su voz.
- **La sala** (`public/table-scene.js`): la mesa se ve como una sala isométrica donde cada lámpara es un agente, y cada objeto significa algo:
  - **Luz**: se enciende la lámpara de quien habla (titila mientras piensa, antes de la primera palabra); las demás quedan tenues y **giran la cabeza hacia quien habla**. Si pasó, se apaga y baja la cabeza; si dijo [LISTO], queda con luz suave. Con la mesa trabajando, la sala baja su luz.
  - **Nubes**: sobre cada lámpara, lo que está diciendo en vivo (o lo último que dijo). Tocarla lleva al mensaje en la conversación. Antes de empezar, muestra su misión, o invita a configurarlo.
  - **Mesa**: tocarla agrega archivos para los cuatro; soltarlos encima, lo mismo. Soltarlos sobre una lámpara (o su cartel) los deja **privados** para ese agente. Los archivos, tus mensajes y **lo que generan los agentes** (G1, G2…, con el punto de color de quien lo generó) quedan como papeles sobre la mesa; tocarlos los muestra (o los hace sonar).
  - **Hoja del centro**: la misión final. Se ilumina cuando el relator escribe y se sella al terminar; tocarla abre la entrega.
  - **Ficha de turno**: nace en el centro con el sorteo y se desliza hasta quien habla o habla después. **Pila de hojas** junto a cada lámpara: cuántos aportes hizo (tocarla lleva al último).
  - **Carteles**: nombre y estado de cada agente; tocarlos (o la lámpara) lleva a su asiento para configurarlo o hablarle en privado.
- **Lo que ve cada agente**: el registro de la mesa, sus propios mensajes y archivos privados, lo generado, y nada de lo privado de los demás (tampoco puede usar como referencia una imagen privada de otro). El relator ve solo lo público. El servidor arma esa vista en cada turno (`src/table/prompts.js`); las reglas de rondas, turnos, consenso y la producción (versiones, costos) son puras y compartidas con el navegador (`public/table-core.js`).
- **Archivos**: imágenes (se reducen a 1280 px), texto (`.md`, `.txt`, `.csv`, `.json`…, hasta 60.000 caracteres) y PDF (hasta 12 MB). Hasta 40 por mesa; cada agente recibe las 16 imágenes más recientes que le corresponden. Lo generado se guarda en `runs/media/` y se sirve en `/media/…`.
- **Turnos sin estado**: cada turno es un `POST /api/lab/table/turn` con el registro completo (respuesta NDJSON en streaming), así se puede pausar, cortar un turno, reintentar uno que falló o intervenir entre dos turnos cualquiera. Una pieza generada en un turno que después falla queda en la mesa (ya se pagó).
- **Guardado**: las mesas viven en este navegador (localStorage + IndexedDB para los archivos), con historial, costo por turno, por pieza y total. "Usar sus agentes en una mesa nueva" reutiliza el elenco, el formato y el presupuesto. Las mesas cerradas antes de la entrega por tomas pueden pedirla de nuevo con la misma conversación.
- **Demo** (`MOCK=1` o sin `OPENROUTER_API_KEY`): respuestas simuladas; en la ronda 1 cada agente genera una pieza de demo (imágenes SVG y audios WAV sintéticos, sin costo), en la ronda 2 un agente pasa y en la 3 todos dan la misión por resuelta; la entrega trae 3 tomas, RUN y el feedback funcionan, y el video de demo no genera archivo (en la película se ve el cuadro animado).
- Prueba de navegador: `PLAYWRIGHT_MODULE=… node test/browser/agent-table.mjs`.

## Cómo correrlo

Requiere Node 22+. Las dependencias son solo para el Laboratorio (Remotion, React y esbuild).

```bash
npm install
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

- **Formato original**: Estudio conserva la proporción del video en la vista previa y la exportación (horizontal, vertical, cuadrado u otra). Las tomas generadas con otra proporción se muestran completas, con bandas si hace falta, sin recorte automático.
- **El criterio de gusto** que leen los dos agentes está en [src/MOTION_DESIGN.md](src/MOTION_DESIGN.md): mirar antes de diseñar, una idea por clip, estructura entrada/sostén/salida, easing, tipografía cinética, color, composición en el formato original, coherencia entre clips, qué evitar. Editalo para cambiar cómo diseña el equipo.
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
| `src/lab/harness.js` | Laboratorio: el harness compartido (contrato + Remotion Agent Skills) y el pedido idéntico para los dos modelos |
| `src/lab/runtime.js` | Laboratorio: compila y valida el TSX de cada agente (esbuild) y empaqueta React + Remotion para el iframe |
| `src/lab/pipeline.js` / `src/lab/routes.js` | Laboratorio: una ejecución de un agente con corrección automática; `POST /api/lab/run`, `GET /api/lab/models`, `GET /api/lab/frame.html` |
| `src/engines/` | Motores de animación (Remotion o el propio en canvas): compilar, reproducir en el iframe y renderizar; `GET /api/lab/frame.html?engine=<id>` |
| `src/lab/tools.js` | Laboratorio: herramientas de los agentes (búsqueda en SerpAPI, imágenes con nano-banana) |
| `src/lab/frame.js` | Laboratorio: dentro del iframe aislado, monta el `<Player>` de Remotion y hace la prueba de humo |
| `src/table/prompts.js` / `src/table/routes.js` | Mesa de agentes: qué ve cada agente, el turno con herramientas, la entrega por tomas, el feedback por parte, RUN y video |
| `src/table/media.js` / `src/table/tools.js` | Mesa de agentes: imagen (Nano Banana 2.1), voz (ElevenLabs v4) y sonido (Sound Effects v2) en WaveSpeed, y las herramientas de cada turno con presupuesto |
| `src/table/delivery.js` / `src/table/mock.js` | Mesa de agentes: forma y validación de la entrega de producción; modelos simulados del demo |
| `public/table.js` / `public/table-core.js` / `public/table-scene.js` | Mesa de agentes: la pestaña, las reglas puras (rondas, producción, costos) y la sala |
| `public/table-delivery.js` / `public/table-player.js` | Mesa de agentes: las tarjetas de la entrega (RUN, aprobación de video, feedback, versiones) y la película |
| `public/lab.js` / `public/lab-stats.js` / `public/lab-store.js` | Laboratorio: la pestaña, las métricas y el historial (localStorage + IndexedDB) |
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
| `TABLE_IMAGE_MODEL` / `TABLE_IMAGE_EDIT_MODEL` | `google/nano-banana-2.1/text-to-image` / `…/edit` | Mesa de agentes: imágenes (sin / con referencias de la mesa). |
| `TABLE_VOICE_MODEL` / `TABLE_SOUND_MODEL` | `elevenlabs/eleven-v4` / `elevenlabs/sound-effects-v2` | Mesa de agentes: voces y sonidos (los campos se adaptan al schema publicado en WaveSpeed). |
| `TABLE_WAN_MODEL` / `TABLE_HEYGEN_MODEL` | `alibaba/wan-3.0-prime/image-to-video` / `heygen/heygen-video-1` | Mesa de agentes: video de cada toma (WaveSpeed / OpenRouter), 480p, hasta 6 s. |
| `TABLE_IMAGE_COST` / `TABLE_IMAGE_REFERENCE_COST` / `TABLE_VOICE_COST_PER_1K` / `TABLE_SOUND_COST` / `TABLE_VIDEO_COST_PER_SECOND` | `0.04` / `0.002` / `0.10` / `0.03` / `0.075` | Mesa de agentes: costos **estimados** en US$ (presupuesto de la mesa y estimaciones de RUN). Ajustalos a tu tabla de WaveSpeed. |

Cualquier variable de modelo acepta una **lista separada por comas**: si el primero no llega a responder
(saturado, sin cupo, inexistente), el paso sigue con el siguiente y la interfaz lo avisa. Antes de eso,
cada llamada reintenta sola los errores pasajeros, respetando el `Retry-After` del proveedor.
