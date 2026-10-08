import { useApp } from '../state/store';
import { useView } from '../world/viewStore';

/** Vista de depuración oculta (`?debug=1`): fps y métricas del espejo. No lleva texto de interfaz traducible. */
export function DebugHud() {
  const stats = useView((s) => s.stats);
  const tracking = useView((s) => s.tracking);
  const layout = useView((s) => s.layout);
  const scene = useView((s) => s.sceneStatus);
  const stage = useApp((s) => s.flow.stage);
  const quality = useApp((s) => s.settings.quality);
  return (
    <aside className="debug" aria-hidden="true" data-testid="debug-hud">
      <div>stage: {stage}</div>
      <div>layout: {layout} · scene: {scene} · q: {quality}</div>
      <div>tracking: {tracking}</div>
      {stats ? (
        <>
          <div>fps: {stats.fps.toFixed(0)}</div>
          <div>
            pose {stats.poseMs.toFixed(1)} · skin {stats.skinMs.toFixed(1)} · cloth {stats.clothMs.toFixed(1)} ms
          </div>
          <div>tris: {stats.triangles}</div>
        </>
      ) : (
        <div>sin métricas</div>
      )}
    </aside>
  );
}
