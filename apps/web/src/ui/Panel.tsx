import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerAnchor } from '../world/anchors';
import { cameraPoseFor, panelWorldPose, type StageKey } from '../world/layout';
import { PANEL_SPECS, type PanelId } from '../world/panelSpecs';
import { useAnchored, useView } from '../world/viewStore';

export type Dock = 'left' | 'right' | 'center' | 'bottom' | 'top';

export interface PanelProps {
  readonly id: PanelId;
  /** Pantalla a la que pertenece (fija la cámara de reposo con la que se calcula su anclaje). */
  readonly stage: StageKey;
  readonly dock: Dock;
  readonly children: ReactNode;
  readonly className?: string;
  readonly tone?: 'paper' | 'dark' | 'brass' | 'bare';
  /** Ancho natural en píxeles CSS cuando va anclado al espacio. */
  readonly width?: number;
  readonly role?: string;
  readonly label?: string;
  readonly labelledBy?: string;
  readonly as?: 'section' | 'div' | 'form';
  readonly onSubmit?: () => void;
}

/**
 * Panel de la interfaz. Siempre es DOM real (foco, ARIA, teclado). Dónde se dibuja depende de la disposición:
 * - ancha: se ancla en el espacio 3D del atelier (CSS3D alineado con la cámara del Canvas);
 * - estrecha o sin escena: se acopla a un borde de la pantalla como una hoja fija.
 */
export function Panel(props: PanelProps) {
  const { id, stage, dock, children, className, tone = 'paper', width = 380, role, label, labelledBy } = props;
  const anchored = useAnchored();
  const aspect = useView((s) => s.aspect);
  const viewportHeight = useView((s) => s.viewportHeight);
  const ref = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(anchored ? document.getElementById('css3d-camera') : null);
  }, [anchored]);

  const pose = useMemo(
    () => panelWorldPose(cameraPoseFor(stage, 'wide'), aspect, viewportHeight, PANEL_SPECS[id]),
    [stage, aspect, viewportHeight, id],
  );

  useLayoutEffect(() => {
    if (!anchored || !target || !ref.current) return undefined;
    return registerAnchor(id, ref.current, pose);
  }, [anchored, target, pose, id]);

  const Tag = props.as ?? 'section';
  const common = {
    ref: ref as never,
    className: `panel panel--${tone} ${className ?? ''}`,
    role,
    'aria-label': label,
    'aria-labelledby': labelledBy,
    onSubmit: props.onSubmit
      ? (e: { preventDefault: () => void }) => {
          e.preventDefault();
          props.onSubmit?.();
        }
      : undefined,
  };

  if (anchored) {
    if (!target) return null;
    return createPortal(
      <Tag {...common} data-anchor={id} data-placed="false" style={{ width }}>
        {children}
      </Tag>,
      target,
    );
  }
  return (
    <Tag {...common} data-dock={dock} data-panel={id}>
      {children}
    </Tag>
  );
}
