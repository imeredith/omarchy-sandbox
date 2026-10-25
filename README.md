# os-sandbox

A Docker container that runs Linux distros as sandboxes where agents can build
and test desktop apps.

> **Status:** early development. The first sandbox is
> [Omarchy](https://omarchy.org) (Arch Linux + Hyprland), driven by the `osb`
> CLI inside the container and by an MCP server on the host.

## Goals

- **Disposable environments:** start a clean Linux desktop in a container, use
  it, and throw it away.
- **Multiple distros:** support several distros so apps can be built and
  tested on each target.
- **Usable by agents:** agents can install dependencies, build an app, launch
  it, and check its UI (for example with screenshots and input) without
  touching the host.
- **Isolated:** whatever runs inside the sandbox stays inside the container.

## How it works

Hyprland needs a DRM device to allocate buffers, so it can't run directly in a
plain container without passing through a host GPU. Instead, the container
boots its own filesystem as a small QEMU VM:

- The guest kernel mounts the container's `/` as its root filesystem over
  virtiofs. There is no disk image, and anything the guest writes lands in the
  container's writable layer. Removing the container throws the sandbox away.
- Omarchy starts as usual (SDDM autologin, then uwsm, then Hyprland) on a
  virtio GPU that Mesa renders in software. No host GPU or display is needed.
- `osb`, the container's entrypoint, starts the VM and drives it:
  - Screenshots and mouse/keyboard input go through QEMU's QMP socket. They
    behave like a real monitor, tablet and keyboard, so they work on the
    login screen too.
  - Commands run as the `omarchy` user over SSH, inside the live Hyprland
    session (`WAYLAND_DISPLAY`, `hyprctl` and `omarchy-*` all work).
- The VM's display is also served over VNC on port 5900, so you can watch it.

```
host ── docker exec osb … ──▶ container: osb ──QMP──▶ QEMU ──▶ guest: Omarchy / Hyprland
  │                                          └──SSH──────────────▶ (container / over virtiofs)
  └── VNC viewer ── 127.0.0.1:<port> ──▶ QEMU VNC (:5900)
```

## Requirements

- Linux with Docker.
- `/dev/kvm` (hardware virtualisation). Without it QEMU falls back to software
  emulation, which works but is far too slow to be useful.
- About 4 GB of free RAM per running sandbox (configurable) and about 6 GB of
  disk for the image.

## The image

Build it from the `image/` directory:

```sh
docker build -t os-sandbox image/
```

The image contains Omarchy plus the desktop part of its ISO package list:
foot, Chromium, Nautilus, portals, fonts, themes, fcitx5 and the CLI tools its
shell setup uses. Hardware tools, printing, Docker and the large office and
creative apps are left out. To bake extra Arch packages into the guest (for
example the toolchain for your app), add
`--build-arg EXTRA_PACKAGES="nodejs npm"`. This only rebuilds the last layers.

Run a sandbox:

```sh
docker run -d --init --name osb-default \
  --device /dev/kvm \
  --hostname omarchy-sandbox \
  --stop-timeout 30 \
  -p 127.0.0.1:5900:5900 \
  -v "$PWD:/workspace" \
  os-sandbox

docker exec osb-default osb wait     # blocks until the desktop is up (about 15 s with KVM)
```

- `--device /dev/kvm` gives the VM hardware virtualisation.
- `--stop-timeout 30` gives `docker stop` time to shut the guest down cleanly
  (usually under 10 s) before Docker kills it.
- `-p 127.0.0.1:5900:5900` publishes the VNC view on localhost only. The VNC
  server has **no password** unless you set `OSB_VNC_PASSWORD`, so never
  publish it on other interfaces. Other containers on the same Docker network
  can reach port 5900 directly; set a password if that matters.
- `-v …:/workspace` is optional. The directory appears at `/workspace` and
  `~/workspace` in the guest.
- `--hostname` is optional. It sets the hostname the guest sees, which
  otherwise is the random container ID.
- These environment variables set the VM size:

  | Variable | Default | Meaning |
  | --- | --- | --- |
  | `OSB_WIDTH` | 1280 | Screen width in pixels |
  | `OSB_HEIGHT` | 800 | Screen height in pixels |
  | `OSB_MEMORY` | 4096 | Guest RAM in MiB |
  | `OSB_CPUS` | 2 | Guest vCPUs |
  | `OSB_VNC_PASSWORD` | unset | VNC password. VNC only uses the first 8 characters |

Watch the desktop with any VNC client, for example `vncviewer 127.0.0.1:5900`.
`docker stop` powers the guest off cleanly. `docker start` boots it again with
its state intact. `docker rm` discards it.

The guest user is `omarchy` (password `omarchy`, passwordless sudo, and it can
read the system journal). The password is not a secret: sshd only accepts the
key `osb boot` generates in each container on its first boot, so the password
only unlocks the screen locker. The first `osb wait` dismisses Omarchy's
first-login notifications ("Learn Keybindings", "Update System"), because they
stay on screen and cover the top-right corner. Pass `--keep-notifications` to
leave them.

## `osb`

`osb` runs inside the container: `docker exec <container> osb <command>`. Use
`-it` for `osb shell`. Coordinates are screen pixels: the screen is a single
monitor at scale 1, so they match full-screen screenshots. Most commands print
JSON.

| Command | What it does |
| --- | --- |
| `osb status` | VM, SSH, Hyprland and shell state, plus screen size |
| `osb wait [--timeout 180] [--no-shell]` | Block until the desktop (and the Omarchy bar) is up |
| `osb screenshot [-o FILE] [--region X,Y,WxH \| --window MATCH]` | PNG of the screen (stdout by default) |
| `osb click X Y [--button right] [--count 2] [--mod ctrl]` | Click |
| `osb move X Y` | Move the pointer |
| `osb mousedown/mouseup [X Y] [--button …]` | Press or release a button |
| `osb drag X1 Y1 X2 Y2 [--steps 20]` | Drag |
| `osb scroll [X Y] --dy 3 [--dx -1]` | Scroll wheel notches (positive dy is down) |
| `osb key super+return ctrl+shift+t escape` | Press key combos |
| `osb type "text"` (or stdin) | Type text (US layout; other characters go through `wtype`) |
| `osb exec [--cwd DIR] [--root] [--timeout S] -- CMD` | Run a bash command in the Hyprland session; exit code passes through (124 on timeout) |
| `osb launch [--cwd DIR] [--wait S] [--match RE] -- CMD` | Start an app detached, logging to `~/.cache/osb/logs/`; reports its pid and new windows, or the log tail if it exits straight away |
| `osb windows` | List windows |
| `osb wait-window MATCH [--timeout 30]` | Wait for a window whose class or title matches |
| `osb focus MATCH` / `osb close MATCH [--kill]` | Focus or close a window |
| `osb push SRC DEST` / `osb pull SRC DEST` | Copy between the container and the guest (as `omarchy`) |
| `osb shell` | Interactive shell in the session (`docker exec -it`) |

`exec` and `launch` take a single shell command line (`osb exec -- 'make && ./app'`).
If you pass several arguments instead, they are quoted as separate words.

For example:

```sh
docker exec osb-default osb launch --wait 10 -- alacritty
docker exec osb-default osb type 'echo hello'
docker exec osb-default osb key return
docker exec osb-default osb screenshot > screen.png
```

## MCP server

`mcp/` is an MCP server (stdio) for agents. It wraps `docker run` and
`docker exec <container> osb …`, and returns screenshots as image content.

Build it:

```sh
cd mcp
npm install
npm run build
```

Register it with Claude Code:

```sh
claude mcp add os-sandbox -- node /path/to/os-sandbox/mcp/dist/server.js
```

Or with any client that takes an `mcpServers` JSON config:

```json
{
  "mcpServers": {
    "os-sandbox": {
      "command": "node",
      "args": ["/path/to/os-sandbox/mcp/dist/server.js"],
      "env": { "OSB_IMAGE": "os-sandbox:latest" }
    }
  }
}
```

Environment variables:

- `OSB_IMAGE`: the image to run (default `os-sandbox:latest`).
- `OSB_DOCKER`: the docker binary (default `docker`).
- `OSB_VNC_PASSWORD`: if set, passed to new sandboxes as their VNC password.

Every tool takes an optional `sandbox` name (default `"default"`), so an agent
can run several sandboxes at once. Each sandbox is a container named
`osb-<name>` with the label `os-sandbox`, and VNC is published on a random
localhost port that `sandbox_start` and `status` report.

| Tool | Purpose |
| --- | --- |
| `sandbox_start` | Start (or resume) a sandbox and wait for the desktop. Options: workspace mount, screen size, RAM, CPUs, image |
| `sandbox_stop` | Power off and delete (or `keep`) a sandbox |
| `sandbox_list`, `status`, `wait`, `sandbox_logs` | Inspect sandboxes. `sandbox_logs` shows the serial console, container log and guest journal |
| `screenshot` | Full screen, a region or a window, as an image |
| `click`, `move`, `mouse_button`, `drag`, `scroll`, `key`, `type` | Input. Each can return a screenshot taken right after the action (`screenshot: true`) |
| `exec` | Run a command in the session and get the exit code, stdout and stderr |
| `launch` | Start an app detached and get its new window, pid and log path |
| `windows`, `wait_window`, `focus_window`, `close_window` | Window management |
| `push`, `pull` | Copy files between the host and the guest |

A typical agent loop:

1. `sandbox_start` with `workspace` set to the project.
2. `exec` to install dependencies and build.
3. `launch` the app.
4. `screenshot`, then `click`, `type` or `key`, then `screenshot` again.
5. `sandbox_stop`.

`npm run smoke` runs this loop against a real sandbox through the MCP
protocol. It starts a sandbox named `smoke`, uses every tool and then removes
the sandbox.

## Publishing the image

The image holds no secrets, so it can be pushed to a public registry:

- The SSH key `osb` uses to reach the VM is generated in each container on its
  first boot (`/etc/osb/id_ed25519`), not at build time.
- The secret half of the pacman keyring's local master key is deleted in the
  layer that creates it. To sign a new key locally in a derived image, run
  `pacman-key --init` first.
- SSH host keys and `/etc/machine-id` are created by the guest on first boot,
  so each sandbox gets its own.
- The `omarchy` password is public, as described above.

For example, to GitHub's registry (with a token that has `write:packages`):

```sh
docker build -t ghcr.io/<owner>/os-sandbox:latest \
  --label org.opencontainers.image.source=https://github.com/<owner>/os-sandbox \
  image/
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <owner> --password-stdin
docker push ghcr.io/<owner>/os-sandbox:latest
```

The source label links the package to its repository. Then point the MCP
server at it with `OSB_IMAGE=ghcr.io/<owner>/os-sandbox:latest`. Arch is a
rolling release, so rebuild and push from time to time. To add packages to a
published image, build `FROM ghcr.io/<owner>/os-sandbox` and run
`pacman -Syu --noconfirm <packages>`.

## License

MIT, see [LICENSE](LICENSE). The image also contains Arch Linux, Omarchy and
other software, each under its own license.
