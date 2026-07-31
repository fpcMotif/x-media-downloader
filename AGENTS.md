# Agent notes

Packages are deep modules — see [src/packages/README.md](./src/packages/README.md) before adding or importing one. Import a package only through its entry points (its root files); everything in its subfolders is private. Enforced by `bun run lint:boundaries`.
