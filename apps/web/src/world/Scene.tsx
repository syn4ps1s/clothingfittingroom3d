import { Suspense, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import type { CameraController } from '../contracts';
import { useApp } from '../state/store';
import { CameraRig } from './CameraRig';
import { cameraPoseFor } from './layout';
import { viewStore } from './viewStore';

/** Marcador temporal mientras se construye el atelier. */
export default function Scene(_props: { camera: CameraController }) {
  const quality = useApp((s) => s.settings.quality);
  const initial = cameraPoseFor('welcome', 'wide');
  useEffect(() => {
    viewStore.getState().setSceneStatus('ready');
  }, []);
  return (
    <Canvas
      frameloop="demand"
      dpr={quality === 'low' ? 1 : [1, 1.5]}
      camera={{ fov: initial.fov, near: 0.1, far: 80, position: [...initial.position] }}
    >
      <color attach="background" args={['#241a12']} />
      <ambientLight intensity={1} />
      <mesh position={[0, 1.2, -2.6]}>
        <planeGeometry args={[1.1, 1.95]} />
        <meshStandardMaterial color="#556" />
      </mesh>
      <Suspense fallback={null}>
        <CameraRig />
      </Suspense>
    </Canvas>
  );
}
