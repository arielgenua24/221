# MANUAL DE MOTION DESIGN — modo ✨ Intuition

> Este documento es el criterio del equipo. Lo leen el Director de Arte y el Motion Designer antes de cada encargo.
> No es una lista de efectos: es una forma de mirar. Si una decisión no se puede defender con este manual, no va.

---

## 0. La idea en una línea

**El motion design está al servicio del video, no al revés.** El video del humano es la obra: una persona, un lugar, un producto, un momento real. Nuestro trabajo es escribir encima de él con luz y movimiento, como un buen tipógrafo escribe sobre una foto: sabiendo qué no tapar, cuándo callar y cuándo golpear.

Un buen motion se siente **inevitable**: como si el video lo hubiera estado pidiendo. Uno malo se siente **pegado**: un sticker que se mueve.

---

## 1. Antes de diseñar: mirar

Nunca empieces por el efecto. Empezá por los cuadros.

1. **¿Qué pasa en la toma y en qué segundo?** Alguien entra, levanta algo, mira a cámara, la cámara gira, se corta la luz. Anotalo con su segundo: esos son tus puntos de sincronía.
2. **¿Dónde está el sujeto y a dónde se mueve?** Caras, manos, producto: eso no se tapa. El espacio negativo (cielo, pared, piso, mesa) es tu lienzo.
3. **¿Qué luz y qué color tiene?** Cálida, fría, dura, suave, saturada, lavada. La paleta del motion nace de acá (armonía o contraste deliberado, nunca azar).
4. **¿Cuál es la energía de la toma?** Cámara quieta y contemplativa pide motion lento y fino. Cámara en mano y cortes rápidos permiten algo más nervioso.
5. **¿Qué dirección tiene el movimiento de cámara?** Si la cámara panea a la derecha, lo que entra desde la derecha "choca"; lo que acompaña hacia la derecha "fluye". Elegí a propósito.

Si no podés responder estas cinco preguntas, todavía no podés diseñar.

---

## 2. Una idea por clip

Cada clip dura como máximo 5 segundos. En 5 segundos entra **una** idea, bien ejecutada. No tres.

- Una idea = una frase que se puede decir en voz alta: "el precio se escribe solo mientras ella levanta la bolsa", "una línea subraya el horizonte y se convierte en el título", "tres palabras caen al ritmo de los pasos".
- Todo lo demás (líneas, puntos, grano, números) es **acción secundaria**: acompaña a la idea, nunca compite.
- Si el humano pide algo concreto (un texto, un dato, un llamado a la acción), esa es la idea. Tu trabajo es darle forma, no cambiarla.

---

## 3. Tiempo: la estructura de un clip

Un clip de motion tiene tres actos. Todo tiene que **terminar dentro de la duración**: al último cuadro la pantalla del overlay queda limpia (o en un estado final intencional que se funde).

| Acto | Duración típica | Qué pasa |
|---|---|---|
| **Entrada** | 0,4 – 0,9 s | Los elementos llegan. Rápido al principio, suave al final (ease-out). |
| **Sostén** | el resto | Se lee. Pero nunca congelado: una deriva mínima (1–2 % de escala, un par de px de desplazamiento, una línea que se sigue dibujando) mantiene vivo el cuadro. |
| **Salida** | 0,3 – 0,5 s | Se va más rápido de lo que llegó (ease-in). Terminá al menos 0,1 s antes del final. |

**Tiempo de lectura**: una persona lee ~3 palabras por segundo en pantalla, y el ojo necesita ~0,3 s para encontrar el texto. Un titular de 4 palabras necesita estar **quieto y completo** al menos 1,3 s. Si no hay tiempo, usá menos palabras.

**Cascadas (stagger)**: separá los elementos 40–90 ms (letras: 20–40 ms; palabras: 60–120 ms; líneas: 100–180 ms). Menos parece un bloque; más parece lento.

**Sincronía con el video**: si en el segundo 2,1 alguien aplaude, el golpe del motion cae en 2,1 (o 1 cuadro antes: el ojo anticipa). Un evento del video sincronizado vale más que cualquier efecto.

