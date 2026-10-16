// Motores de animación: lo ÚNICO que cambia entre ellos es cómo se escribe, se compila, se reproduce y se renderiza
// la animación de un agente. El bucle del agente, las herramientas, las zonas, las capas y la interfaz son los mismos.
//
// Contrato de un motor (ver remotion.js y canvas/index.js):
//   id, label, version        identificación (version entra en la firma del harness del historial)
//   fps                       cuadros por segundo de la composición
//   fence                     lenguaje del bloque de código que entrega el agente (```tsx, ```js)
//   words                     cómo se nombran imágenes, sonidos y el reproductor en los textos compartidos del harness
//   extractCode(text)         el código de la respuesta del modelo (lanza si no hay)
//   compile(code, env?)       → { js } listo para el iframe, o lanza un Error con un mensaje pensado para el modelo.
//                             env: { width, height, duration, fps, zones (en cuadros), images: ids, sounds: ids }
//   frameDocument()           → Promise<html> del iframe aislado. Habla el protocolo de src/lab/frame.js
//                             (boot / load / checked / frame / render…), así cualquier página puede usar cualquier motor.
//
// Para sumar un motor: un módulo con ese contrato + una entrada en ENGINES. Para usarlo en otra parte de la app:
// getEngine(id).compile(...) en el servidor y GET /api/lab/frame.html?engine=<id> en el navegador.
import { remotionEngine } from './remotion.js';
import { canvasEngine } from './canvas/index.js';

export const ENGINES = { [remotionEngine.id]: remotionEngine, [canvasEngine.id]: canvasEngine };
export const DEFAULT_ENGINE = remotionEngine.id;
export const ENGINE_IDS = Object.keys(ENGINES);

// Un id desconocido (o vacío) cae en el motor por defecto: los clientes viejos siguen funcionando igual.
export const engineId = (id) => (ENGINES[id] ? id : DEFAULT_ENGINE);
export const getEngine = (id) => ENGINES[engineId(id)];
export const engineList = () => ENGINE_IDS.map((id) => ({ id, label: ENGINES[id].label, version: ENGINES[id].version, fence: ENGINES[id].fence }));
