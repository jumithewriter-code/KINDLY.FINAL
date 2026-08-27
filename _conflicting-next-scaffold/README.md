# Set aside — not part of the KINDLY build

A partial Next.js/v0 scaffold appeared in this directory part-way through the
build (`app/`, `components/`, `lib/`, `public/`, `next.config.mjs`,
`postcss.config.mjs`, `components.json`). It also overwrote `tsconfig.json` and
`vitest.config.ts`.

It is **not** wired into anything:

* `next` is not a dependency in `package.json`, so it cannot build or run.
* Its `next.config.mjs` sets `typescript.ignoreBuildErrors: true`, which is the
  opposite of what this project needs.
* It duplicates, in a different framework, screens that already exist under
  `src/routes/`.

Nothing has been deleted. Move it back if it was intended; otherwise this whole
directory can be removed.
