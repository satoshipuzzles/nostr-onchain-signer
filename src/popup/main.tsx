import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// Load chrome mock when running in a regular browser (not as extension)
if (!globalThis.chrome?.runtime?.id) {
  import('../dev/chrome-mock');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
