import { Canvas } from '@react-three/fiber';
import { JOINT_COUNT } from '@fitroom/shared';

/** Placeholder de la fundación: el agente WORLD lo reemplaza por el mundo 3D completo. */
export function App() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0b0b10' }}>
      <Canvas camera={{ position: [0, 1.4, 3], fov: 50 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 4, 3]} intensity={2} />
        <mesh rotation={[0.4, 0.6, 0]}>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#c9a46c" roughness={0.4} />
        </mesh>
      </Canvas>
      <p style={{ position: 'absolute', top: 12, left: 12, color: '#ddd', font: '14px system-ui' }}>
        Probador 3D · esqueleto de {JOINT_COUNT} articulaciones
      </p>
    </div>
  );
}
