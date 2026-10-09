/**
 * 书友专用人格 agent 的创建与复用（v2 正式路径）。
 *
 * 主路径：应用内嵌角色包 roles/shuyou/card.json，经 agent:create-from-role 实例化。
 * 宿主在首次写配置时打下 ownerPluginId / visibility=plugin_private / roleId 元数据，
 * 创建出的 agent 归属本应用，不进入用户主花名册的公共分区。
 *
 * 兜底：角色包不可用（老宿主或注册异常）时退到 v2 原生 agent:create
 * （仅传 name/yuan/kind/initialFiles.identity；owner 与 visibility 由宿主补打）。
 *
 * 创建结果写入配置 companionAgentId（routes 两个 converse 路由以此为准）。
 * 任何失败只记 warn、返回 null：对话回退默认助手，功能不受影响。
 */

const COMPANION_AGENT_NAME = "书友";
const COMPANION_ROLE_ID = "shuyou";

/* 兜底人格：与 roles/shuyou/card.json 的 prompts.agents 保持一致 */
const COMPANION_AGENT_IDENTITY = [
  "你叫书友，是一位和读者并肩读书的伙伴。你认真读过这本书，有自己的理解。",
  "你的第一职责是答疑：读者问什么，就先把什么解释清楚。解释时用大白话，用类比和具体例子，把抽象概念落到地面上。",
  "当读者表达自己的观点时，你再进入讨论：回应他的观点，补充他可能没看到的视角，必要时追问一句。",
  "读者没有发起讨论时，你不反驳、不抬杠、不反问。回答完就停在回答上，不给每段话接一个挑战的尾巴。",
  "说话像朋友，用中文，不用 Markdown。",
].join("\n");

/* 进行中的创建任务：并发调用共享同一个 promise，防重复创建 */
let inflight = null;

/**
 * 确保专用「书友」agent 存在，返回其 agentId；失败返回 null（不抛错）。
 * 配置已有值 → 直接复用（唯一事实源，含用户手填）；
 * 配置为空 → 查重后创建并写回配置。
 */
export async function ensureCompanionAgent(runtime) {
  const { bus, config, log } = runtime;
  if (!bus?.request) return null;

  try {
    const configured = await config?.get?.("companionAgentId");
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  } catch {
    // 配置读失败：继续尝试创建
  }

  if (inflight) return inflight;
  inflight = createCompanionAgent(runtime).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function createCompanionAgent({ bus, config, log }) {
  /* 防重复：本应用分区里已建过书友（按 roleId 或名字认）则复用其 id 写配置 */
  try {
    const listRes = await bus.request("agent:list", { scope: "own", lifecycle: "active" });
    const hit = (listRes?.agents ?? []).find(
      (a) => a?.id && (a?.plugin?.roleId === COMPANION_ROLE_ID || a?.name === COMPANION_AGENT_NAME),
    );
    if (hit) {
      await writeConfig(config, "companionAgentId", hit.id, log);
      log?.info?.(`书友：复用已有专用 agent ${hit.id}`);
      return hit.id;
    }
  } catch (err) {
    log?.warn?.(`书友：专用 agent 查重失败（${err.message}），继续尝试创建`);
  }

  /* 主路径：从内嵌角色包实例化（人格、头像随应用包分发，宿主托管模板） */
  try {
    const res = await bus.request("agent:create-from-role", {
      roleId: COMPANION_ROLE_ID,
      name: COMPANION_AGENT_NAME,
    });
    const id = res?.agent?.id ?? res?.id;
    if (!id) throw new Error("宿主返回无 agent id");
    await writeConfig(config, "companionAgentId", id, log);
    log?.info?.(`书友：已从角色包 ${COMPANION_ROLE_ID} 创建专用 agent ${id}`);
    return id;
  } catch (err) {
    log?.warn?.(`书友：角色包创建失败（${err.message}），退到原生 agent:create`);
  }

  /* 兜底：v2 原生创建，ownerPluginId 与 plugin_private 由宿主补打 */
  try {
    const res = await bus.request("agent:create", {
      name: COMPANION_AGENT_NAME,
      yuan: "hanako",
      kind: "bookmate",
      initialFiles: { identity: COMPANION_AGENT_IDENTITY },
    });
    const id = res?.agent?.id ?? res?.id;
    if (!id) throw new Error("宿主返回无 agent id");
    await writeConfig(config, "companionAgentId", id, log);
    log?.info?.(`书友：已创建专用 agent ${id}（原生路径）`);
    return id;
  } catch (err) {
    log?.warn?.(`书友：专用 agent 创建失败（${err.message}）`);
  }
  return null;
}

async function writeConfig(config, key, value, log) {
  try {
    await config?.set?.(key, value);
  } catch (err) {
    // 配置写入失败不阻断：agent 已建好，下次 ensure 会查重复用
    log?.warn?.(`书友：agent 配置写入失败（${err.message}）`);
  }
}
