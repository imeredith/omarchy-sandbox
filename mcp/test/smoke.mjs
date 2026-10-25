// Smoke test: drive a sandbox through the MCP server like an agent would.
//
//   node test/smoke.mjs [sandbox]      (default "smoke"; started and stopped here
//                                       unless it is already running)
//
// Needs the image built (OSB_IMAGE, default omarchy-sandbox:latest) and `npm run build`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sandbox = process.argv[2] ?? "smoke";
const server = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const client = new Client({ name: "omarchy-sandbox-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: "inherit" }));

async function call(name, args = {}) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: { sandbox, ...args } }, undefined, { timeout: 600_000 });
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const images = r.content.filter((c) => c.type === "image");
  console.log(`${r.isError ? "ERROR" : "ok   "} ${name} (${Date.now() - t0} ms)${images.length ? ` [${images.length} image]` : ""}`);
  if (r.isError) throw new Error(`${name}: ${texts}`);
  return { text: texts, images };
}

const json = (r) => JSON.parse(r.text);
const tmp = mkdtempSync(path.join(tmpdir(), "osb-smoke-"));
const before = json(await call("sandbox_list"));
const ownSandbox = !before.some((s) => s.sandbox === sandbox && s.state === "running");

try {
  const start = json(await call("sandbox_start", { memory_mb: 3072, cpus: 2 }));
  assert.ok(start.vnc?.startsWith("127.0.0.1:"), "VNC is published on localhost");
  const st = json(await call("status"));
  assert.ok(st.hyprland && st.shell, "desktop is up");

  const shot = await call("screenshot");
  assert.equal(shot.images[0].mimeType, "image/png");
  writeFileSync(path.join(tmp, "desktop.png"), Buffer.from(shot.images[0].data, "base64"));

  const ex = json(await call("exec", { command: "echo hi; echo oops >&2; exit 3" }));
  assert.deepEqual([ex.exit_code, ex.stdout, ex.stderr], [3, "hi\n", "oops\n"]);
  assert.equal(json(await call("exec", { command: "pwd", cwd: "/etc" })).stdout, "/etc\n");

  const app = json(await call("launch", { command: "foot --app-id smoke-term", cwd: "/tmp", match: "smoke-term" }));
  assert.equal(app.windows?.length, 1, "launch reports the new window");
  const win = app.windows[0];
  // Click inside the window, type a command and check its effect.
  await call("click", { x: win.at[0] + 50, y: win.at[1] + 50 });
  await call("type", { text: "pwd > ~/smoke-pwd.txt\n" });
  await call("key", { keys: ["ctrl+l"], screenshot: true });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(json(await call("exec", { command: "cat ~/smoke-pwd.txt" })).stdout, "/tmp\n");

  await call("scroll", { x: win.at[0] + 50, y: win.at[1] + 50, dy: -3 });
  await call("drag", { x1: 100, y1: 300, x2: 400, y2: 300 });
  await call("move", { x: 10, y: 400 });
  const crop = await call("screenshot", { window: "smoke-term" });
  assert.ok(crop.images.length === 1);

  assert.ok(json(await call("windows")).some((w) => w.class === "smoke-term"));
  await call("focus_window", { match: "smoke-term" });
  await call("wait_window", { match: "smoke-term", timeout: 5 });

  writeFileSync(path.join(tmp, "in.txt"), "from host\n");
  await call("push", { host_path: path.join(tmp, "in.txt"), guest_path: "in.txt" });
  assert.equal(json(await call("exec", { command: "cat ~/in.txt; stat -c %U ~/in.txt" })).stdout, "from host\nomarchy\n");
  await call("pull", { guest_path: "smoke-pwd.txt", host_path: path.join(tmp, "out.txt") });
  assert.equal(readFileSync(path.join(tmp, "out.txt"), "utf8"), "/tmp\n");

  await call("close_window", { match: "smoke-term" });
  await call("sandbox_logs", { lines: 5 });
  console.log(`all good; screenshots in ${tmp}`);
} finally {
  if (ownSandbox) await call("sandbox_stop").catch((e) => console.error(e.message));
  await client.close();
}
