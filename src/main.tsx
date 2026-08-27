import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { env } from './lib/env';
import './styles/kindly.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('KINDLY could not start: the #root element is missing.');

// The demo build is a single file with no server, so it routes on the hash.
const Router = env().isDemo ? HashRouter : BrowserRouter;

createRoot(container).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>,
);
