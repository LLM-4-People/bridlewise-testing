# .devcontainer

The disposable development container (GitHub Codespaces or any devcontainer host).

- `Dockerfile` — the pinned base image the container is built from.
- `devcontainer.json` — the build, the pinned features, and the post-create step that installs both dependency trees and sets the configuration file's mode; the cockpit still runs on loopback inside it.

It ships with the product (the promotion profile `promotion/main-to-product.json` includes this folder), so a clone of the `product` branch opens in the same container.
