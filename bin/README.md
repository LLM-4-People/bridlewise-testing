# bin

The command-line entry of the product: the one file a user runs to reach the engine's CLI (`preflight`, `harness`, `quality` and the rest). It holds no logic of its own; the commands live in the engine, and this folder only gives them a stable, build-free name.

- `bridlewise.mjs` — the CLI launcher: it runs `engine/src/cli.ts` on Node 24's type stripping, so `npm link`, `npx bridlewise` and a checked-out `./bin/bridlewise.mjs` all reach the same entry without a build step. The root `package.json` names it as the `bridlewise` command, and the promotion profile (`promotion/main-to-product.json`) ships it as an entry point.
