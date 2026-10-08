import { EffectComposer, Bloom, Vignette, ToneMapping, SMAA } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';

/** Postproceso MUY sutil: resplandor en los brillos (ventanal, bombillas), viñeta cálida y tonemapping ACES. */
export default function Post({ quality }: { quality: 'medium' | 'high' }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <Bloom intensity={quality === 'high' ? 0.42 : 0.3} luminanceThreshold={0.95} luminanceSmoothing={0.25} mipmapBlur />
      <Vignette offset={0.3} darkness={0.5} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
    </EffectComposer>
  );
}
