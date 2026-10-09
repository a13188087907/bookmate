import fs from "node:fs/promises";
import path from "node:path";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 剥离 agent 人格层注入的内部标记（如 <mood> 内心独白块），
   这些在宿主主界面会被特殊渲染，经 session 通道取回复时混入正文。 */
function stripInternalMarkers(text) {
  return String(text)
    .replace(/<mood>[\s\S]*?<\/mood>/gi, "")
    .replace(/<\/?think(?:ing)?>[\s\S]*?<\/?think(?:ing)?>/gi, "")
    .trim();
}

/**
 * 书友对话的真助手通道。
 *
 * 相比 model:sample-text（轻量 utility 调用），这条路走宿主完整 agent 会话：
 *   session:create —— 为每本书 + 每个助手创建一个插件私有会话（完整人格/工具/记忆）
 *   session:send  —— 带 context 注入（章节上下文/引用）发送用户消息，agent 完整处理
 *   session:history —— 轮询直到新回复出现
 *
 * 会话映射持久化在 dataDir/sessions.json：{ [bookId]: { [agentId]: { sid, path } } }
 * v2 宿主按 sessionId 解析会话；旧版字符串条目按 legacy sessionPath 兼容读取，失效后重建。
 */
export class SessionCompanion {
  constructor({ bus, dataDir, pluginId, log }) {
    this.bus = bus;
    this.dataDir = dataDir;
    this.pluginId = pluginId;
    this.log = log;
    this.indexFile = path.join(dataDir, "sessions.json");
    this.sessions = {};
    /* 活跃的事件订阅：onunload/重载时统一退订，防泄漏 */
    this._subs = new Set();
  }

  /** 插件卸载/重载时调用：释放全部进行中的事件订阅 */
  dispose() {
    for (const unsub of this._subs) {
      try {
        unsub();
      } catch {}
    }
    this._subs.clear();
  }

  async init() {
    try {
      this.sessions = JSON.parse(await fs.readFile(this.indexFile, "utf8"));
    } catch {
      this.sessions = {};
    }
  }

  async saveIndex() {
    await fs.writeFile(this.indexFile, JSON.stringify(this.sessions, null, 2), "utf8");
  }

  get agentIds() {
    return Object.keys(this.sessions);
  }

  /** 获取（或创建）某本书在指定助手下的私有会话，返回宿主请求用的会话定位 */
  async getSession(bookId, agentId = null) {
    const key = agentId || "default";
    const target = targetOf(this.sessions[bookId]?.[key]);
    if (target) {
      try {
        const got = await this.bus.request("session:get", { ...target });
        if (got?.session) return target;
      } catch {
        // 会话可能已失效，继续走创建
      }
    }
    const created = await this.bus.request("session:create", {
      ...(agentId ? { agentId } : {}),
      ownerPluginId: this.pluginId,
      visibility: "plugin_private",
      kind: "bookmate",
      memoryEnabled: false,
    });
    const sid = created?.sessionId ?? created?.session?.sessionId ?? null;
    const path = created?.sessionPath ?? created?.path ?? null;
    if (!sid && !path) {
      throw new Error("宿主会话创建失败");
    }
    this.sessions[bookId] = this.sessions[bookId] || {};
    this.sessions[bookId][key] = { sid, path };
    await this.saveIndex();
    return targetOf(this.sessions[bookId][key]);
  }

  /** 发送消息并等待完整回复（优先事件订阅，退化为 800ms 轮询） */
  async converse({ bookId, agentId = null, userMessage, context = null, timeoutMs = 150000 }) {
    const target = await this.getSession(bookId, agentId);
    if (typeof this.bus?.subscribe === "function") {
      return this._converseByEvent({ target, userMessage, context, timeoutMs });
    }
    return this._converseByPolling({ target, userMessage, context, timeoutMs });
  }

  /**
   * 流式对话：回复边生成边回调。
   *
   * 探测结论（宿主 0.447.4）：assistant 消息一次性完整落盘，会话事件只携带最终完整回复，
   * 无流式增量、session:history 看不到生成中消息 → 本方法以单个 delta 回调完整回复
   * （前端表现等价现状，不更差）。保留增量转发能力：未来宿主若发出内容递增的事件/消息，
   * 后缀 diff 会自动产出逐段 delta。
   *
   * 降级链：事件路径（后缀 diff）→ 轮询路径（300ms 后缀 diff）→ 兜底：最终回复单 delta。
   *
   * @param {object} opts
   * @param {(delta: string) => void} opts.onDelta 增量回调（每次追加的文本段）
   * @returns {Promise<string>} 完整回复（已剥内部标记）；失败 reject
   */
  async converseStream({ bookId, agentId = null, userMessage, context = null, timeoutMs = 150000, onDelta }) {
    const target = await this.getSession(bookId, agentId);
    if (typeof this.bus?.subscribe === "function") {
      return this._streamByEvent({ target, userMessage, context, timeoutMs, onDelta });
    }
    return this._streamByPolling({ target, userMessage, context, timeoutMs, onDelta });
  }

