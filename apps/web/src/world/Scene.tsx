import { Suspense, lazy, useEffect, useMemo } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { ACESFilmicToneMapping, NoToneMapping, PCFShadowMap, SRGBColorSpace } from 'three';
import { REFERENCE_MEASUREMENTS, type GarmentDefinition } from '@fitroom/shared';
import type { CameraController } from '../contracts';
import { tryGarment } from '../app/actions';
import { useRanking } from '../ui/useRanking';
import { appStore, useApp } from '../state/store';
import { getCatalog } from './api/catalog';
import { CameraRig } from './CameraRig';
import { cameraPoseFor } from './layout';
import { Lighting } from './Lighting';
import { MirrorSet } from './MirrorSet';
import { MirrorStageHost } from './MirrorStageHost';
import { Dust, FabricBolts, FramedArt, Pendant, Plant } from './Props';
import { qualityConfig } from './quality';
import { Rack, type RackItem } from './Rack';
import { Room } from './Room';
import { SilhouetteGuide } from './SilhouetteGuide';
import { CuttingTable, type SwatchItem } from './Table';
import { useView, viewStore } from './viewStore';
import { LightShafts, WindowSet } from './WindowSet';

const Post = lazy(() => import('./Post'));

/** Con post-proceso el tonemapping lo hace el compositor; sin él, el renderizador. */
function ToneMappingSwitch({ post }: { post: boolean }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    gl.toneMapping = post ? NoToneMapping : ACESFilmicToneMapping;
    gl.toneMappingExposure = post ? 1 : 0.95;
    invalidate();
  }, [gl, post, invalidate]);
  return null;
}

/** Latido ambiental (~15 fps) para las motas de polvo mientras la escena está en reposo. */
function AmbientTicker({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => invalidate(), 66);
    return () => window.clearInterval(id);
  }, [active, invalidate]);
  return null;
}

/** Cuatro prendas para el perchero: las filtradas por la persona o, antes de medirse, una muestra variada. */
function useRackItems(): RackItem[] {
  const measurements = useApp((s) => s.measurements);
  const ui = useApp((s) => s.catalogUi);
  const ranking = useRanking();
  return useMemo(() => {
    const catalog = getCatalog();
    if (measurements && ranking.length > 0) {
      const list = ranking
        .filter((r) => (ui.category === 'all' || r.garment.category === ui.category))
        .slice(0, 4);
      const picked = list.length > 0 ? list : ranking.slice(0, 4);
      return picked.map((r) => ({ garment: r.garment, size: r.rec.size, variantId: r.garment.variants[0]!.id }));
    }
    const byCat = new Map<string, GarmentDefinition>();
    for (const g of catalog.data.garments) if (!byCat.has(g.category)) byCat.set(g.category, g);
    const showcase = [...byCat.values()];
    for (const g of catalog.data.garments) if (showcase.length < 4 && !showcase.includes(g)) showcase.push(g);
    return showcase.slice(0, 4).map((g) => {
      const mid = g.sizes[Math.floor(g.sizes.length / 2)]!;
      return { garment: g, size: mid.label, variantId: g.variants[0]!.id };
    });
  }, [measurements, ranking, ui.category]);
}

function useSwatches(stage: string): { items: SwatchItem[]; selected: string | null; interactive: boolean } {
  const worn = useApp((s) => s.worn);
  const activeSlot = useApp((s) => s.activeSlot);
  return useMemo(() => {
    const catalog = getCatalog();
    const slot = activeSlot && worn[activeSlot] ? activeSlot : (Object.keys(worn)[0] as keyof typeof worn | undefined);
    const item = slot ? worn[slot] : undefined;
    const garment = item ? catalog.garment(item.garmentId) : undefined;
    const fabric = garment ? catalog.fabric(garment.fabricId) : undefined;
    if (stage === 'fitting' && garment && fabric && item) {
      return {
        items: garment.variants.map((v) => ({ id: v.id, fabric, variant: v })),
        selected: item.variantId,
        interactive: true,
      };
    }
    // Decorado: una muestra por prenda del catálogo.
    const items: SwatchItem[] = [];
    for (const g of catalog.data.garments) {
      const f = catalog.fabric(g.fabricId);
      const v = g.variants[g.variants.length > 2 ? 2 : 0];
      if (f && v && items.length < 6) items.push({ id: `${g.id}:${v.id}`, fabric: f, variant: v });
    }
    return { items, selected: null, interactive: false };
  }, [stage, worn, activeSlot]);
}

