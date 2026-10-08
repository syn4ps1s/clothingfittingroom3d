import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import type { DirectionalLight } from 'three';
import { ROOM } from './layout';
import type { QualityConfig } from './quality';
import { SUN_DIR, WINDOW_CENTER } from './WindowSet';

/**
 * Iluminación del atelier: sol bajo de atardecer entrando por el ventanal (con sombras de los parteluces),
 * relleno cálido, y un entorno PROCEDURAL (lightformers → PMREM) para los reflejos del latón. Sin HDRI externo.
 */
export function Lighting({ q }: { q: QualityConfig }) {
  const sun = useRef<DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  const distance = 14;
  const pos: [number, number, number] = [
    WINDOW_CENTER[0] - SUN_DIR[0] * distance,
    WINDOW_CENTER[1] - SUN_DIR[1] * distance,
    WINDOW_CENTER[2] - SUN_DIR[2] * distance,
  ];

  useEffect(() => {
    const light = sun.current;
    if (!light) return undefined;
    light.target.position.set(WINDOW_CENTER[0] + SUN_DIR[0] * 6, 0.2, WINDOW_CENTER[2] + SUN_DIR[2] * 6);
    scene.add(light.target);
    return () => {
      scene.remove(light.target);
    };
  }, [scene]);

  return (
    <>
      <hemisphereLight args={['#ffe2bf', '#4a3320', 0.55]} />
      <directionalLight
        ref={sun}
        position={pos}
        color="#ffb26a"
        intensity={5.2}
        castShadow={q.shadows}
        shadow-mapSize={[q.shadowMap, q.shadowMap]}
        shadow-camera-left={-7}
        shadow-camera-right={7}
        shadow-camera-top={7}
        shadow-camera-bottom={-7}
        shadow-camera-near={2}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
        shadow-normalBias={0.025}
        shadow-radius={5}
      />
      {/* Relleno frontal suave (softbox sobre el espejo) y calidez junto al perchero */}
      <pointLight position={[0.4, 3.1, -0.3]} color="#ffd9a6" intensity={22} distance={9} decay={2} />
      <pointLight position={[-2.6, 2.7, 0.2]} color="#ffcf94" intensity={12} distance={7} decay={2} />
      <pointLight position={[2.2, 2.4, 1.6]} color="#ffe6c4" intensity={8} distance={7} decay={2} />

      <Environment frames={1} resolution={q.envRes} environmentIntensity={0.7}>
        {/* ventanal: gran fuente cálida al fondo a la derecha */}
        <Lightformer form="rect" intensity={9} color="#ffb067" position={[3.2, 2.2, -5]} scale={[3, 5.4, 1]} />
        {/* rebote del techo */}
        <Lightformer form="rect" intensity={1.5} color="#fff0d6" position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[12, 12, 1]} />
        {/* gran difusor detrás de la cámara: da con qué reflejarse a latón y cristal */}
        <Lightformer form="rect" intensity={2.4} color="#ffe9cb" position={[-1, 2.4, ROOM.frontZ]} rotation-y={Math.PI} scale={[8, 4.5, 1]} />
        <Lightformer form="rect" intensity={1.2} color="#e9d6b8" position={[-6, 1.5, 1]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
        {/* suelo cálido */}
        <Lightformer form="rect" intensity={0.5} color="#b88653" position={[0, -1.5, 0]} rotation-x={-Math.PI / 2} scale={[14, 14, 1]} />
      </Environment>
    </>
  );
}
