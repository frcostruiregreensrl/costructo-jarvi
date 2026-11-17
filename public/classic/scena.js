// Sceglie la scena: 3D (three.js) se è installato, altrimenti il ripiego 2D. Stessa interfaccia per entrambe.
import { createScena2D } from "./scena2d.js";

export async function creaScena(canvas, labelLayer) {
  const vuole2D = new URLSearchParams(location.search).has("2d");
  if (!vuole2D) {
    try {
      const prova = await fetch("/vendor/three/build/three.module.js", { method: "HEAD" });
      if (prova.ok) {
        const { createScene } = await import("./scena3d.js");
        const s = createScene(canvas, labelLayer);
        s.tipo = "3D";
        return s;
      }
    } catch (e) {
      console.warn("[scena] grafica 3D non disponibile, uso il ripiego 2D", e);
      const nuovo = canvas.cloneNode(false); // un canvas già usato da WebGL non può passare al 2D
      canvas.replaceWith(nuovo);
      canvas = nuovo;
    }
  }
  const s = createScena2D(canvas, labelLayer);
  s.tipo = "2D";
  return s;
}