function World({ camera }: { camera: CameraController }) {
  const quality = useApp((s) => s.settings.quality);
  const stage = useApp((s) => s.flow.stage);
  const measurements = useApp((s) => s.measurements);
  const hovered = useApp((s) => s.hoveredGarmentId);
  const setHovered = useApp((s) => s.setHoveredGarment);
  const reduced = useView((s) => s.reducedMotion);
  const q = qualityConfig(quality);
  const items = useRackItems();
  const swatches = useSwatches(stage);
  const mirrorActive = stage === 'height' || stage === 'scan' || stage === 'fitting';
  const rackMeasurements = measurements ?? REFERENCE_MEASUREMENTS.adultB;
  const hangingColors = useMemo(
    () => getCatalog().data.garments.slice(0, 9).map((g) => g.variants[g.variants.length - 1]!.color),
    [],
  );
  const pick = (g: GarmentDefinition) => {
    if (stage === 'catalog' || stage === 'fitting') tryGarment(g, camera);
  };

  return (
    <>
      <ToneMappingSwitch post={q.post} />
      <AmbientTicker active={!reduced && q.dust > 0 && !mirrorActive} />
      <Lighting q={q} />
      <Room q={q} />
      <WindowSet />
      <LightShafts intensity={q.shadows ? 1 : 1.2} />
      <Dust count={q.dust} animate={!reduced} />

      <MirrorSet active={mirrorActive} woodTex={q.woodTex}>
        {mirrorActive && <MirrorStageHost camera={camera} />}
        {(stage === 'height' || stage === 'scan') && <SilhouetteGuide />}
      </MirrorSet>

      <Rack
        items={items}
        measurements={rackMeasurements}
        hoveredId={hovered}
        onPick={pick}
        onHover={(id) => {
          if (stage === 'catalog' || stage === 'fitting') setHovered(id);
        }}
        q={q}
        quality={quality}
        hangingColors={hangingColors}
      />
      <CuttingTable
        swatches={swatches.items}
        selectedId={swatches.selected}
        interactive={swatches.interactive}
        onPick={(variantId) => {
          const { activeSlot, worn, patchWorn } = appStore().getState();
          const slot = activeSlot && worn[activeSlot] ? activeSlot : (Object.keys(worn)[0] as keyof typeof worn | undefined);
          if (slot) patchWorn(slot, { variantId });
        }}
        q={q}
        quality={quality}
      />
      {q.props === 'full' && (
        <>
          <Plant position={[-3.25, 0, -2.75]} height={2.25} seed={4} />
          <Plant position={[3.1, 0, -2.5]} height={1.7} seed={9} />
          <FramedArt position={[-2.0, 1.95, -3.28]} />
          <FramedArt position={[-1.15, 1.75, -3.28]} size={[0.34, 0.44]} />
          <Pendant position={[-1.3, ROOM_TOP, -0.2]} drop={1.05} />
          <Pendant position={[1.7, ROOM_TOP, 0.4]} drop={1.0} />
          <FabricBolts position={[3.05, 0, -1.55]} />
        </>
      )}
      {q.post && (
        <Suspense fallback={null}>
          <Post quality={quality === 'high' ? 'high' : 'medium'} />
        </Suspense>
      )}
      <CameraRig />
    </>
  );
}

const ROOM_TOP = 3.8;

/** El atelier 3D. Cargado de forma diferida: el JS de three/R3F llega después de que la bienvenida ya pinta. */
export default function Scene({ camera }: { camera: CameraController }) {
  const quality = useApp((s) => s.settings.quality);
  const stage = useApp((s) => s.flow.stage);
  const q = qualityConfig(quality);
  const initial = cameraPoseFor('welcome', 'wide');
  const mirrorActive = stage === 'height' || stage === 'scan' || stage === 'fitting';
  useEffect(() => {
    viewStore.getState().setSceneStatus('ready');
  }, []);
  return (
    <Canvas
      frameloop={mirrorActive ? 'always' : 'demand'}
      dpr={q.dpr}
      shadows={q.shadows ? { type: PCFShadowMap } : false}
      camera={{ fov: initial.fov, near: 0.1, far: 80, position: [...initial.position] }}
      gl={{ antialias: q.antialias && !q.post, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
      }}
    >
      <color attach="background" args={['#1b120b']} />
      <Suspense fallback={null}>
        <World camera={camera} />
      </Suspense>
    </Canvas>
  );
}
