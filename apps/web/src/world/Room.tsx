import { useEffect, useMemo } from 'react';
import { DoubleSide, ExtrudeGeometry, PlaneGeometry, Shape, type BufferGeometry } from 'three';
import { ROOM, WINDOW } from './layout';
import type { QualityConfig } from './quality';
import { mergeBoxes, type BoxSpec } from './geometryUtils';
import {
  makeHerringboneOak,
  getOakBoards,
  makePlaster,
  makeRug,
  type PbrTextures,
} from './textures/atelierTextures';

function disposeSet(set: PbrTextures): void {
  set.map.dispose();
  set.normalMap.dispose();
  set.roughnessMap.dispose();
}

/** Escala los UV de un plano a metros: la textura se repite según su tamaño físico, sea cual sea la pared. */
function planeInMeters(w: number, h: number): PlaneGeometry {
  const g = new PlaneGeometry(w, h);
  const uv = g.attributes.uv!;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

function setRepeat(set: PbrTextures, rx: number, ry: number, rotation = 0): void {
  for (const t of [set.map, set.normalMap, set.roughnessMap]) {
    t.repeat.set(rx, ry);
    t.rotation = rotation;
    t.center.set(0.5, 0.5);
  }
}

/** Contorno del ventanal arqueado (agujero en el muro): rectángulo + medio punto. */
export function windowPath(shape: Shape | import('three').Path, inset = 0): void {
  const hw = WINDOW.width / 2 - inset;
  const springY = WINDOW.top - WINDOW.width / 2;
  shape.moveTo(WINDOW.x - hw, WINDOW.bottom + inset);
  shape.lineTo(WINDOW.x + hw, WINDOW.bottom + inset);
  shape.lineTo(WINDOW.x + hw, springY);
  shape.absarc(WINDOW.x, springY, hw, 0, Math.PI, false);
  shape.lineTo(WINDOW.x - hw, WINDOW.bottom + inset);
}

function useDisposable<T extends BufferGeometry>(factory: () => T, deps: unknown[]): T {
  const geo = useMemo(factory, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => geo.dispose(), [geo]);
  return geo;
}

export function Room({ q }: { q: QualityConfig }) {
  const floor = useMemo(() => makeHerringboneOak({ size: q.floorTex, L: 7 }), [q.floorTex]);
  const plaster = useMemo(() => makePlaster(q.plasterTex), [q.plasterTex]);
  const boards = useMemo(() => getOakBoards(q.woodTex, 21, 4), [q.woodTex]);
  const rug = useMemo(() => makeRug(512), []);
  useEffect(() => {
    // La espiga mide 14 celdas de 7,5 cm = 1,05 m; girada 45° para que la «espina» corra a lo largo de la sala.
    setRepeat(floor, 1, 1, Math.PI / 4);
    setRepeat(plaster, 0.5, 0.5);
    return () => {
      disposeSet(floor);
      disposeSet(plaster);
      rug.dispose();
    };
  }, [floor, plaster, rug]);

  const width = ROOM.halfWidth * 2;
  const depth = ROOM.frontZ - ROOM.backZ;
  const midZ = (ROOM.frontZ + ROOM.backZ) / 2;

  const floorGeo = useDisposable(() => {
    const g = new PlaneGeometry(width, depth);
    const uv = g.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * width) / 1.05, (uv.getY(i) * depth) / 1.05);
    return g;
  }, [width, depth]);
  const sideGeo = useDisposable(() => planeInMeters(depth, ROOM.height), [depth]);
  const ceilGeo = useDisposable(() => planeInMeters(width, depth), [width, depth]);

  const backWall = useDisposable(() => {
    const s = new Shape();
    s.moveTo(-ROOM.halfWidth, 0);
    s.lineTo(ROOM.halfWidth, 0);
    s.lineTo(ROOM.halfWidth, ROOM.height);
    s.lineTo(-ROOM.halfWidth, ROOM.height);
    s.closePath();
    const hole = new Shape();
    windowPath(hole);
    s.holes.push(hole);
    return new ExtrudeGeometry(s, { depth: 0.3, bevelEnabled: false, curveSegments: 28 });
  }, []);

  /** Zócalo, friso y paneles de la boiserie (verde oliva) — todo en una sola malla. */
  const trim = useDisposable(() => {
    const boxes: BoxSpec[] = [];
    const z = ROOM.backZ + 0.012;
    const segments: [number, number][] = [
      [-ROOM.halfWidth, WINDOW.x - WINDOW.width / 2 - 0.15],
      [WINDOW.x + WINDOW.width / 2 + 0.15, ROOM.halfWidth],
    ];
    for (const [x0, x1] of segments) {
      const w = x1 - x0;
      const cx = (x0 + x1) / 2;
      boxes.push({ pos: [cx, 0.5, z], size: [w, 0.84, 0.024] }); // cuerpo del zócalo alto
      boxes.push({ pos: [cx, 0.92, z + 0.018], size: [w, 0.045, 0.05] }); // moldura superior
      boxes.push({ pos: [cx, 0.08, z + 0.016], size: [w, 0.16, 0.036] }); // rodapié
      const n = Math.max(1, Math.round(w / 0.95));
      const pw = w / n;
      for (let i = 0; i < n; i++) {
        const px = x0 + pw * (i + 0.5);
        const iw = pw - 0.2;
        const ih = 0.56;
        const py = 0.5;
        for (const [dx, dy, sw, sh] of [
          [0, ih / 2, iw, 0.028],
          [0, -ih / 2, iw, 0.028],
          [-iw / 2, 0, 0.028, ih],
          [iw / 2, 0, 0.028, ih],
        ] as const) {
          boxes.push({ pos: [px + dx, py + dy, z + 0.02], size: [sw, sh, 0.02] });
        }
      }
    }
    // Friso alto y cornisa
    boxes.push({ pos: [0, ROOM.height - 0.07, ROOM.backZ + 0.05], size: [width, 0.14, 0.1] });
    boxes.push({ pos: [0, ROOM.height - 0.17, ROOM.backZ + 0.03], size: [width, 0.04, 0.06] });
    return mergeBoxes(boxes);
  }, [width]);

  const beams = useDisposable(
    () =>
      mergeBoxes(
        [-2.4, 0.2, 2.8, 5.4].map((z) => ({ pos: [0, ROOM.height - 0.13, z], size: [width, 0.26, 0.22] }) as BoxSpec),
      ),
    [width],
  );

  return (
    <group>
      {/* Suelo de espiga */}
      <mesh geometry={floorGeo} rotation-x={-Math.PI / 2} position={[0, 0, midZ]} receiveShadow>
        <meshStandardMaterial
          map={floor.map}
          normalMap={floor.normalMap}
          normalScale={[0.9, 0.9] as never}
          roughnessMap={floor.roughnessMap}
          roughness={1}
          envMapIntensity={0.75}
        />
      </mesh>
      {/* Alfombra bajo el espejo */}
      <mesh rotation-x={-Math.PI / 2} position={[0.1, 0.004, -0.55]} receiveShadow>
        <planeGeometry args={[3.4, 2.3]} />
        <meshStandardMaterial map={rug} roughness={0.95} polygonOffset polygonOffsetFactor={-2} />
      </mesh>

      {/* Paredes */}
      <mesh geometry={backWall} position={[0, 0, ROOM.backZ - 0.3]} castShadow receiveShadow>
        <meshStandardMaterial map={plaster.map} normalMap={plaster.normalMap} roughnessMap={plaster.roughnessMap} roughness={1} />
      </mesh>
      <mesh geometry={sideGeo} rotation-y={Math.PI / 2} position={[-ROOM.halfWidth, ROOM.height / 2, midZ]} receiveShadow>
        <meshStandardMaterial map={plaster.map} normalMap={plaster.normalMap} roughnessMap={plaster.roughnessMap} roughness={1} />
      </mesh>
      <mesh geometry={sideGeo} rotation-y={-Math.PI / 2} position={[ROOM.halfWidth, ROOM.height / 2, midZ]} receiveShadow>
        <meshStandardMaterial map={plaster.map} normalMap={plaster.normalMap} roughnessMap={plaster.roughnessMap} roughness={1} />
      </mesh>
      <mesh geometry={ceilGeo} rotation-x={Math.PI / 2} position={[0, ROOM.height, midZ]} receiveShadow>
        <meshStandardMaterial map={plaster.map} roughness={1} color="#f0e6d2" side={DoubleSide} />
      </mesh>

      {/* Boiserie verde oliva + cornisa */}
      <mesh geometry={trim} castShadow receiveShadow>
        <meshStandardMaterial color="#4a5a35" roughness={0.55} metalness={0.02} />
      </mesh>
      <mesh geometry={beams} castShadow receiveShadow>
        <meshStandardMaterial map={boards.map} normalMap={boards.normalMap} roughnessMap={boards.roughnessMap} roughness={1} color="#8a6a48" />
      </mesh>
    </group>
  );
}
