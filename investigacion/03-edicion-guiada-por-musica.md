# Investigación 03 — Edición guiada por la música

> Objetivo: definir cómo un equipo de modelos puede escuchar una música (incluso una grabación casera) y cortar videos y fotos sobre ella como lo haría un buen editor de videoclips o reels.
> Fecha: septiembre 2026.

---

## 1. Cómo editan sobre la música los buenos editores

Principios repetidos en la práctica de videoclips, trailers y reels (y que condensamos en `EDIT_PLAYBOOK`, `src/edit-prompts.js`):

| Principio | Qué significa en la práctica |
|---|---|
| La música es el guion | La estructura (intro, estrofa, estribillo, puente, final) decide el ritmo de corte y la intensidad visual. |
| Jerarquía de acentos | No todos los beats valen igual: momentos únicos (drop, entrada de voz, silencio) > inicio de frase (4/8 compases) > "1" del compás > beats fuertes > golpes sueltos. |
| El ritmo de corte sigue a la energía | Partes tranquilas: tomas largas (1-2 compases). Estribillo/drop: cada 1-2 beats. Subidas: acelerar progresivamente. |
| Contraste > velocidad | Cortar en cada beat todo el tema cansa y le quita impacto al clímax. El impacto nace de alternar lento y rápido. |
| Hit points | Los acentos únicos se marcan con la toma más fuerte, un flash o un movimiento. |
| Variedad de escala | No repetir la misma toma seguida; alternar general / medio / detalle. |
| Movimiento acompaña la energía | Zoom lento en lo tranquilo; pulso en lo enérgico; las fotos nunca quietas. |
| Sin pulso claro, cortar en frases | En grabaciones de voz o guitarra sin percusión, forzar una grilla queda mal: se corta en respiraciones, frases y cambios de acorde. |

## 2. Por qué dos modelos (y código en el medio)

| Rol | Modelo por defecto | Por qué |
|---|---|---|
| **Análisis** | Código propio (`src/audio.js`) | Los modelos que escuchan audio razonan muy bien sobre estructura y sensación, pero son imprecisos con los segundos exactos. Un análisis clásico (flujo espectral → tempo por autocorrelación → seguimiento de beats por programación dinámica, Ellis 2007) da una grilla precisa en milisegundos y sin costo. |
| **Oído** | `google/gemini-3.8-flash` | Acepta audio como entrada (también video, imágenes y texto). Escucha el tema entero y produce el mapa musical: secciones, energía, hit points y ritmo de corte. Recibe la grilla automática para ser preciso, pero puede corregirla (tempo doble/mitad, pulso libre). |
| **Editor** | `anthropic/claude-opus-5.5` | Único "escritor" del montaje (mismo principio *single writer* de la investigación 02). Ve cuadros de cada video y las fotos, y decide qué toma va en cada segundo respetando el mapa del Oído. |
| **Validación** | Código (`src/timeline.js`) | Engancha cada corte al golpe más cercano (±0,15 s), garantiza cobertura sin huecos de 0 al final, descarta material inexistente y asegura que el fragmento pedido de cada video exista. |

El humano interviene una vez: después de que el Oído escucha, confirma o corrige el mapa ("el estribillo arranca en 0:45") antes de que se monte.

## 3. Decisiones técnicas

- **El audio se decodifica en el navegador** (Web Audio) y se envía como WAV mono de 16 kHz. Así se acepta cualquier formato que el navegador entienda (MP3, M4A de grabadoras, MP4 con audio, WAV, OGG) sin instalar nada en el servidor. 16 kHz alcanza para el análisis de ritmo y es la resolución a la que los modelos de audio procesan el sonido.
- **Los videos nunca viajan al servidor**: el navegador extrae hasta 4 cuadros por video (con su segundo exacto) y reduce las fotos. El editor elige el segundo de inicio de cada toma mirando esos cuadros.
- **El render también es local**: el reproductor dibuja el montaje en un canvas sincronizado con el audio y lo exporta con `MediaRecorder` (MP4 si el navegador lo soporta, si no WebM). Cada video usa dos elementos (A/B) para que la próxima toma ya esté posicionada al llegar el corte.
- **Todo queda registrado** en `runs/edicion-*.json` (análisis, respuesta cruda de cada modelo, decisión humana, montaje final) para evaluar y mejorar.

## 4. Próximos pasos posibles

1. **Crítico que mira el resultado**: renderizar el video y pasárselo a Gemini (acepta video con audio) para que evalúe si los cortes "se sienten" en el golpe, y devolverle notas al Editor (patrón evaluador–optimizador).
2. **Detección de movimiento en las tomas**: medir en el navegador dónde hay más acción en cada video para ofrecerle al Editor fragmentos candidatos, no solo 4 cuadros.
3. **Texto en pantalla sincronizado** con la letra (el Oído puede transcribir la voz con tiempos).
4. **Render en servidor con FFmpeg** para calidad y velocidad (hoy el export es en tiempo real y depende del navegador).
