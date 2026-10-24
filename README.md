# os-sandbox

A Docker container that runs Linux distros as sandboxes where agents can build
and test desktop apps.

> **Status:** early development. Nothing is implemented yet.

## Goals

- **Disposable environments:** start a clean Linux desktop in a container, use
  it, and throw it away.
- **Multiple distros:** support several distros so apps can be built and
  tested on each target.
- **Usable by agents:** agents can install dependencies, build an app, launch
  it, and check its UI (for example with screenshots and input) without
  touching the host.
- **Isolated:** whatever runs inside the sandbox stays inside the container.

## Usage

To be written.

## License

To be decided.
