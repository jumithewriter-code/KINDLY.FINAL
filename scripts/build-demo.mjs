/**
 * Builds the single-file demonstration bundle.
 *
 * The demo is published as one self-contained HTML page, so every script and
 * stylesheet has to be inlined: the host serves a single document and blocks
 * requests to other origins. That also means the demo can only ever use the
 * in-process backend — which is why the build forces it, rather than leaving it
 * to an environment variable someone might get wrong.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
const out = join(root, 'demo');
const site = join(out, 'site');   // the deployable static site

console.log('Building with VITE_KINDLY_DEMO=true …');
execFileSync('npx', ['vite', 'build', '--mode', 'production'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    VITE_KINDLY_DEMO: 'true',
    VITE_KINDLY_BACKEND: 'memory',
    // No credentials are embedded: the demo has no server to talk to.
    VITE_SUPABASE_URL: '',
    VITE_SUPABASE_ANON_KEY: '',
  },
});

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));

/** Replaces the whole tag that references `file`, found by scanning rather than
 *  by matching attribute order, which Vite is free to change. */
function inline(source, file, replacement) {
  const at = source.indexOf(file);
  if (at === -1) throw new Error(`index.html does not reference ${file}`);
  const open = source.lastIndexOf('<', at);
  let close = source.indexOf('>', at) + 1;
  // A <script> tag needs its closing tag removed too.
  const isScript = source.slice(open, open + 7) === '<script';
  if (isScript) close = source.indexOf('</script>', close) + '</script>'.length;
  return source.slice(0, open) + replacement + source.slice(close);
}

for (const file of assets.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(join(dist, 'assets', file), 'utf8');
  html = inline(html, file, `<style>
${css}
</style>`);
}

const entry = assets.find((f) => f.startsWith('index-') && f.endsWith('.js'));
if (!entry) throw new Error('Could not find the built entry chunk.');
const js = readFileSync(join(dist, 'assets', entry), 'utf8');
html = inline(html, entry, `<script type="module">
${js}
</script>`);

// Any remaining preload hints point at files that no longer exist.
html = html.replace(/<link[^>]*rel="modulepreload"[^>]*>\s*/g, '');

if (html.includes('/assets/')) {
  throw new Error('The demo still references external assets; it would not load standalone.');
}

mkdirSync(site, { recursive: true });
writeFileSync(join(site, 'index.html'), html, 'utf8');

// The demo routes on the hash, so no rewrites are needed; the catch-all is
// there so a stray path still lands on the app rather than a 404.
writeFileSync(join(site, 'vercel.json'), `${JSON.stringify({
  $schema: 'https://openapi.vercel.sh/vercel.json',
  cleanUrls: true,
  rewrites: [{ source: '/(.*)', destination: '/index.html' }],
  headers: [{
    source: '/(.*)',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ],
  }],
}, null, 2)}
`, 'utf8');

// A second copy holding only what belongs inside <body>, for hosts that supply
// their own document skeleton (the Artifact viewer does). Same bytes otherwise.
const bodyStart = html.indexOf('<body>') + '<body>'.length;
const bodyEnd = html.lastIndexOf('</body>');
if (bodyStart < 6 || bodyEnd === -1) throw new Error('Could not find the document body.');

// Vite emits both the stylesheet and the entry script into <head>, so lift them
// out explicitly rather than assuming anything about where they sit.
const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>') + '</style>'.length);
const scriptOpen = html.indexOf('<script type="module">');
const scriptClose = html.indexOf('</script>', scriptOpen) + '</script>'.length;
if (html.indexOf('<style>') === -1 || scriptOpen === -1) {
  throw new Error('Could not find the inlined style or script to lift out.');
}
const script = html.slice(scriptOpen, scriptClose);

const body = html.slice(bodyStart, bodyEnd).replace(script, '').trim();
const fragment = `${styles}\n${body}\n${script}\n`;

writeFileSync(join(out, 'kindly-artifact.html'), fragment, 'utf8');

const kb = (text) => (Buffer.byteLength(text) / 1024).toFixed(0);
console.log(`\nWrote demo/site/index.html      (${kb(html)} kB, complete document)`);
console.log(`Wrote demo/kindly-artifact.html (${kb(fragment)} kB, body content only)`);