---

## 4. Easing: el alma del movimiento

Nada real se mueve a velocidad constante. El easing es lo que separa el motion profesional del amateur.

- **Entradas → ease-out** (`outCubic`, `outQuart`, `outExpo`): llega rápido y frena. Se siente seguro.
- **Salidas → ease-in** (`inCubic`, `inQuart`): arranca lento y se va. Se siente decidido.
- **Movimientos de un lugar a otro → ease-in-out** (`inOutCubic`, `inOutQuart`).
- **`linear` solo para cosas continuas**: una rotación infinita, un ticker, un scroll de textura, grano.
- **Rebote (`outBack`, `spring`) con moderación**: para algo lúdico o para un único golpe de énfasis. Si todo rebota, el video parece infantil.
- **La curva de la casa**: `bezier(.2, .8, .2, 1)` (salida suave) y `bezier(.7, 0, .84, 0)` (entrada decidida) son una buena base "editorial". Elegí **una familia de curvas y sostenela en los tres clips**: eso solo ya da coherencia.

Regla práctica: si dudás, `outExpo` para entrar y `inQuart` para salir.

---

## 5. Los principios que sí importan en motion graphics

- **Anticipación**: antes de un golpe, un micro-movimiento en contra (un 3 % de retroceso, una línea que se tensa).
- **Overshoot y asentamiento**: lo que llega con fuerza se pasa un poco y vuelve. Sutil: 2–6 %.
- **Acción superpuesta (overlap)**: los elementos no arrancan ni frenan juntos. El título llega, el subrayado 80 ms después, el dato 150 ms después.
- **Follow-through**: cuando algo frena, lo que cuelga de él (una línea, una sombra, un contorno) sigue un poquito más.
- **Jerarquía temporal**: lo más importante llega primero y se va último.
- **Escala y peso**: lo grande se mueve más lento; lo chico, más rápido.
- **Continuidad espacial**: lo que sale por la derecha vuelve por la izquierda; un elemento que se transforma en otro (una línea que se vuelve título) es mejor que dos elementos que se reemplazan.

---

## 6. Tipografía en movimiento

La tipografía es el 80 % del motion para redes. Tratala con respeto.

- **Máximo 2 familias** en todo el video (una display y una de texto, o una sola en dos pesos). Las elige el Director de Arte y valen para los tres clips.
- **Jerarquía por contraste**: tamaño (mínimo 2:1 entre titular y texto), peso (400 vs 800), o familia (serif vs sans). No por color solamente.
- **Tamaños mínimos en celular** (relativos a la ventana, en unidades `u` = 1 % del lado corto):
  - Titular: 8–18 u. Texto secundario: 4–6 u. Nada legible por debajo de 3,5 u.
- **Tracking**: titulares grandes con tracking levemente negativo (`ctx.letterSpacing = '-0.02em'` si existe, o dibujar letra por letra); mayúsculas chicas con tracking positivo (+0.08em a +0.2em).
- **Interlineado** de titulares: 0,9–1,05 del tamaño. De texto: 1,25–1,4.
- **Técnicas de tipografía cinética que funcionan**:
  - **Revelado con máscara**: el texto sube desde una línea invisible (clip rect). El clásico editorial. Impecable con `outExpo`.
  - **Letra por letra** con cascada corta y desplazamiento vertical chico (10–30 % del tamaño).
  - **Palabra por palabra al ritmo** de algo que pasa en el video.
  - **Escala con golpe**: una palabra entra al 115 % y se asienta al 100 %.
  - **Tracking que se cierra**: las letras llegan separadas y se juntan.
  - **Escritura/subrayado**: una línea se dibuja (progreso del trazo) y el texto aparece detrás.
- **Nunca**: texto rotando sin razón, sombras negras duras difusas de 2005, contornos gruesos por defecto, arcoíris, más de 12 palabras en un clip.

---

## 7. Color

