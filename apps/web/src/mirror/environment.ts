import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const cache = new WeakMap<WebGLRenderer, Texture>();

/**
 * Environment procedural (PMREM de una sala simple, sin descargas): reflejos e iluminación difusa
 * suaves para las telas. Un solo mapa por renderer, compartido entre el espejo y las vitrinas.
 */
export function getRoomEnvironment(renderer: WebGLRenderer): Texture {
  const hit = cache.get(renderer);
  if (hit) return hit;
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.035);
  room.dispose();
  pmrem.dispose();
  cache.set(renderer, target.texture);
  return target.texture;
}
