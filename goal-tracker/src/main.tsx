import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Headings use Playfair Display, bundled with the site so no font is fetched from elsewhere.
import '@fontsource-variable/playfair-display';
import './styles.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
