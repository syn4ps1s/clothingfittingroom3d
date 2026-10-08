import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  Vector3,
  type BufferGeometry,
} from 'three';
import { ROOM, WINDOW } from './layout';
import { mergeBoxes, type BoxSpec } from './geometryUtils';
import { windowPath } from './Room';
import { makeSunsetSky } from './textures/atelierTextures';

/** Dirección en la que viaja la luz del sol (de la ventana hacia la sala), unitaria. */
export const SUN_DIR: readonly [number, number, number] = (() => {
  const v: [number, number, number] = [-0.34, -0.4, 0.85];
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

export const WINDOW_CENTER: readonly [number, number, number] = [WINDOW.x, (WINDOW.bottom + WINDOW.top) / 2, ROOM.backZ];

/** Ventanal arqueado: marco de hierro, parteluces (que dibujan su sombra en el suelo), cielo de atardecer y alféizar. */
export function WindowSet() {
  const sky = useMemo(() => makeSunsetSky(), []);
  useEffect(() => () => sky.dispose(), [sky]);

  const frame = useMemo<BufferGeometry>(() => {
    const outer = new Shape();
    const inset = -0.07; // el marco crece hacia fuera del hueco
    windowPath(outer, inset);
    const hole = new Path();
    windowPath(hole);
    outer.holes.push(hole);
    return new ExtrudeGeometry(outer, { depth: 0.14, bevelEnabled: false, curveSegments: 28 });
  }, []);
  const bars = useMemo<BufferGeometry>(() => {
    const boxes: BoxSpec[] = [];
    const w = WINDOW.width;
    const springY = WINDOW.top - w / 2;
    const t = 0.036;
    const z = 0;
    // vertical central + 2 travesaños
    boxes.push({ pos: [WINDOW.x, (WINDOW.bottom + springY) / 2 + 0.2, z], size: [t, springY - WINDOW.bottom + 0.4, 0.05] });
    for (const y of [WINDOW.bottom + 0.72, WINDOW.bottom + 1.45]) {
      boxes.push({ pos: [WINDOW.x, y, z], size: [w, t, 0.05] });
    }
    // abanico del arco: 3 radios aproximados con cajas giradas se hacen aparte (ver más abajo)
    return mergeBoxes(boxes);
  }, []);

  const springY = WINDOW.top - WINDOW.width / 2;
  const fan = [-0.9, -0.45, 0, 0.45, 0.9];
  return (
    <group>
      <mesh geometry={frame} position={[0, 0, ROOM.backZ - 0.1]} castShadow receiveShadow>
        <meshStandardMaterial color="#1c1814" roughness={0.45} metalness={0.55} />
      </mesh>
      <mesh geometry={bars} position={[0, 0, ROOM.backZ - 0.09]} castShadow>
        <meshStandardMaterial color="#1c1814" roughness={0.45} metalness={0.55} />
      </mesh>
      {fan.map((a) => (
        <mesh
          key={a}
          position={[WINDOW.x + Math.sin(a) * (WINDOW.width / 4), springY + Math.cos(a) * (WINDOW.width / 4), ROOM.backZ - 0.09]}
          rotation-z={-a}
          castShadow
        >
          <boxGeometry args={[0.032, WINDOW.width / 2, 0.05]} />
          <meshStandardMaterial color="#1c1814" roughness={0.45} metalness={0.55} />
        </mesh>
      ))}
      {/* Alféizar */}
      <mesh position={[WINDOW.x, WINDOW.bottom - 0.03, ROOM.backZ + 0.08]} castShadow receiveShadow>
        <boxGeometry args={[WINDOW.width + 0.24, 0.06, 0.3]} />
        <meshStandardMaterial color="#d9cbb0" roughness={0.7} />
      </mesh>
      {/* Cielo: plano emisivo (valores > 1 para que el bloom lo recoja) */}
      <mesh position={[WINDOW.x - 1, 2.6, ROOM.backZ - 5]}>
        <planeGeometry args={[20, 12]} />
        <meshBasicMaterial map={sky} toneMapped={false} color={new Color(1.25, 1.1, 0.95)} side={DoubleSide} />
      </mesh>
    </group>
  );
}

/**
 * Haces de luz volumétricos falsos: láminas aditivas que parten del ventanal en la dirección exacta del sol.
 * Cada lámina contiene el vector del sol y el eje «casi vertical» perpendicular; se desvanecen a lo largo del
 * recorrido y en los bordes, y entre parteluces quedan huecos (columnas de luz).
 */
export function LightShafts({ intensity = 1 }: { intensity?: number }) {
  const { quaternion, columns } = useMemo(() => {
    const a = new Vector3(...SUN_DIR).normalize();
    const up = new Vector3(0, 1, 0);
    const b = up.clone().sub(a.clone().multiplyScalar(up.dot(a))).normalize();
    const c = new Vector3().crossVectors(a, b);
    const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(a, b, c));
    const cols = [-0.66, -0.31, 0.31, 0.66].map((k, i) => ({
      x: WINDOW.x + k * (WINDOW.width / 2),
      i: i % 2 ? 0.8 : 1,
    }));
    return { quaternion: q, columns: cols };
  }, []);
  const length = 7.6;
  const half = new Vector3(...SUN_DIR).multiplyScalar(length / 2);
  return (
    <group>
      {columns.map((col, i) => (
        <mesh
          key={i}
          position={[col.x + half.x, WINDOW_CENTER[1] + half.y, ROOM.backZ + 0.1 + half.z]}
          quaternion={quaternion}
          renderOrder={5}
        >
          <planeGeometry args={[length, 2.9]} />
          <shaderMaterial
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
            side={DoubleSide}
            uniforms={{ uIntensity: { value: 0.2 * intensity * col.i } }}
            vertexShader={`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`}
            fragmentShader={`
              varying vec2 vUv; uniform float uIntensity;
              void main(){
                float along = vUv.x;
                float across = vUv.y;
                float fadeIn = smoothstep(0.0, 0.06, along);
                float fadeOut = 1.0 - smoothstep(0.25, 1.0, along);
                float edge = smoothstep(0.0, 0.28, across) * (1.0 - smoothstep(0.72, 1.0, across));
                float a = uIntensity * fadeIn * fadeOut * edge;
                gl_FragColor = vec4(vec3(1.0, 0.7, 0.38) * a, a);
              }`}
          />
        </mesh>
      ))}
    </group>
  );
}