- **Paleta de 2 a 4 colores** para todo el video: un color de texto, un acento, y opcionalmente un fondo de placa y un neutro.
- **Sacala del video**: el acento puede ser un color que ya está en la toma (la ropa, el producto, el cielo), elevado. O el complementario, a propósito. Eso hace que el motion "pertenezca".
- **60-30-10**: el video es el 60 %, el overlay neutro el 30 %, el acento el 10 %. El acento se gana su lugar: úsalo en UNA cosa por clip.
- **Legibilidad sobre video**: el video se mueve y cambia de luz. Para asegurar contraste usá una de estas, en este orden de elegancia:
  1. Ubicar el texto sobre una zona pareja de la toma (cielo, pared).
  2. Un velo suave (degradado del borde con 25–45 % de negro/blanco) que no se note como caja.
  3. Una placa sólida con intención (color de la paleta, esquinas coherentes con el sistema).
  4. Sombra muy suave (blur 1,5–3 u, alfa 0,25–0,4). Nunca como único recurso sobre fondos cargados.
- Blanco puro y negro puro son duros: preferí un blanco hueso (#F4F1EA) y un casi negro (#111).

---

## 8. Composición en 9:16 y la ventana

- El humano ubica y redimensiona la **ventana** del overlay por cada clip. Tu diseño vive adentro y **tiene que funcionar en cualquier proporción**: angosta y alta, ancha y baja, cuadrada.
  - Todo relativo: posiciones con `w`/`h`, tamaños con `u`. **Nunca píxeles fijos.**
  - Decidí el layout según `env.aspect` (ej. si `aspect > 1.6`, título en una línea; si no, en dos).
  - Márgenes internos de 5–8 u. Nada pegado al borde de la ventana salvo que sea a propósito (una línea que sangra).
  - Usá `fitText` para que un texto nunca se salga del ancho.
- **Zonas seguras de redes** (en el cuadro completo): arriba ~12 % (nombre de usuario, estado), abajo ~20 % (descripción, música), derecha ~15 % (botones). El Director de Arte ubica la ventana por defecto fuera de esas zonas y fuera de caras.
- **Grilla**: alineá a una grilla simple (márgenes iguales, una columna o dos). La alineación a izquierda es más editorial; el centrado es más "anuncio". Elegí uno y sostenelo en los tres clips.
- **Aire**: el espacio vacío es un elemento. Un título chico con mucho aire se ve más caro que uno enorme que llena todo.

---

## 9. Coherencia entre los tres clips

Los tres clips son **un solo sistema**, como los títulos de una película. El humano tiene que sentir que los hizo la misma persona el mismo día.

Lo que se comparte **siempre**: paleta, tipografías, familia de easing, gramática de entrada/salida (si en el clip 1 el texto sube desde una máscara, en el 2 y el 3 también, o una variación clara de eso), grosor de líneas, radio de esquinas, textura.

Un **motivo recurrente**: un elemento pequeño que aparece en los tres (una línea fina, un punto, un corchete, un número de índice "01 / 02 / 03", un marco). Es la firma.

Lo que **varía**: la idea de cada clip y su intensidad, siguiendo un arco:
- Clip 1 — **presenta**: más contenido, establece el lenguaje.
- Clip 2 — **desarrolla**: lo mismo con una vuelta (más rápido, otra escala, otra composición).
- Clip 3 — **remata**: el momento más fuerte o el más limpio. Suele ser el llamado a la acción o la conclusión.

(El orden de los clips en el video manda: el primero en el tiempo presenta.)

---

## 10. Gusto: qué evitar y qué buscar

**Evitar (lo que delata a un amateur o a una IA):**
- Neón brillante en todo, glow por defecto, degradados arcoíris.
- Todo girando, todo rebotando, todo latiendo.
- Partículas porque sí. Confeti. Estrellitas.
- Texto centrado gigante con sombra negra sobre cualquier cosa.
- Efectos que no terminan (loops que se cortan de golpe al final del clip).
- Muchos elementos entrando a la vez con el mismo easing y la misma duración (parece un PowerPoint).
- Emojis como recurso gráfico principal.
- Tapar la cara o el producto.
- Llenar los 5 segundos de movimiento constante: sin pausas no hay ritmo.

**Buscar:**
- Geometría precisa: líneas de 0,3–0,6 u, alineadas a la grilla.
- Una pausa deliberada antes del golpe.
- Un solo "momento héroe" por clip, sincronizado con algo del video.
- Microdetalle: un número que cuenta, un índice, una marca de registro, grano sutil.
- Contraste de ritmos: algo lento contra algo rápido.
- Referencias con criterio: el diseño suizo (grilla, Helvetica/Inter, aire), los títulos de Saul Bass (formas simples con intención), el motion editorial de Apple (revelados con máscara, easing impecable), la energía de Buck o ManvsMachine (forma que se transforma), el brutalismo tipográfico (Archivo Black/Anton enorme, recortado por el borde).
- **Menos, mejor hecho.** Si dudás entre agregar y quitar, quitá.

---

## 11. Oficio en Canvas 2D (cómo se traduce todo esto a código)

- **Cada cuadro es una función pura de `t`**: `draw(ctx, t, env)` tiene que dibujar exactamente lo mismo cada vez que se la llame con el mismo `t`, en cualquier orden (el humano adelanta, retrocede y exporta). Nada de variables que se acumulan entre cuadros. Nada de `Math.random` (usá `rand(seed)`), nada de `Date`.
- **Organizá el tiempo con `seg`**: `const pIn = ease.outExpo(seg(t, 0.2, 0.9))`, `const pOut = ease.inQuart(seg(t, dur - 0.55, dur - 0.1))`. Declará al principio los "keyframes" como constantes con nombre: se lee como una línea de tiempo.
- **Todo proporcional**: `const { w, h, u } = env`. Tamaños en `u`, posiciones en fracciones de `w` y `h`.
- **Máscaras** para revelados: `ctx.save(); ctx.beginPath(); ctx.rect(x, y, ancho, alto); ctx.clip(); ...; ctx.restore();`.
- **Trazos que se dibujan**: `ctx.setLineDash([largo, largo]); ctx.lineDashOffset = largo * (1 - p);` o dibujá el segmento hasta `lerp(x0, x1, p)`.
- **Texto**: `ctx.font = font(800, 12 * u, env.fonts.display)`, `ctx.textBaseline = 'alphabetic'` (medí con `measureText` para alinear), `ctx.textAlign` según la grilla.
- **Transparencia**: el overlay se compone sobre el video; lo que no dibujás es transparente. No pintes un fondo opaco en toda la ventana salvo que la idea sea una placa.
- **Rendimiento**: cada cuadro debe dibujarse en menos de 8 ms. Nada de loops de miles de elementos (máx. ~300 formas simples), `shadowBlur` con moderación, precalculá en `setup(env, ctx)` lo que no depende de `t` (layout de líneas, posiciones de letras, semillas).
- **Guardá y restaurá el estado** (`save`/`restore`) alrededor de cada elemento que cambie transformaciones, alfa o clip.
- `ctx.globalAlpha` para fundidos; `ctx.globalCompositeOperation = 'destination-out'` para "borrar" con formas (recortes, textos calados).

---

## 12. Checklist antes de entregar

1. ¿Puedo decir la idea del clip en una frase?
2. ¿Está sincronizada con al menos un evento visible del video (con su segundo)?
3. ¿Tapa alguna cara o el producto? (Si sí: moverlo.)
4. ¿Entrada con ease-out, salida con ease-in, y todo termina antes de `dur`?
5. ¿El texto está quieto y completo el tiempo suficiente para leerse?
6. ¿Usa solo la paleta, las tipografías y la gramática del sistema visual?
7. ¿Funciona si la ventana es mucho más ancha o mucho más angosta?
8. ¿Hay un solo momento héroe? ¿Hay al menos una pausa?
9. ¿Es determinista (sin `Math.random`, sin estado acumulado)?
10. ¿Quitaría algo? Si la respuesta es sí, quitalo.
