import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/instrument-sans/index.css';
import './styles/index.css';
import { App } from './app/App';
import { appParams } from './app/params';
import { createAppStore, installAppStore } from './state/store';

// Los parámetros de URL de desarrollo (?lang, ?quality) sólo fijan valores iniciales; nunca llevan datos de la persona.
const params = appParams();
installAppStore(
  createAppStore({
    languages: navigator.languages,
    overrides: { lang: params.lang, quality: params.quality },
  }),
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
