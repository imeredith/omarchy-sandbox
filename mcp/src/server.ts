#!/usr/bin/env node
/**
 * os-sandbox MCP server.
 *
 * Starts throwaway Omarchy desktops (containers of the os-sandbox image, each
 * booting an Omarchy VM) and exposes the `osb` CLI inside them as tools:
 * screenshots, mouse and keyboard input, commands in the Hyprland session,
 * app launching, window management and file transfer.
 *
 * Every tool shells out to `docker run` / `docker exec <container> osb ...`,
 * so the server holds no state of its own: sandboxes are just containers
 * labelled `os-sandbox` and named `osb-<name>`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DOCKER = process.env.OSB_DOCKER ?? "docker";
const IMAGE = process.env.OSB_IMAGE ?? "os-sandbox:latest";
const LABEL = "os-sandbox";
const VNC_PORT = "5900/tcp";
// Keep tool output small enough for an agent's context.
const MAX_OUTPUT = 40_000;

class ToolError extends Error {}

// --------------------------------------------------------------------------
// process helpers

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError(`cannot run ${cmd}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString(),
      });
    });
    child.stdin.end(opts.input ?? "");
  });
}

async function docker(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  const r = await run(DOCKER, args, opts);
  if (r.code !== 0) {
    throw new ToolError(`docker ${args[0]} failed: ${(r.stderr || r.stdout.toString()).trim()}`);
  }
  return r;
}

const containerName = (sandbox: string) => `osb-${sandbox}`;

async function containerState(sandbox: string): Promise<"running" | "stopped" | "missing"> {
  const r = await run(DOCKER, ["inspect", "-f", "{{.State.Running}}", containerName(sandbox)]);
  if (r.code !== 0) return "missing";
  return r.stdout.toString().trim() === "true" ? "running" : "stopped";
}

/** Run `osb <args>` in a sandbox; throws with osb's error message on failure. */
async function osb(sandbox: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  const r = await osbRaw(sandbox, args, opts);
  if (r.code !== 0) {
    throw new ToolError(r.stderr.trim() || `osb ${args[0]} exited with ${r.code}`);
  }
  return r;
}

