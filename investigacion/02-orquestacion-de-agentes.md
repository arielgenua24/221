# Investigación 02 — Cómo orquestan agentes los laboratorios de IA

> Objetivo: decidir la arquitectura de la v1 del arnés basándonos en lo que publicaron Anthropic, OpenAI, Cognition y Microsoft, y no en intuición pura.
> Fecha: septiembre 2026.

---

## 1. Qué dice cada laboratorio

### Anthropic — *Building effective agents* (dic. 2024)
Distingue **flujos de trabajo** (caminos predefinidos por código) de **agentes** (el modelo decide sus pasos). Patrones:

| Patrón | Qué es | Cuándo usarlo |
|---|---|---|
| Encadenamiento de prompts | La salida de un paso es la entrada del siguiente, con chequeos entre medio | Tareas que se descomponen en pasos fijos |
| Enrutamiento | Clasifica la entrada y la manda a un camino especializado | Entradas de tipos muy distintos |
| Paralelización | Subtareas independientes en paralelo (*sectioning*) o la misma tarea varias veces (*voting*) | Velocidad o más diversidad/confianza |
| Orquestador–trabajadores | Un LLM central descompone la tarea y delega dinámicamente | Subtareas que no se pueden prever |
| Evaluador–optimizador | Un LLM genera, otro critica con criterios claros | Cuando hay criterios de evaluación explícitos |

Principios: **empezar simple**, agregar complejidad solo si mejora resultados medibles, **mostrar la planificación** (transparencia) y diseñar con cuidado la interfaz entre agentes.

### Anthropic — *How we built our multi-agent research system* (jun. 2025)
- Arquitectura **orquestador–trabajadores**: un agente líder (Opus) planifica y lanza **3–5 subagentes en paralelo** (Sonnet), cada uno con su propio contexto; el líder sintetiza y decide si hace falta más investigación.
- Resultado: **+90,2%** frente a un solo agente en su evaluación interna de investigación.
- **El uso de tokens explica el 80% de la varianza** en rendimiento. Los agentes usan ~4× los tokens de un chat y los multiagente ~15×. Es decir: el multiagente sirve cuando la tarea **vale** ese costo y **se puede paralelizar**.
- Lecciones de *prompting* del orquestador:
  1. **Delegar bien**: cada subagente necesita objetivo, formato de salida, herramientas y **límites** claros; sin eso duplican trabajo o dejan huecos.
  2. **Escalar el esfuerzo** a la complejidad (reglas explícitas de cuántos subagentes lanzar).
  3. **De lo amplio a lo específico**.
- Evaluación: empezar con **~20 casos de prueba** (los cambios grandes se notan con pocos), LLM-juez con rúbrica 0–1, y **revisión humana** (encontró sesgos que el juez no veía).

### OpenAI — *A practical guide to building agents* (2025) y Agents SDK
- **Maximizar primero un solo agente**; dividir en varios solo cuando la lógica o las herramientas se vuelven inmanejables.
- Dos patrones multiagente:
  - **Manager** (agentes como herramientas): un agente central es dueño del flujo y del contacto con el usuario; llama a especialistas y sintetiza.
  - **Descentralizado** (*handoffs*): un agente le transfiere el control a otro.
- Recomiendan el **manager** cuando se quiere que un solo agente controle la ejecución y hable con el usuario.

### Cognition — *Don't Build Multi-Agents* (jun. 2025) y su revisión posterior
- Crítica central: **partir el contexto entre agentes crea sistemas frágiles**; cada subagente toma decisiones implícitas que los otros no ven, y el resultado final queda incoherente.
- Principios de **ingeniería de contexto**: compartir el contexto completo (no solo el mensaje de la tarea) y reconocer que **las acciones llevan decisiones implícitas**.
- Lo que sí les funciona después: **varios agentes aportan inteligencia (leer, investigar, criticar), pero la escritura queda en un único hilo** (*single writer*).

### Microsoft — Magentic-One (nov. 2024)
- Un **Orquestador** mantiene dos registros:
  - **Task Ledger**: hechos, supuestos y plan.
  - **Progress Ledger**: en cada paso reflexiona si hay progreso, a quién asignar la siguiente subtarea y si hay que replanificar.
- Si no hay progreso durante varios pasos, rehace el plan.

---

## 2. Dónde coinciden (y dónde discuten)

