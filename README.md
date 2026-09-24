# 221 — Arnés de creación de contenido

Dos flujos de subagentes de IA:

1. **Ideas de contenido** (`/`): a partir de **fotos y una descripción del negocio**, decide qué contenido crear para Instagram/TikTok (orgánico). Entrega **4 ideas de contenido** (título + subtítulo, con hook, desarrollo, caption y cómo producirla sin filmar).
2. **Edición musical** (`/edicion`): subís una **música** (grabación de voz, MP3, M4A, video con audio…) y tus **videos y fotos**. Un modelo que escucha audio marca dónde cortar y otro decide qué toma va en cada segundo. Resultado: el video montado sobre la música, para ver y exportar.

## Cómo correrlo

Requiere Node 22+. No tiene dependencias.

```bash
cp .env.example .env      # poné tu OPENROUTER_API_KEY
npm start                 # http://127.0.0.1:3000
npm run demo              # modo demo: respuestas simuladas, sin API key
npm test
```

Sin `OPENROUTER_API_KEY`, la app arranca en **modo demo** automáticamente.

## Edición musical (`/edicion`)

```
Música + videos/fotos + (opcional) qué querés transmitir
  │                         (el navegador decodifica el audio y extrae cuadros de cada video)
  ▼
[0] Análisis automático (código) → tempo, beats, compases, golpes, curva de energía
  ▼
[1] Oído (Gemini 3.8 Flash, escucha el audio) → mapa musical: secciones, energía, hit points, ritmo de corte
  ▼
 ✋ VOS: confirmás o corregís el mapa ("el estribillo arranca en 0:45")
  ▼
[2] Editor (Opus 5.5, ve los cuadros y fotos) → qué toma va en cada segundo, con efecto y transición
  ▼
[3] Código → engancha cada corte al golpe más cercano y valida el montaje
  ▼
Reproductor: ves el video sobre la música, elegís 9:16 / 1:1 / 16:9 y lo exportás (MP4 o WebM)
```

- Los videos no se suben al servidor: solo viajan el audio (WAV mono 16 kHz) y algunos cuadros. El render y la exportación se hacen en el navegador (en tiempo real: dejá la pestaña visible).
- Criterio de edición y por qué esta arquitectura: [investigacion/03-edicion-guiada-por-musica.md](investigacion/03-edicion-guiada-por-musica.md).

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
| `src/edit-prompts.js` | Manual de edición guiada por la música + prompts del Oído y del Editor |
| `src/edit-pipeline.js` | Flujo de edición musical |
| `src/timeline.js` | Valida el montaje y engancha los cortes al ritmo |
| `src/server.js` | Servidor HTTP + streaming de eventos (NDJSON) a la UI; `POST /api/run`, `POST /api/edit`, `POST /api/decide` reanuda el flujo pausado |
| `public/` | Interfaz (`edicion.js` + `player.js` para la edición musical) |

## Configuración (`.env`)

| Variable | Por defecto | Nota |
|---|---|---|
| `ORCHESTRATOR_MODEL` | `anthropic/claude-opus-5.5` | |
| `RESEARCHER_MODEL` | `meta/muse-spark-1.3-contributor` | La variante *contributor* permite a Meta entrenar con prompts y respuestas. |
| `CRITIC_MODEL` | = investigador | Distinto al orquestador a propósito |
| `RESEARCH_WEB` | `1` | Plugin web de OpenRouter; si falla, sigue sin web |
| `RESEARCHER_VISION` | `0` | Por defecto las fotos solo las ve el orquestador |
| `EAR_MODEL` | `google/gemini-3.8-flash` | Edición musical: el modelo que escucha. Tiene que aceptar audio. |
| `EDITOR_MODEL` | = orquestador | Edición musical: el que monta. Tiene que aceptar imágenes. |