  /**
   * 流式·事件路径：订阅会话事件，事件内容经 stripInternalMarkers 后做后缀 diff 回调增量。
   * 当前宿主事件只发一次完整回复 → 单个 delta；事件到达后观察 300ms 无新内容视为完成。
   * 150s 超时语义与 _converseByEvent 一致（先 history 确认再报超时）。
   */
  async _streamByEvent({ target, userMessage, context, timeoutMs, onDelta }) {
    const before = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
    const beforeCount = before?.messages?.length ?? 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsub = null;
      let accumulated = "";
      let settleTimer = null;

      const cleanup = () => {
        if (unsub && this._subs.has(unsub)) {
          this._subs.delete(unsub);
          try {
            unsub();
          } catch {}
          unsub = null;
        }
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(settleTimer);
        cleanup();
        fn(value);
      };

      /* 后缀 diff：内容有新增 → 回调新增段；内容被重写 → 整段回调（前端覆盖） */
      const pushFull = (text) => {
        const t = String(text);
        if (t === accumulated) return;
        const delta = t.startsWith(accumulated) ? t.slice(accumulated.length) : t;
        accumulated = t;
        if (delta) onDelta?.(delta);
      };

      /* 事件到达后观察 300ms：期间无新内容 → 视为完成（当前宿主即此形态）；
         未来有增量事件流则每次到达都会重置窗口，逐段输出 */
      const armSettle = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          // 内容剥壳后可能为空（如回复全是内部标记块）：也 settle，避免卡到超时
          if (!settled) settle(resolve, accumulated);
        }, 300);
      };

      // 150s 超时：事件可能漏发，先用 history 确认一次，确认不到再报超时
      const timer = setTimeout(async () => {
        if (settled) return;
        try {
          const hist = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
          const msgs = hist?.messages ?? [];
          if (msgs.length > beforeCount) {
            for (let i = msgs.length - 1; i >= beforeCount; i--) {
              const m = msgs[i];
              if (m.role === "assistant" && m.content) {
                const full = stripInternalMarkers(m.content);
                if (full && full !== accumulated) {
                  pushFull(full);
                  return armSettle();
                }
                return settle(resolve, full || accumulated);
              }
            }
          }
        } catch {}
        settle(reject, new Error("书友思考太久，请稍后再试"));
      }, timeoutMs);

      // 先订阅再发送，避免漏掉快速回复的事件
      unsub = this.bus.subscribe(
        (event, scopedSessionPath) => {
          if (settled) return;
          // 归属双重校验：宿主 filter 已按 sessionPath 匹配，这里再验 scoped 与事件内嵌 path，防串会话
          if (!matchSessionEvent(target, scopedSessionPath, event)) return;
          const content = extractAssistantContent(event);
          if (!content) return; // 中间态/无文本事件：忽略，继续等最终回复
          pushFull(stripInternalMarkers(content));
          armSettle();
        },
        { ...target },
      );
      this._subs.add(unsub);

      this.bus
        .request("session:send", {
          text: userMessage,
          ...target,
          ...(context ? { context } : {}),
        })
        .catch((err) => settle(reject, err));
    });
  }

  /**
   * 流式·轮询路径：bus.subscribe 不可用时走老路（300ms 轮询 history）。
   * 对新增 assistant 消息内容做后缀 diff 回调增量；同一内容连续两轮稳定（600ms）视为完成。
   */
  async _streamByPolling({ target, userMessage, context, timeoutMs, onDelta }) {
    const before = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
    const beforeCount = before?.messages?.length ?? 0;

    await this.bus.request("session:send", {
      text: userMessage,
      ...target,
      ...(context ? { context } : {}),
    });

    const deadline = Date.now() + timeoutMs;
    let accumulated = "";
    let stableRounds = 0;
    while (Date.now() < deadline) {
      await sleep(300);
      const hist = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
      const msgs = hist?.messages ?? [];
      if (msgs.length > beforeCount) {
        let latest = null;
        for (let i = msgs.length - 1; i >= beforeCount; i--) {
          const m = msgs[i];
          if (m.role === "assistant" && m.content) {
            latest = stripInternalMarkers(m.content);
            break;
          }
        }
        if (latest) {
          const t = String(latest);
          if (t !== accumulated) {
            const delta = t.startsWith(accumulated) ? t.slice(accumulated.length) : t;
            accumulated = t;
            if (delta) onDelta?.(delta);
            stableRounds = 0;
          } else {
            stableRounds++;
          }
          // 同一内容连续两轮稳定 → 视为最终回复
          if (stableRounds >= 2) return accumulated;
        }
      }
    }
    throw new Error("书友思考太久，请稍后再试");
  }

  /**
   * 事件驱动路径：bus.subscribe 订阅该书会话（filter 取 normalizeSessionTarget 的
   * { sessionPath } 形态，宿主按会话归属过滤），收到该会话新增的 assistant 消息即 resolve。
   * 150s 超时兜底；超时后再用 history 确认一次，防事件漏发导致误报超时。
   */
  async _converseByEvent({ target, userMessage, context, timeoutMs }) {
    const before = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
    const beforeCount = before?.messages?.length ?? 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      let unsub = null;

      const cleanup = () => {
        if (unsub && this._subs.has(unsub)) {
          this._subs.delete(unsub);
          try {
            unsub();
          } catch {}
          unsub = null;
        }
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      // 150s 超时：事件可能漏发，先用 history 确认一次，确认不到再报超时
      const timer = setTimeout(async () => {
        if (settled) return;
        try {
          const hist = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
          const msgs = hist?.messages ?? [];
          if (msgs.length > beforeCount) {
            for (let i = msgs.length - 1; i >= beforeCount; i--) {
              const m = msgs[i];
              if (m.role === "assistant" && m.content) {
                return settle(resolve, stripInternalMarkers(m.content));
              }
            }
          }
        } catch {}
        settle(reject, new Error("书友思考太久，请稍后再试"));
      }, timeoutMs);

      // 先订阅再发送，避免漏掉快速回复的事件
      unsub = this.bus.subscribe(
        (event, scopedSessionPath) => {
          if (settled) return;
          // 归属双重校验：宿主 filter 已按 sessionPath 匹配，这里再验 scoped 与事件内嵌 path，防串会话
          if (!matchSessionEvent(target, scopedSessionPath, event)) return;
          const content = extractAssistantContent(event);
          if (!content) return; // 中间态/无文本事件：忽略，继续等最终回复
          settle(resolve, stripInternalMarkers(content));
        },
        { ...target },
      );
      this._subs.add(unsub);

      this.bus
        .request("session:send", {
          text: userMessage,
          ...target,
          ...(context ? { context } : {}),
        })
        .catch((err) => settle(reject, err));
    });
  }

  /** 轮询 fallback：bus.subscribe 不可用时走老路（800ms 轮询） */
  async _converseByPolling({ target, userMessage, context, timeoutMs }) {
    const before = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
    const beforeCount = before?.messages?.length ?? 0;

    await this.bus.request("session:send", {
      text: userMessage,
      ...target,
      ...(context ? { context } : {}),
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(800);
      const hist = await this.bus.request("session:history", { ...target, limit: 60 }).catch(() => ({ messages: [] }));
      const msgs = hist?.messages ?? [];
      if (msgs.length > beforeCount) {
        for (let i = msgs.length - 1; i >= beforeCount; i--) {
          const m = msgs[i];
          if (m.role === "assistant" && m.content) return stripInternalMarkers(m.content);
        }
      }
    }
    throw new Error("书友思考太久，请稍后再试");
  }
}

