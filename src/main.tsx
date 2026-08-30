import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { App } from './App';
import { env } from './lib/env';
import './styles/kindly.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('KINDLY could not start: the #root element is missing.');

// The demo build is a single file with no server, so it routes on the hash.
const Router = env().isDemo ? HashRouter : BrowserRouter;

// Traffic measurement, and only that.
//
// Vercel Analytics is cookieless and stores no identifier for a visitor, which
// is why there is no consent banner here: there is nothing to consent to being
// stored. It records the URL, referrer, and coarse device and country — never
// a name, a request, or anything typed into KINDLY.
//
// It is off in the single-file demo, which has no server to report to, and off
// in development, where the traffic is ours.
const measureTraffic = env().isProduction && !env().isDemo && !env().isE2E;

createRoot(container).render(
  <StrictMode>
    <Router>
      <App />
      {measureTraffic ? <Analytics /> : null}
    </Router>
  </StrictMode>,
);
