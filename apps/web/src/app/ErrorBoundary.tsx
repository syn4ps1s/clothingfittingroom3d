import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  readonly fallback: (error: Error) => ReactNode;
  readonly onError?: (error: Error) => void;
}

/** Contiene los fallos de render (escena 3D, pantallas diferidas) para que la app siga siendo usable. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Fallo de render contenido', error, info.componentStack);
    this.props.onError?.(error);
  }

  override render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