/* 由存储条目构造宿主请求用的会话定位：sessionId 优先，回退 sessionPath；旧版字符串条目按 path 兼容 */
function targetOf(ref) {
  if (ref && typeof ref === "object") {
    if (ref.sid) return { sessionId: ref.sid };
    if (ref.path) return { sessionPath: ref.path };
  }
  if (typeof ref === "string" && ref) return { sessionPath: ref };
  return null;
}

/* 事件归属匹配：scoped 值或事件内嵌定位与目标一致（sessionId / sessionPath 任一命中即归此会话） */
function matchSessionEvent(target, scopedVal, event) {
  const ids = [target?.sessionId, target?.sessionPath].filter(Boolean);
  if (ids.length === 0) return true;
  if (scopedVal && !ids.includes(scopedVal)) return false;
  const evVal = event?.sessionId ?? event?.sessionPath ?? event?.path;
  if (evVal && !ids.includes(evVal)) return false;
  return true;
}

/* 从会话事件里提取 assistant 文本。宿主事件封装形态不确定，做多层容错：
   role 可能是 event.role / message.role / type 字符串；文本可能在
   content / text / message.content / payload 里。 */
function extractAssistantContent(event) {
  if (!event || typeof event !== "object") return null;
  const role = event.role ?? event.message?.role;
  const type = typeof event.type === "string" ? event.type : "";
  const isAssistant =
    role === "assistant" || type === "assistant" || type.includes("assistant");
  if (!isAssistant) return null;
  const content =
    event.content ??
    event.text ??
    event.message?.content ??
    event.payload?.content ??
    event.payload?.text;
  return typeof content === "string" && content.trim() ? content : null;
}
