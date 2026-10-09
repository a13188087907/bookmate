/* 书友设置页逻辑：读 /api/settings 渲染（模型下拉动态来自 model:list），
   保存 PUT 回写；人格框预填当前生效文本（已存值或内置默认），清空保存即恢复内置。 */
import { hana } from "./sdk.js";

const ticket = new URLSearchParams(location.search).get("appSurfaceSession") || "";
const apiBase = "/api/apps/bookmate/routes";

async function api(path, options = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${apiBase}${path}${sep}appSurfaceSession=${encodeURIComponent(ticket)}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const $ = (id) => document.getElementById(id);
let defaultPersona = "";

async function boot() {
  await window.__hanaReady;
  try {
    const s = await api("/api/settings");
    defaultPersona = s.defaultPersona || "";
    $("pythonCommand").value = s.pythonCommand || "python";
    $("exportDir").value = s.exportDir || "";
    /* 模型下拉：跟随焦点 + 目录全量；已存值不在目录时也列出（标记失效） */
    const sel = $("companionModel");
    sel.textContent = "";
    const follow = document.createElement("option");
    follow.value = "";
    const current = s.models.find((m) => m.isCurrent);
    follow.textContent = `跟随当前焦点模型${current ? `（${current.name}）` : ""}`;
    sel.append(follow);
    let savedHit = !s.companionModel;
    for (const m of s.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} · ${m.provider}`;
      if (s.companionModel && (m.id === s.companionModel || `${m.provider}/${m.id}` === s.companionModel || m.name === s.companionModel)) {
        opt.selected = true;
        savedHit = true;
      }
      sel.append(opt);
    }
    if (!savedHit) {
      const opt = document.createElement("option");
      opt.value = s.companionModel;
      opt.textContent = `${s.companionModel}（目录中未找到）`;
      opt.selected = true;
      sel.append(opt);
    }
    /* 人格：已存值优先，否则预填内置默认（用户就在原文上改） */
    $("companionPersona").value = s.companionPersona || defaultPersona;
    $("personaCount").textContent = `内置约 ${defaultPersona.length} 字`;
  } catch (err) {
    const box = $("loadError");
    box.hidden = false;
    box.textContent = `设置载入失败：${err.message}`;
  }
}

$("resetPersona").addEventListener("click", () => {
  $("companionPersona").value = defaultPersona;
  $("saveState").textContent = "";
});

$("saveBtn").addEventListener("click", async () => {
  const btn = $("saveBtn");
  const state = $("saveState");
  btn.disabled = true;
  state.className = "save-state";
  state.textContent = "保存中…";
  try {
    /* 人格与内置一致时按留空存（跟随内置升级），不同才存覆盖值 */
    const persona = $("companionPersona").value.trim();
    await api("/api/settings", {
      method: "PUT",
      body: {
        pythonCommand: $("pythonCommand").value.trim() || "python",
        exportDir: $("exportDir").value.trim(),
        companionModel: $("companionModel").value,
        companionPersona: persona === defaultPersona.trim() ? "" : persona,
      },
    });
    state.className = "save-state ok";
    state.textContent = "已保存";
    setTimeout(() => { state.textContent = ""; }, 3000);
  } catch (err) {
    state.className = "save-state err";
    state.textContent = `保存失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

boot();
