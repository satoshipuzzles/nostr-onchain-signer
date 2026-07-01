import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

if (!globalThis.chrome?.runtime?.id || globalThis.chrome?.runtime?.id === 'pwa-mode') {
  import('../dev/chrome-mock');
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  handleReset = () => {
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith('nostr_onchain_')) localStorage.removeItem(key);
    }
    sessionStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#fff', fontFamily: '-apple-system, sans-serif' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: '#888', fontSize: 13, marginBottom: 8 }}>{this.state.error}</p>
          <p style={{ color: '#666', fontSize: 12, marginBottom: 24 }}>
            If this keeps happening, reset and restore from your backup file.
          </p>
          <button
            onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
            style={{ background: '#f7931a', color: '#fff', border: 'none', borderRadius: 12, padding: '12px 24px', fontWeight: 600, fontSize: 14, cursor: 'pointer', marginRight: 8 }}
          >
            Retry
          </button>
          <button
            onClick={this.handleReset}
            style={{ background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 12, padding: '12px 24px', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
          >
            Reset & Start Over
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
