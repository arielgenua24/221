# 221 — Arnés de creación de contenido

Un equipo de subagentes de IA que, a partir de **fotos y una descripción del negocio**, decide qué contenido crear para Instagram/TikTok (orgánico). La v1 entrega **4 ideas de contenido** (título + subtítulo, con hook, desarrollo, caption y cómo producirla sin filmar).

## Cómo correrlo

Requiere Node 22+. No tiene dependencias.

```bash
cp .env.example .env      # poné tu OPENROUTER_API_KEY
npm start                 # http://127.0.0.1:3000
npm run demo              # modo demo: respuestas simuladas, sin API key
npm test
```

Sin `OPENROUTER_API_KEY`, la app arranca en **modo demo** automáticamente.

## Cómo trabaja el equipo (v1)

```
Fotos + texto
  │
  ▼
[1] Orquestador (Opus 5.5, ve las fotos) → brief compartido + plan de 3 investigaciones
  ├─► [2a] Investigador (Muse Spark) ┐
  ├─► [2b] Investigador (Muse Spark) ├─ en paralelo, con búsqueda web
  └─► [2c] Investigador (Muse Spark) ┘
  ▼
[3] Orquestador → 8 conceptos distintos (matriz Función × Ángulo × Formato × Consciencia × Emoción)
  ▼
[4] Crítico (otro modelo) → rúbrica de 7 criterios
  ▼
[5] Orquestador → elige y mejora las 4 mejores
```

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
| `src/server.js` | Servidor HTTP + streaming de eventos (NDJSON) a la UI |
| `public/` | Interfaz |

## Configuración (`.env`)

| Variable | Por defecto | Nota |
|---|---|---|
| `ORCHESTRATOR_MODEL` | `anthropic/claude-opus-5.5` | |
| `RESEARCHER_MODEL` | `meta/muse-spark-1.3-contributor` | La variante *contributor* permite a Meta entrenar con prompts y respuestas. |
| `CRITIC_MODEL` | = investigador | Distinto al orquestador a propósito |
| `RESEARCH_WEB` | `1` | Plugin web de OpenRouter; si falla, sigue sin web |
| `RESEARCHER_VISION` | `0` | Por defecto las fotos solo las ve el orquestador |