async function osbRaw(sandbox: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<RunResult> {
  const r = await run(DOCKER, ["exec", "-i", containerName(sandbox), "osb", ...args], {
    timeoutMs: opts.timeoutMs ?? 120_000,
    input: opts.input,
  });
  if (r.code !== 0 && /No such container|is not running/.test(r.stderr)) {
    throw new ToolError(`sandbox "${sandbox}" is not running; start it with sandbox_start`);
  }
  return r;
}

async function vncAddress(sandbox: string): Promise<string | null> {
  const r = await run(DOCKER, ["port", containerName(sandbox), VNC_PORT]);
  return r.code === 0 ? r.stdout.toString().trim().split("\n")[0] || null : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n... [${s.length - MAX_OUTPUT} chars omitted] ...\n${s.slice(-MAX_OUTPUT / 2)}` : s;
}

// --------------------------------------------------------------------------
// results

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));

async function screenshotContent(sandbox: string, extra: string[] = []): Promise<CallToolResult["content"]> {
  const r = await osb(sandbox, ["screenshot", ...extra], { timeoutMs: 60_000 });
  const png = r.stdout;
  const size = png.length >= 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "unknown size";
  return [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: `screenshot ${size}` },
  ];
}

/** Wrap a tool handler: turn thrown errors into MCP tool errors. */
function tool<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { isError: true, content: [{ type: "text", text: msg }] };
    }
  };
}

/** Result of an input action, optionally followed by a fresh screenshot. */
async function afterInput(sandbox: string, screenshot: boolean, summary: string): Promise<CallToolResult> {
  if (!screenshot) return text(summary);
  await sleep(400); // let the compositor draw the result
  return { content: [{ type: "text", text: summary }, ...(await screenshotContent(sandbox))] };
}

// --------------------------------------------------------------------------
// schemas shared by several tools

const sandbox = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .default("default")
  .describe('Sandbox name (default "default")');
const screenshotAfter = z
  .boolean()
  .default(false)
  .describe("Return a screenshot taken just after the action");
const button = z.enum(["left", "right", "middle", "back", "forward"]).default("left");
const coord = z.number().int().nonnegative();
const windowMatch = z
  .string()
  .describe("Window address (0x...) or a case-insensitive regex matched against class and title");

// --------------------------------------------------------------------------

const server = new McpServer(
  { name: "os-sandbox", version: "0.1.0" },
  {
    instructions: [
      "Disposable Omarchy (Arch Linux + Hyprland) desktops for testing apps.",
      "Start one with sandbox_start (it waits until the desktop is up), then use screenshot to look at it",
      "and click/type/key/scroll/drag to drive it. Coordinates are screen pixels of the full-screen screenshot.",
      "Run shell commands in the desktop session with exec, start GUI apps with launch, and use",
      "windows/focus/close_window to manage them. Use push/pull (or the workspace mount) to move files in and out.",
      "Omarchy is keyboard driven: super+return opens a terminal, super+space the app launcher, super+w closes a window.",
      "Call sandbox_stop when done; it throws the whole VM away.",
    ].join(" "),
  },
);

// ---- lifecycle -------------------------------------------------------------

server.registerTool(
  "sandbox_start",
  {
    title: "Start sandbox",
    description:
      "Start an Omarchy desktop sandbox (a container that boots an Omarchy VM) and wait until the desktop is ready. " +
      "If a stopped sandbox of that name exists it is resumed with its previous state.",
    inputSchema: {
      sandbox,
      workspace: z
        .string()
        .optional()
        .describe("Host directory to mount at /workspace (also ~/workspace in the guest)"),
      width: z.number().int().min(640).max(3840).default(1280),
      height: z.number().int().min(480).max(2160).default(800),
      memory_mb: z.number().int().min(2048).default(4096).describe("Guest RAM in MiB"),
      cpus: z.number().int().min(1).max(16).default(2),
      image: z.string().optional().describe(`Docker image (default ${IMAGE})`),
      wait: z.boolean().default(true).describe("Wait for the desktop to be ready"),
      timeout: z.number().int().positive().default(300).describe("Seconds to wait for the desktop"),
    },
  },
  tool(async (a) => {
    const name = containerName(a.sandbox);
    const state = await containerState(a.sandbox);
    if (state === "stopped") {
      await docker(["start", name]);
    } else if (state === "missing") {
      const args = [
        "run", "-d", "--init",
        "--name", name,
        "--label", LABEL,
        "--hostname", "omarchy-sandbox",
        "--stop-timeout", "30",
        "-p", `127.0.0.1::${VNC_PORT}`,
        "-e", `OSB_WIDTH=${a.width}`,
        "-e", `OSB_HEIGHT=${a.height}`,
        "-e", `OSB_MEMORY=${a.memory_mb}`,
        "-e", `OSB_CPUS=${a.cpus}`,
      ];
      if (existsSync("/dev/kvm")) args.push("--device", "/dev/kvm");
      if (a.workspace) {
        const dir = path.resolve(a.workspace);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new ToolError(`workspace ${dir} is not a directory`);
        }
        args.push("-v", `${dir}:/workspace`);
      }
      args.push(a.image ?? IMAGE);
      await docker(args);
    }
    const info: Record<string, unknown> = {
      sandbox: a.sandbox,
      container: name,
      resumed: state === "stopped",
      already_running: state === "running",
      vnc: await vncAddress(a.sandbox),
    };
    if (!a.wait) return json(info);
    const r = await osbRaw(a.sandbox, ["wait", "--timeout", String(a.timeout)], { timeoutMs: (a.timeout + 30) * 1000 });
    if (r.code !== 0) {
      const serial = await run(DOCKER, ["exec", name, "tail", "-n", "40", "/run/osb/serial.log"]);
      const logs = await run(DOCKER, ["logs", "--tail", "40", name]);
      throw new ToolError(
        `${r.stderr.trim()}\n\n--- container log ---\n${logs.stdout}${logs.stderr}\n--- serial console ---\n${serial.stdout}`,
      );
    }
    info.status = JSON.parse(r.stdout.toString());
    return json(info);
  }),
);

server.registerTool(
  "sandbox_stop",
  {
    title: "Stop sandbox",
    description: "Power off a sandbox and (by default) delete it, discarding everything that happened in it.",
    inputSchema: {
      sandbox,
      keep: z.boolean().default(false).describe("Keep the stopped container so sandbox_start can resume it"),
    },
  },
  tool(async (a) => {
    const name = containerName(a.sandbox);
    if ((await containerState(a.sandbox)) === "missing") return text(`sandbox "${a.sandbox}" does not exist`);
    await docker(["stop", "-t", "30", name], { timeoutMs: 60_000 });
    if (!a.keep) await docker(["rm", name]);
    return text(a.keep ? `stopped ${a.sandbox}` : `stopped and removed ${a.sandbox}`);
  }),
);

server.registerTool(
  "sandbox_list",
  {
    title: "List sandboxes",
    description: "List sandbox containers with their state and VNC address.",
    inputSchema: {},
  },
  tool(async () => {
    const r = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{json .}}"]);
    const rows = r.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .map((c) => ({
        sandbox: c.Names.replace(/^osb-/, ""),
        state: c.State,
        status: c.Status,
        image: c.Image,
        ports: c.Ports,
      }));
    return json(rows);
  }),
);

server.registerTool(
  "status",
  {
    title: "Sandbox status",
    description: "Report whether the VM, SSH, Hyprland and the Omarchy shell are up, plus screen size and VNC address.",
    inputSchema: { sandbox },
  },
  tool(async (a) => {
    const r = await osb(a.sandbox, ["status"], { timeoutMs: 60_000 });
    return json({ ...JSON.parse(r.stdout.toString()), vnc: await vncAddress(a.sandbox) });
  }),
);

server.registerTool(
  "wait",
  {
    title: "Wait for desktop",
    description: "Block until the sandbox desktop is ready (e.g. after rebooting the guest).",
    inputSchema: {
      sandbox,
      timeout: z.number().int().positive().default(180),
      require_shell: z.boolean().default(true).describe("Also wait for the Omarchy bar/shell"),
    },
  },
  tool(async (a) => {
    const args = ["wait", "--timeout", String(a.timeout)];
    if (!a.require_shell) args.push("--no-shell");
    const r = await osb(a.sandbox, args, { timeoutMs: (a.timeout + 30) * 1000 });
    return text(r.stdout.toString().trim());
  }),
);

server.registerTool(
  "sandbox_logs",
  {
    title: "Sandbox logs",
    description: "Tail the VM serial console and the container log; optionally the guest's systemd journal.",
    inputSchema: {
      sandbox,
      lines: z.number().int().positive().default(60),
      journal: z.boolean().default(false).describe("Include `journalctl -b` from the guest"),
    },
  },
  tool(async (a) => {
    const name = containerName(a.sandbox);
    const n = String(a.lines);
    const logs = await run(DOCKER, ["logs", "--tail", n, name]);
    const serial = await run(DOCKER, ["exec", name, "tail", "-n", n, "/run/osb/serial.log"]);
    let out = `--- container log ---\n${logs.stdout}${logs.stderr}\n--- serial console ---\n${serial.stdout}${serial.stderr}`;
    if (a.journal) {
      const j = await osbRaw(a.sandbox, ["exec", "--no-session", "--", `journalctl -b --no-pager -n ${n}`]);
      out += `\n--- guest journal ---\n${j.stdout}${j.stderr}`;
    }
    return text(clip(out));
  }),
);

// ---- looking ---------------------------------------------------------------

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      "Capture the sandbox screen as a PNG. With no options it grabs the whole virtual display (works even on the " +
      "login screen); region or window crop it. Pointer coordinates are full-screen pixels.",
    inputSchema: {
      sandbox,
      region: z
        .object({ x: coord, y: coord, width: z.number().int().positive(), height: z.number().int().positive() })
        .optional()
        .describe("Crop to this rectangle of the screen"),
      window: windowMatch.optional().describe("Crop to this window (address or class/title regex)"),
    },
  },
  tool(async (a) => {
    const extra: string[] = [];
    if (a.region) extra.push("--region", `${a.region.x},${a.region.y},${a.region.width}x${a.region.height}`);
    else if (a.window) extra.push("--window", a.window);
    return { content: await screenshotContent(a.sandbox, extra) };
  }),
);

// ---- input -----------------------------------------------------------------

server.registerTool(
  "click",
  {
    title: "Click",
    description: "Move the pointer to (x, y) and click.",
    inputSchema: {
      sandbox,
      x: coord,
      y: coord,
      button,
      count: z.number().int().min(1).max(3).default(1).describe("2 for a double-click"),
      modifiers: z.array(z.string()).default([]).describe('Keys to hold while clicking, e.g. ["ctrl"]'),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    const args = ["click", String(a.x), String(a.y), "--button", a.button, "--count", String(a.count)];
    for (const m of a.modifiers) args.push("--mod", m);
    await osb(a.sandbox, args);
    return afterInput(a.sandbox, a.screenshot, `clicked ${a.button} at ${a.x},${a.y}`);
  }),
);

server.registerTool(
  "move",
  {
    title: "Move pointer",
    description: "Move the pointer to (x, y) without clicking (hover).",
    inputSchema: { sandbox, x: coord, y: coord, screenshot: screenshotAfter },
  },
  tool(async (a) => {
    await osb(a.sandbox, ["move", String(a.x), String(a.y)]);
    return afterInput(a.sandbox, a.screenshot, `moved to ${a.x},${a.y}`);
  }),
);

server.registerTool(
  "mouse_button",
  {
    title: "Press or release mouse button",
    description: "Press or release a mouse button, optionally moving to (x, y) first. Use for long presses.",
    inputSchema: {
      sandbox,
      action: z.enum(["down", "up"]),
      x: coord.optional(),
      y: coord.optional(),
      button,
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    const args = [a.action === "down" ? "mousedown" : "mouseup"];
    if (a.x !== undefined && a.y !== undefined) args.push(String(a.x), String(a.y));
    args.push("--button", a.button);
    await osb(a.sandbox, args);
    return afterInput(a.sandbox, a.screenshot, `${a.button} ${a.action}`);
  }),
);

server.registerTool(
  "drag",
  {
    title: "Drag",
    description: "Press at (x1, y1), move smoothly to (x2, y2) and release.",
    inputSchema: {
      sandbox,
      x1: coord,
      y1: coord,
      x2: coord,
      y2: coord,
      button,
      steps: z.number().int().min(1).max(200).default(20),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    await osb(a.sandbox, [
      "drag", String(a.x1), String(a.y1), String(a.x2), String(a.y2),
      "--button", a.button, "--steps", String(a.steps),
    ]);
    return afterInput(a.sandbox, a.screenshot, `dragged ${a.x1},${a.y1} -> ${a.x2},${a.y2}`);
  }),
);

server.registerTool(
  "scroll",
  {
    title: "Scroll",
    description: "Scroll the mouse wheel by notches, optionally at (x, y). Positive dy scrolls down, positive dx right.",
    inputSchema: {
      sandbox,
      x: coord.optional(),
      y: coord.optional(),
      dy: z.number().int().default(0),
      dx: z.number().int().default(0),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    const args = ["scroll"];
    if (a.x !== undefined && a.y !== undefined) args.push(String(a.x), String(a.y));
    args.push("--dy", String(a.dy), "--dx", String(a.dx));
    await osb(a.sandbox, args);
    return afterInput(a.sandbox, a.screenshot, `scrolled dy=${a.dy} dx=${a.dx}`);
  }),
);

server.registerTool(
  "key",
  {
    title: "Press keys",
    description:
      'Press key combos in order, e.g. ["super+return"], ["ctrl+shift+t"], ["escape"]. Names: ctrl, shift, alt, ' +
      "super, return, escape, tab, space, backspace, delete, up/down/left/right, home, end, pageup, pagedown, f1-f12, letters, digits, punctuation.",
    inputSchema: {
      sandbox,
      keys: z.array(z.string()).min(1),
      repeat: z.number().int().min(1).max(100).default(1),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    await osb(a.sandbox, ["key", "--repeat", String(a.repeat), "--", ...a.keys]);
    return afterInput(a.sandbox, a.screenshot, `pressed ${a.keys.join(" ")}`);
  }),
);

server.registerTool(
  "type",
  {
    title: "Type text",
    description: "Type text into the focused window as keyboard input (newlines press Return).",
    inputSchema: {
      sandbox,
      text: z.string(),
      delay_ms: z.number().min(0).max(1000).default(12).describe("Delay between keys"),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    await osb(a.sandbox, ["type", "--delay", String(a.delay_ms)], {
      input: a.text,
      timeoutMs: 60_000 + a.text.length * (a.delay_ms + 20),
    });
    return afterInput(a.sandbox, a.screenshot, `typed ${a.text.length} characters`);
  }),
);

// ---- commands and apps -----------------------------------------------------

server.registerTool(
  "exec",
  {
    title: "Run command",
    description:
      "Run a bash command in the guest as the desktop user, inside the live Hyprland session " +
      "(WAYLAND_DISPLAY, hyprctl and omarchy-* commands work). Returns exit code, stdout and stderr. " +
      "Don't use it for long-running GUI apps; use launch.",
    inputSchema: {
      sandbox,
      command: z.string().describe("bash command line"),
      cwd: z.string().optional(),
      root: z.boolean().default(false).describe("Run with sudo"),
      timeout: z.number().int().positive().default(120).describe("Seconds"),
      session: z.boolean().default(true).describe("Attach to the Hyprland session environment"),
    },
  },
  tool(async (a) => {
    const args = ["exec", "--timeout", String(a.timeout)];
    if (a.cwd) args.push("--cwd", a.cwd);
    if (a.root) args.push("--root");
    if (!a.session) args.push("--no-session");
    args.push("--", a.command);
    const r = await osbRaw(a.sandbox, args, { timeoutMs: (a.timeout + 30) * 1000 });
    const out = r.stdout.toString();
    const result: CallToolResult = json({
      exit_code: r.code,
      stdout: clip(out),
      stderr: clip(r.stderr),
    });
    return r.code === 124 ? { ...result, isError: true } : result;
  }),
);

server.registerTool(
  "launch",
  {
    title: "Launch app",
    description:
      "Start a GUI app (or any long-running command) detached in the desktop session, with output logged to a file. " +
      "Waits for a new window to appear and returns its details, the pid and the log path (read it with exec).",
    inputSchema: {
      sandbox,
      command: z.string().describe("bash command line, e.g. 'alacritty' or './build/myapp --debug'"),
      cwd: z.string().optional(),
      wait: z.number().min(0).default(15).describe("Seconds to wait for a new window (0 = don't wait)"),
      match: z.string().optional().describe("Regex the new window's class or title must match"),
      name: z.string().optional().describe("Prefix for the log file name"),
      screenshot: screenshotAfter,
    },
  },
  tool(async (a) => {
    const args = ["launch"];
    if (a.cwd) args.push("--cwd", a.cwd);
    if (a.wait > 0) args.push("--wait", String(a.wait));
    if (a.match) args.push("--match", a.match);
    if (a.name) args.push("--name", a.name);
    args.push("--", a.command);
    const r = await osb(a.sandbox, args, { timeoutMs: (a.wait + 60) * 1000 });
    return afterInput(a.sandbox, a.screenshot, r.stdout.toString().trim());
  }),
);

server.registerTool(
  "windows",
  {
    title: "List windows",
    description: "List open windows: address, class, title, pid, workspace, position and size, focus.",
    inputSchema: { sandbox },
  },
  tool(async (a) => text((await osb(a.sandbox, ["windows"])).stdout.toString().trim())),
);

server.registerTool(
  "wait_window",
  {
    title: "Wait for window",
    description: "Wait until a window whose class or title matches the regex exists, and return it.",
    inputSchema: {
      sandbox,
      match: z.string().describe("Case-insensitive regex for class or title"),
      timeout: z.number().positive().default(30),
    },
  },
  tool(async (a) => {
    const r = await osb(a.sandbox, ["wait-window", "--timeout", String(a.timeout), "--", a.match], {
      timeoutMs: (a.timeout + 30) * 1000,
    });
    return text(r.stdout.toString().trim());
  }),
);

server.registerTool(
  "focus_window",
  {
    title: "Focus window",
    description: "Focus a window (switching workspace if needed).",
    inputSchema: { sandbox, match: windowMatch, screenshot: screenshotAfter },
  },
  tool(async (a) => {
    const r = await osb(a.sandbox, ["focus", "--", a.match]);
    return afterInput(a.sandbox, a.screenshot, r.stdout.toString().trim());
  }),
);

server.registerTool(
  "close_window",
  {
    title: "Close window",
    description: "Ask a window to close, or kill its process.",
    inputSchema: {
      sandbox,
      match: windowMatch,
      kill: z.boolean().default(false).describe("SIGKILL the owning process instead of closing politely"),
    },
  },
  tool(async (a) => {
    const args = ["close", "--", a.match];
    if (a.kill) args.splice(1, 0, "--kill");
    return text((await osb(a.sandbox, args)).stdout.toString().trim());
  }),
);

// ---- files -----------------------------------------------------------------

async function withScratch<T>(sandbox: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = `/tmp/osb-xfer-${randomBytes(6).toString("hex")}`;
  const name = containerName(sandbox);
  await docker(["exec", name, "mkdir", "-p", dir]);
  try {
    return await fn(dir);
  } finally {
    await run(DOCKER, ["exec", name, "rm", "-rf", dir]);
  }
}

server.registerTool(
  "push",
  {
    title: "Copy into sandbox",
    description:
      "Copy a file or directory from the host into the guest (owned by the desktop user). " +
      "Relative guest paths are relative to the user's home.",
    inputSchema: {
      sandbox,
      host_path: z.string(),
      guest_path: z.string(),
    },
  },
  tool(async (a) => {
    const src = path.resolve(a.host_path);
    if (!existsSync(src)) throw new ToolError(`${src} does not exist`);
    await withScratch(a.sandbox, async (dir) => {
      await docker(["cp", src, `${containerName(a.sandbox)}:${dir}/`], { timeoutMs: 600_000 });
      await osb(a.sandbox, ["push", `${dir}/${path.basename(src)}`, a.guest_path], { timeoutMs: 600_000 });
    });
    return text(`copied ${src} to guest:${a.guest_path}`);
  }),
);

server.registerTool(
  "pull",
  {
    title: "Copy out of sandbox",
    description: "Copy a file or directory from the guest to the host (e.g. logs, screenshots, build output).",
    inputSchema: {
      sandbox,
      guest_path: z.string(),
      host_path: z.string(),
    },
  },
  tool(async (a) => {
    const dest = path.resolve(a.host_path);
    const base = path.posix.basename(a.guest_path.replace(/\/+$/, ""));
    await withScratch(a.sandbox, async (dir) => {
      await osb(a.sandbox, ["pull", a.guest_path, `${dir}/`], { timeoutMs: 600_000 });
      await docker(["cp", `${containerName(a.sandbox)}:${dir}/${base}`, dest], { timeoutMs: 600_000 });
    });
    return text(`copied guest:${a.guest_path} to ${dest}`);
  }),
);

// --------------------------------------------------------------------------

await server.connect(new StdioServerTransport());
