# Bridlewise — the product

> [!WARNING]
> **Bridlewise is an experimental developer preview. It is not production-ready, and it is not safe for sensitive code.**
> There has been no security audit. Run it on a disposable copy of a repository, with credentials you can revoke. Read [SECURITY.md](https://github.com/LLM-4-People/bridlewise/blob/product/SECURITY.md) first.

This is the `product` branch of [`LLM-4-People/bridlewise`](https://github.com/LLM-4-People/bridlewise): the part of `main` that ships, and nothing else. Nobody edits it. Every commit on it is a **projection** of one `main` commit, computed by the promotion profile [`promotion/main-to-product.json`](https://github.com/LLM-4-People/bridlewise/blob/main/promotion/main-to-product.json) and written by the publisher App:

- its trailer `Projected-From:` names the `main` commit it was computed from, and its second parent is that commit;
- recomputing the projection from that commit gives the same tree (`node engine/src/cli.ts harness promote plan --source <commit>` in a checkout of `main`);
- its projection attestation can be checked with `gh attestation verify`.

Pull requests go to `main`. The documentation, the roadmap and the live state of the project are at <https://llm-4-people.github.io/bridlewise/>.

Links in this file are absolute: it is written in `main`'s `product-only/` folder (the profile's overlay) and ships here at the top of the tree.

## Get it

Each release is immutable and attested. Download its assets from [Releases](https://github.com/LLM-4-People/bridlewise/releases) and check them before you run anything:

```bash
gh release verify <tag> --repo LLM-4-People/bridlewise
gh attestation verify <asset> --repo LLM-4-People/bridlewise
```

Or clone this branch:

```bash
git clone --branch product https://github.com/LLM-4-People/bridlewise.git
```

## Run it

Requirements: Node.js 24 (see `.nvmrc`), npm, and Linux for the Landlock confinement path.

```bash
make install
make dev        # the API server and the cockpit; open http://127.0.0.1:5173
make stop
```

The [quickstart](https://llm-4-people.github.io/bridlewise/quickstart/) covers the first account, adding a model provider, a project, and the fixture mode that runs the interface without a model. `./bin/bridlewise.mjs --help` lists the CLI.

## License

GNU Affero General Public License v3.0: see [LICENSE](https://github.com/LLM-4-People/bridlewise/blob/product/LICENSE), [NOTICE](https://github.com/LLM-4-People/bridlewise/blob/product/NOTICE) and [THIRD_PARTY_NOTICES.md](https://github.com/LLM-4-People/bridlewise/blob/product/THIRD_PARTY_NOTICES.md).