| Tema | Consenso |
|---|---|
| Simplicidad | Todos: empezar con lo mínimo y medir. |
| Quién decide | Un **único dueño** del resultado final y de la conversación con el humano (manager de OpenAI, *single writer* de Cognition, orquestador de Anthropic y Microsoft). |
| Paralelismo | Útil para **leer/investigar/criticar** (tareas independientes), riesgoso para **escribir/decidir** en paralelo. |
| Contexto | Los trabajadores necesitan **contexto compartido completo** (Cognition) y **encargos precisos con límites** (Anthropic). Un *ledger* compartido (Microsoft) resuelve ambas cosas. |
| Evaluación | Separar al que genera del que critica; rúbrica explícita; humano en el circuito. |

La "pelea" Anthropic vs. Cognition es en realidad la misma conclusión desde dos lados: **multiagente para investigar en paralelo sí; múltiples escritores con contexto fragmentado no**.

---

## 3. Decisiones para la v1 del arnés

| Decisión | Por qué (fuente) |
|---|---|
| **Flujo de trabajo fijo en 5 etapas** con decisiones del orquestador dentro de cada etapa (no un agente 100% autónomo) | Empezar simple; la tarea tiene pasos conocidos (Anthropic, OpenAI) |
| **Orquestador = único escritor** (Opus 5.5): brief, ideas y selección final | *Single writer* (Cognition), patrón manager (OpenAI) |
| **Ledger compartido**: el brief estructurado del orquestador se pasa **completo** a cada subagente | Task Ledger (Microsoft) + contexto compartido (Cognition) |
| **3 investigadores en paralelo** (Muse Spark), cada uno con objetivo, preguntas, formato de salida y límites distintos | Orquestador–trabajadores + delegación precisa (Anthropic) |
| **Crítico con un modelo distinto al generador** (Muse critica lo que escribió Opus) con rúbrica explícita | Evaluador–optimizador; separar crítica de generación reduce la homogeneización (investigación 01, §7) |
| **Divergir y después converger**: 8 conceptos distintos → crítica → 4 finales | *Voting*/diversidad; matriz de 5 ejes (investigación 01, §3) |
| **Transparencia**: el humano ve en vivo el razonamiento de cada agente | "Mostrar la planificación" (Anthropic) |
| **Guardar cada ejecución** (entradas, salidas de cada agente, costos) | Base para evaluar con ~20 casos reales (Anthropic) |

### Flujo v1

```
Humano: fotos + texto
   │
   ▼
[1] Orquestador (Opus 5.5, con visión) ── Brief/ledger + plan de 3 investigaciones
   │
   ├──► [2a] Investigador (Muse) — audiencia y deseos
   ├──► [2b] Investigador (Muse) — ángulos y formatos del rubro   (en paralelo)
   └──► [2c] Investigador (Muse) — hooks y tendencias
   │
   ▼
[3] Orquestador — 8 conceptos distintos (recorre la matriz Función×Ángulo×Formato×Consciencia×Emoción)
   │
   ▼
[4] Crítico (Muse) — rúbrica: claridad, hook, cumple la promesa, compartible, específico de la marca, producible sin filmar, riesgo
   │
   ▼
[5] Orquestador — elige y mejora 4 ideas diversas → título + subtítulo
```

### Qué queda fuera de la v1 (a propósito)
- Generación de imágenes/video (Seedance, etc.): v2, cuando el cerebro estratégico funcione.
- Biblia de marca persistente por cliente: v2 (en v1 el brief la infiere de las fotos).
- Bucle de replanificación del orquestador (Progress Ledger completo): cuando haya evaluación que demuestre que hace falta.

---

## Fuentes
- Anthropic — Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic — How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- OpenAI — A practical guide to building agents: https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- OpenAI — Orchestration and handoffs: https://developers.openai.com/api/docs/guides/agents/orchestration
- Cognition — Don't Build Multi-Agents: https://cognition.com/blog/dont-build-multi-agents · Multi-Agents: What's Actually Working: https://x.com/walden_yan/article/2047054401341370639
- Microsoft Research — Magentic-One: https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
- Muse Spark 1.3 Contributor (condiciones de datos): https://openrouter.ai/meta/muse-spark-1.3-contributor · https://llmgateway.io/models/muse-spark-1.3-contributor
