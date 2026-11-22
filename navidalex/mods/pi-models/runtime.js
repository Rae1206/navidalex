// The live Pi's published metadata (models, commands, session) for a terminal, written by
// ~/.pi/agent/extensions/herdr-chat-session.js. Mods can't import outside their own folder,
// so this mirrors runtimeMetadata in mods/any-chat/agents.js: keep the two in step.

import { exec, hc, appHome, panes, agents, readTextFile, writeTextFile } from "herdr";
import { readFile } from "fs/promises";
import { controlBinding, submitControl } from "./control.js";

const localId = /^[a-zA-Z0-9_-]{1,128}$/;

async function terminalInfo(address) {
  const t = JSON.parse((await hc(["get", address, "--json"])).stdout);
  return { pid: t.pid, foregroundPid: t.foreground?.pid };
}

// A bridge file is named by the terminal address (herdr-app: HC_TERMINAL_ID) or by the Herdr
// pane id (Herdr TUI: HERDR_PANE_ID); its own "pane" field must name the same key.
async function readBridge(address, suffix) {
  const pane = panes().find(p => p.terminal === address)?.pane ?? agents().find(a => a.address === address)?.pane;
  for (const key of new Set([address, pane])) {
    if (typeof key !== "string" || !localId.test(key)) continue;
    try {
      const data = JSON.parse(await readFile(`${appHome()}/data/any-chat/sessions/${key}${suffix}`, "utf8"));
      if (data?.pane === key) return data;
    } catch {}
  }
  return null;
}

// Metadata is pane-specific and checked against the terminal's live process tree.
export async function runtimeMetadata(address) {
  if (typeof address !== "string" || !localId.test(address)) return null;
  const data = await readBridge(address, ".json");
  if (!data || data.version !== 1 || !Number.isSafeInteger(data.pid) || data.pid <= 0
    || !data.id || !Number.isSafeInteger(data.updated) || data.updated > Date.now() + 1000
    || Date.now() - data.updated > 35000) return null;
  const info = await terminalInfo(address);
  const pid = info.foregroundPid || info.pid;
  if (data.pid !== pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    const check = await exec("powershell", ["-NoProfile", "-Command",
      `$n=${data.pid}; for($i=0;$i -lt 32 -and $n -gt 0;$i++){ if($n -eq ${pid}){exit 0}; $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$n\"; if(!$p){exit 1}; $n=$p.ParentProcessId }; exit 1`], { timeout: 5000 });
    if (check.code !== 0) return null;
  }
  return data;
}

export function applyControl(address, runtime, action, value, sleep, alive) {
  const binding = controlBinding(runtime);
  if (!binding) return Promise.resolve({ status: "unavailable" });
  const path = `${appHome()}/data/any-chat/sessions/${binding.pane}.control.json`;
  return submitControl({ runtime, action, value, sleep, alive,
    readRuntime: () => runtimeMetadata(address),
    readSlot: () => readTextFile(path),
    writeSlot: (request, expected) => writeTextFile(path, request, expected),
  });
}
