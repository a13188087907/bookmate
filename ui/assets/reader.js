/* 书友 · AI 陪伴阅读 —— 阅读界面逻辑（v2 原型转正：无限滚 + 阅读优先的呈现层）
   数据层与 v1 一致（书库/章节/划线/会话/导出/沉淀），呈现层按「前赤壁赋」原型重构：
   章节不再硬切，滑动窗口渲染，章节分隔是行内排版节点；chrome 按需隐现。 */

import { hana } from "./sdk.js";

/* v2 鉴权：页面 URL 携带 appSurfaceSession（query 通道宿主认可），API 走 routes 代理 */
const ticket = new URLSearchParams(location.search).get("appSurfaceSession") || "";
const apiBase = "/api/apps/bookmate/routes";

const api = (path, options = {}) => {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${apiBase}${path}${sep}appSurfaceSession=${encodeURIComponent(ticket)}`;
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  return fetch(url, {
    method: options.method || "GET",
    headers: isForm ? {} : { "content-type": "application/json" },
    body: options.body ? (isForm ? options.body : JSON.stringify(options.body)) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
    return data;
  });
};

const state = {
  books: [],
  bookId: null,
  meta: null,
  chapters: [],          // [{ idx, title, paragraphs, chars }]
  chapterTexts: {},      // idx → { paragraphs, subheadings, images }（随用随取，缓存）
  chapterIdx: 0,
  highlights: [],
  history: [],
  chatArchive: {},
  busy: false,
  manageMode: false,
  selected: new Set(),
  agentId: null,
  pendingQuote: null,
  importedFonts: [],
  lastVisiblePara: 0,
  chapterStartAt: null,
  statusBar: null,
  greeting: null,        // 开场白（临时气泡，不入档）
};

/* 已渲染窗口：章节区间 [viewStart, viewEnd] 在 DOM 中，窗口随当前章滑动 */
const view = { start: 0, end: -1 };
const AHEAD = 1;   // 当前章之后保持渲染的章数
const BEHIND = 1;  // 当前章之前保持渲染的章数
const MARGIN = 2;  // 超出 当前±MARGIN 的章节从 DOM 卸载

/* ---------- 本地缓存 ---------- */
const LS_BOOKS = "bookmate.books.v2";
const LS_LAST = "bookmate.last.v2";
const LS_READER = "bookmate.reader.v1";   // 排版设置（Aa 面板）
const LS_SHELF = "bookmate.shelf.v1";     // 书库栏显隐
function readLS(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  let t = document.querySelector(".bookmate-toast");
  if (!t) {
    t = el("div", "bookmate-toast");
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function ensureModal() {
  let overlay = document.querySelector(".bookmate-modal");
  if (!overlay) {
    overlay = el("div", "bookmate-modal");
    overlay.innerHTML =
      '<div class="modal-box"><div class="modal-text"></div>' +
      '<input class="modal-input" type="text">' +
      '<div class="modal-actions"><button class="cancel">取消</button><button class="ok">确定</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector(".cancel").addEventListener("click", () => overlay.classList.remove("show"));
    overlay.querySelector(".ok").addEventListener("click", () => {
      overlay.classList.remove("show");
      const input = overlay.querySelector(".modal-input");
      const fn = overlay._onOk;
      overlay._onOk = null;
      if (fn) fn(input.value);
    });
    overlay.querySelector(".modal-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") overlay.querySelector(".ok").click();
    });
  }
  return overlay;
}

function confirmDialog(message, onOk) {
  const overlay = ensureModal();
  overlay.querySelector(".modal-input").style.display = "none";
  overlay.querySelector(".modal-text").textContent = message;
  overlay._onOk = () => onOk();
  overlay.classList.add("show");
}

function promptDialog(message, defaultValue, onOk) {
  const overlay = ensureModal();
  const input = overlay.querySelector(".modal-input");
  input.style.display = "block";
  input.value = defaultValue;
  overlay.querySelector(".modal-text").textContent = message;
  overlay._onOk = (v) => onOk(v.trim());
  overlay.classList.add("show");
  input.focus();
  input.select();
}

/* ---------- 排版设置（Aa 面板） ---------- */
const FONT_PRESETS = [
  ["", "默认字体"],
  ["'Source Han Serif SC','Noto Serif CJK SC','STSong','SimSun',serif", "宋体"],
  ["'SimHei',sans-serif", "黑体"],
  ["'KaiTi',serif", "楷体"],
  ["'FangSong',serif", "仿宋"],
  ["'Microsoft YaHei',sans-serif", "微软雅黑"],
];

function getReaderSettings() {
  return readLS(LS_READER, { family: "", size: 17, lineHeight: 1.95, theme: "follow", texture: true, indent: true, measure: 38 });
}

function effectiveTheme(s) {
  if (s.theme !== "follow") return s.theme === "dark" ? "dark" : "light";
  return window.__hostAppearance === "dark" ? "dark" : "light";
}

function applyReaderSettings(s) {
  writeLS(LS_READER, s);
  const proto = $("#proto");
  proto.style.setProperty("--fs", s.size + "px");
  proto.style.setProperty("--lh", String(s.lineHeight));
  proto.style.setProperty("--measure", Number(s.measure) > 0 ? Number(s.measure) + "em" : "min(92%, 72em)");
  proto.style.setProperty("--reader-font-family", s.family || "'Source Han Serif SC','Noto Serif CJK SC','STSong','SimSun',serif");
  document.body.setAttribute("data-theme", effectiveTheme(s));
  proto.classList.toggle("grain", !!s.texture);
  proto.classList.toggle("indent", !!s.indent);
}

/* ---------- 布局 ---------- */

function buildLayout() {
  const root = $("#root");
  root.innerHTML = "";

  const proto = el("div", "proto grain indent");
  proto.id = "proto";
  proto.setAttribute("data-theme", "light");

  /* 顶部进度线 + 顶栏（自动隐现） */
  const progressLine = el("div", "progress-line");
  const topbar = el("div", "topbar");
  const shelfToggle = el("button", "tb-btn", "书库");
  shelfToggle.title = "书库";
  const bookLabel = el("span", "book", "");
  const chapLabel = el("span", "chap", "");
  topbar.append(shelfToggle, bookLabel, chapLabel);

  /* 书库抽屉（默认隐藏，读时为纸） */
  const shelf = el("aside", "shelf");
  shelf.id = "shelf";
  const shelfHead = el("div", "shelf-head");
  shelfHead.append(el("h3", null, "书库"));
  const headBtns = el("div", "head-btns");
  const importBtn = el("button", "tool-btn", "导入");
  importBtn.title = "从文件夹选择 EPUB 批量导入";
  const importInput = el("input");
  importInput.type = "file";
  importInput.multiple = true;
  importInput.accept = ".epub,.EPUB";
  importInput.style.display = "none";
  document.body.appendChild(importInput);
  importInput.addEventListener("change", () => {
    const files = [...importInput.files];
    importInput.value = "";
    if (files.length) importFiles(files);
  });
  importBtn.addEventListener("click", () => importInput.click());
  const manageBtn = el("button", "manage-btn", "管理");
  manageBtn.addEventListener("click", toggleManage);
  headBtns.append(importBtn, manageBtn);
  shelfHead.append(headBtns);
  const shelfClose = el("button", "shelf-close", "×");
  shelfClose.title = "收起";
  shelfClose.addEventListener("click", () => {
    proto.classList.remove("shelf-open");
    shelfToggle.classList.remove("active");
    writeLS(LS_SHELF, false);
  });
  shelfHead.append(shelfClose);
  const shelfList = el("div", "shelf-list");
  const shelfActions = el("div", "shelf-actions");
  shelf.append(shelfHead, shelfList, shelfActions);

  /* 章节导轨：一列刻度线，悬停按距离缩放成金字塔，浮出章节预览 */
  const rail = el("nav", "rail");
  const railPreview = el("div", "rail-preview");
  rail.setAttribute("aria-label", "章节导航");
  rail.addEventListener("mouseleave", () => railHover(null));
  const shelfVisible = readLS(LS_SHELF, false);
  proto.classList.toggle("shelf-open", !!shelfVisible);
  shelfToggle.classList.toggle("active", !!shelfVisible);
  shelfToggle.addEventListener("click", () => {
    const open = !proto.classList.contains("shelf-open");
    proto.classList.toggle("shelf-open", open);
    shelfToggle.classList.toggle("active", open);
    writeLS(LS_SHELF, open);
  });

  /* 阅读区（无限滚容器） */
  const reader = el("main", "reader");
  reader.id = "reader";
  const column = el("div", "column");
  column.id = "column";
  reader.append(column);

  /* 底部提示 + 浮动按钮 */
  const hintbar = el("div", "hintbar", "");
  state.statusBar = hintbar;
  const fabs = el("div", "fabs");
  const aaBtn = el("button", "fab", "Aa");
  aaBtn.title = "排版设置";
  const chatBtn = el("button", "fab", "✦");
  chatBtn.title = "书友";
  fabs.append(aaBtn, chatBtn);

  /* Aa 排版面板 */
  const aaPanel = el("div", "aa-panel");
  aaPanel.id = "aaPanel";
  aaBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    renderAaPanel(aaPanel);
    aaPanel.classList.toggle("open");
    aaBtn.classList.toggle("active");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".aa-panel") && e.target !== aaBtn) {
      aaPanel.classList.remove("open");
      aaBtn.classList.remove("active");
    }
  });

  /* 书友侧栏（尺牍：头部一行 + ⋯ 菜单 + 信笺/短签 + 底线输入） */
  const sidebar = el("aside", "sidebar");
  sidebar.id = "sidebar";
  const sbHead = el("div", "sb-head");
  const whoEl = el("span", "who", companionName());
  const sbMeta = el("span", "meta", "");
  sbHead.append(whoEl, sbMeta);
  const acts = el("span", "acts");
  const menuBtn = el("button", "sb-icon", "⋯");
  menuBtn.title = "对话操作";
  const sbClose = el("button", "sb-icon", "×");
  sbClose.title = "合上";
  sbClose.addEventListener("click", () => {
    sidebar.classList.remove("open");
    chatBtn.classList.remove("active");
  });
  acts.append(menuBtn, sbClose);
  sbHead.append(acts);

  const sbMenu = el("div", "sb-menu");
  const agentRow = el("div", "menu-row");
  agentRow.append(el("label", null, "书友"));
  const agentSelect = el("select");
  const defaultOpt = el("option", null, "默认助手（书友人格）");
  defaultOpt.value = "";
  agentSelect.append(defaultOpt);
  agentRow.append(agentSelect);
  sbMenu.append(agentRow, el("div", "sep"));
  const menuItem = (label, fn, cls, title) => {
    const b = el("button", cls || null, label);
    if (title) b.title = title;
    b.addEventListener("click", () => {
      sbMenu.classList.remove("open");
      fn();
    });
    sbMenu.append(b);
    return b;
  };
  menuItem("沉淀本章", distillChapter, "distill-btn", "生成本章结构化笔记，进入全书骨架");
  menuItem("导出本书笔记", exportBook, null, "导出为 Markdown（章节骨架 / 立场演变 / 划线）");
  sbMenu.append(el("div", "sep"));
  menuItem("新对话", newConversation, null, "当前对话归入历史，展开新的对话");
  menuItem("历史对话", () => {
    state.viewingList = true;
    renderThreadList();
  }, null, "回看归档的对话");
  menuItem("清除对话", clearConversation, "danger", "清除当前对话记录，不可恢复");

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sbMenu.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!sbMenu.contains(e.target) && e.target !== menuBtn) sbMenu.classList.remove("open");
  });

  const syncAgentSelection = () => {
    const saved = readLS("bookmate.agent", "");
    const exists = [...agentSelect.options].some((o) => o.value === saved);
    if (!exists) {
      agentSelect.value = "";
      writeLS("bookmate.agent", "");
    } else {
      agentSelect.value = saved;
    }
    state.agentId = agentSelect.value || null;
    whoEl.textContent = companionName();
  };
  agentSelect.addEventListener("change", () => {
    writeLS("bookmate.agent", agentSelect.value);
    state.agentId = agentSelect.value || null;
    whoEl.textContent = companionName();
  });
  syncAgentSelection();
  api("/api/agents")
    .then((data) => {
      const agents = Array.isArray(data?.agents) ? data.agents : [];
      for (const a of agents) {
        if (!a?.id) continue;
        const opt = el("option", null, a.name || a.id);
        opt.value = a.id;
        agentSelect.append(opt);
      }
      syncAgentSelection();
    })
    .catch(() => {});

  const sbBody = el("div", "sb-body");
  const quoteBar = el("div", "quote-bar");
  quoteBar.style.display = "none";
  const sbComposer = el("div", "sb-composer");
  const composerRow = el("div", "composer-row");
  const input = el("input");
  input.placeholder = "提笔问书友…";
  input.autocomplete = "off";
  const sendBtn = el("button", null, "发送");
  composerRow.append(input, sendBtn);
  sbComposer.append(quoteBar, composerRow);
  sidebar.append(sbHead, sbMenu, sbBody, sbComposer);

  chatBtn.addEventListener("click", () => {
    const open = !sidebar.classList.contains("open");
    sidebar.classList.toggle("open", open);
    chatBtn.classList.toggle("active", open);
  });
  sendBtn.addEventListener("click", sendMessage);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) sendMessage();
  });

  /* 顶栏章节名：点住则钉住导轨，再点松开 */
  chapLabel.classList.add("clickable");
  chapLabel.title = "章节导航（点按钉住）";
  chapLabel.addEventListener("click", (e) => {
    e.stopPropagation();
    rail.classList.toggle("pin");
  });

  /* 键盘：左右方向键跳章 */
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (!state.bookId) return;
    if (e.key === "ArrowRight") jumpToChapter(Math.min(state.chapterIdx + 1, state.chapters.length - 1));
    if (e.key === "ArrowLeft") jumpToChapter(Math.max(state.chapterIdx - 1, 0));
  });

  /* chrome 自动隐现 */
  let idleTimer = null;
  function wake() {
    proto.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => proto.classList.add("idle"), 2600);
  }
  ["mousemove", "touchstart", "wheel", "keydown"].forEach((ev) =>
    document.addEventListener(ev, wake, { passive: true })
  );
  wake();

  /* 滚动追踪：当前章 / 段落 / 窗口滑动（节流） */
  reader.addEventListener("scroll", () => {
    if (state._scrollTick && Date.now() - state._scrollTick < 120) return;
    state._scrollTick = Date.now();
    trackReadingPosition();
  }, { passive: true });

  /* 划选悬浮工具条 */
  const markToolbar = el("div", "mark-toolbar");
  markToolbar.style.display = "none";
  document.body.appendChild(markToolbar);
  document.addEventListener("mouseup", () => setTimeout(handleTextSelection, 20));
  document.addEventListener("click", (e) => {
    if (
      !e.target.closest(".mark-toolbar") &&
      !e.target.closest(".hl-line") &&
      !e.target.closest(".hl-wave") &&
      !e.target.closest(".hl-mark")
    ) {
      hideMarkToolbar();
    }
  });

  proto.append(progressLine, topbar, shelf, reader, rail, railPreview, hintbar, fabs, aaPanel, sidebar);
  root.append(proto);

  window.__bookmate = { openBook: (id) => openBook(id) };
}

/* ---------- Aa 排版面板 ---------- */

function renderAaPanel(panel) {
  if (panel._built) return;
  panel._built = true;
  const s = getReaderSettings();

  const mkRow = (label, ...nodes) => {
    const row = el("div", "aa-row");
    row.append(el("label", null, label), ...nodes);
    return row;
  };
  const mkSeg = (options, current, onPick) => {
    const seg = el("div", "seg");
    for (const [v, label] of options) {
      const b = el("button", v === current ? "on" : "", label);
      b.addEventListener("click", () => {
        [...seg.children].forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        onPick(v);
      });
      seg.append(b);
    }
    return seg;
  };

  /* 字体（预设 + 已导入） */
  const fontSelect = el("select");
  const known = FONT_PRESETS.some(([v]) => v === s.family);
  for (const [v, label] of FONT_PRESETS) {
    const opt = el("option", null, label);
    opt.value = v;
    fontSelect.append(opt);
  }
  for (const f of state.importedFonts || []) {
    const opt = el("option", null, `书友字体：${f.name}`);
    opt.value = f.family;
    fontSelect.append(opt);
  }
  if (!known && s.family && !(state.importedFonts || []).some((f) => f.family === s.family)) {
    const opt = el("option", null, `自定义：${s.family}`);
    opt.value = s.family;
    fontSelect.append(opt);
  }
  fontSelect.value = s.family || "";
  fontSelect.addEventListener("change", () => {
    applyReaderSettings({ ...getReaderSettings(), family: fontSelect.value });
  });
  const importFontBtn = el("button", "fp-btn", "导入");
  importFontBtn.title = "导入 .ttf/.otf 字体文件";
  const fontFileInput = el("input");
  fontFileInput.type = "file";
  fontFileInput.accept = ".ttf,.otf";
  fontFileInput.style.display = "none";
  document.body.appendChild(fontFileInput);
  importFontBtn.addEventListener("click", () => fontFileInput.click());
  fontFileInput.addEventListener("change", async () => {
    const files = [...fontFileInput.files];
    fontFileInput.value = "";
    if (files.length) await importFonts(files);
  });

  /* 字号 / 行距滑杆 */
  const fsRange = el("input");
  fsRange.type = "range";
  fsRange.min = 14; fsRange.max = 22; fsRange.step = 1; fsRange.value = s.size;
  const fsVal = el("span", "aa-val", String(s.size));
  fsRange.addEventListener("input", () => {
    fsVal.textContent = fsRange.value;
    applyReaderSettings({ ...getReaderSettings(), size: Number(fsRange.value) });
  });
  const lhRange = el("input");
  lhRange.type = "range";
  lhRange.min = 16; lhRange.max = 23; lhRange.step = 1; lhRange.value = Math.round(s.lineHeight * 10);
  const lhVal = el("span", "aa-val", s.lineHeight.toFixed(1));
  lhRange.addEventListener("input", () => {
    lhVal.textContent = (lhRange.value / 10).toFixed(1);
    applyReaderSettings({ ...getReaderSettings(), lineHeight: lhRange.value / 10 });
  });

  panel.append(
    mkRow("字体", fontSelect, importFontBtn),
    mkRow("字号", fsRange, fsVal),
    mkRow("行距", lhRange, lhVal),
    mkRow("主题", mkSeg([["follow", "跟随"], ["light", "暖纸"], ["dark", "墨夜"]], s.theme, (v) =>
      applyReaderSettings({ ...getReaderSettings(), theme: v })
    )),
    mkRow("页宽", mkSeg([["30", "窄"], ["38", "适"], ["46", "宽"], ["0", "满"]], String(s.measure ?? 38), (v) =>
      applyReaderSettings({ ...getReaderSettings(), measure: Number(v) })
    )),
    mkRow("纸纹", mkSeg([["on", "开"], ["off", "关"]], s.texture ? "on" : "off", (v) =>
      applyReaderSettings({ ...getReaderSettings(), texture: v === "on" })
    )),
    mkRow("缩进", mkSeg([["on", "两字符"], ["off", "顶格"]], s.indent ? "on" : "off", (v) =>
      applyReaderSettings({ ...getReaderSettings(), indent: v === "on" })
    )),
  );
}

/* ---------- 已导入字体 ---------- */

let fontFacesInjected = false;
async function ensureFontFaces() {
  if (fontFacesInjected) return;
  const { fonts } = await api("/api/fonts").catch(() => ({ fonts: [] }));
  state.importedFonts = fonts.length ? fonts : [];
  if (!fonts.length) return;
  const style = el("style", "bookmate-fonts");
  for (const f of fonts) {
    style.textContent +=
      `@font-face{font-family:"${f.family}";src:url("${apiBase}/api/fonts/${encodeURIComponent(f.file)}?appSurfaceSession=${encodeURIComponent(ticket)}") format("${/\.otf$/i.test(f.file) ? "opentype" : "truetype"}");font-display:swap;}`;
  }
  document.head.appendChild(style);
  fontFacesInjected = true;
}

async function importFonts(files) {
  const fd = new FormData();
  for (const f of files) fd.append("fonts", f, f.name);
  try {
    await api("/api/fonts/import", { method: "POST", body: fd });
    fontFacesInjected = false;
    await ensureFontFaces();
    const panel = document.querySelector(".aa-panel");
    if (panel) {
      panel._built = false;
      panel.textContent = "";
      renderAaPanel(panel);
    }
    toast(`已导入 ${files.length} 个字体`);
  } catch (err) {
    toast(`字体导入失败：${err.message}`);
  }
}

/* ---------- 书库 ---------- */

function syncActive() {
  document.querySelectorAll(".shelf-list .book-item").forEach((it) => {
    it.classList.toggle("active", it.dataset.bookId === state.bookId);
  });
}

function renderBooks(books, listEl) {
  listEl.textContent = "";
  if (books.length === 0) {
    listEl.append(el("div", "empty", "书库还是空的。\n在对话里对助手说：\n「导入 EPUB：<文件路径>」"));
    return;
  }
  for (const b of books) {
    const item = el("div", "book-item" + (b.id === state.bookId ? " active" : ""));
    item.dataset.bookId = b.id;
    const titleRow = el("div", "t-row");
    if (state.manageMode) {
      item.classList.toggle("sel", state.selected.has(b.id));
      item.addEventListener("click", () => toggleSelect(b.id));
      titleRow.prepend(el("span", "ck", state.selected.has(b.id) ? "✓" : ""));
      titleRow.append(el("div", "t", b.title));
    } else {
      const actions = el("div", "book-actions");
      const del = el("button", "del-btn", "×");
      del.title = "从书库删除";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        removeBook(b.id);
      });
      const renameBtn = el("button", "del-btn", "✎");
      renameBtn.title = "重命名";
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        renameBook(b.id);
      });
      actions.append(renameBtn, del);
      titleRow.append(el("div", "t", b.title), actions);
      item.addEventListener("click", () => openBook(b.id));
    }
    item.append(titleRow, el("div", "s", `${b.author || "佚名"} · ${b.chapterCount} 章`));
    listEl.append(item);
  }
}

async function loadBooks() {
  const listEl = $(".shelf-list");
  const cached = readLS(LS_BOOKS, []);
  if (cached.length) renderBooks(cached, listEl);
  try {
    const { books } = await api("/api/books");
    state.books = books;
    writeLS(LS_BOOKS, books);
    renderBooks(books, listEl);
    const last = readLS(LS_LAST, null);
    if (last && books.some((b) => b.id === last.bookId) && !state.bookId) {
      openBook(last.bookId, last.chapter);
    }
  } catch (err) {
    if (!cached.length) {
      listEl.append(el("div", "empty", `加载书库失败：${err.message}`));
    }
  }
}

function renameBook(bookId) {
  const b = state.books.find((x) => x.id === bookId);
  if (!b) return;
  promptDialog("重命名书名", b.title, async (newTitle) => {
    if (!newTitle || newTitle === b.title) return;
    try {
      await api(`/api/books/${bookId}/rename`, { method: "POST", body: { title: newTitle } });
      b.title = newTitle;
      if (state.bookId === bookId && state.meta) {
        state.meta.title = newTitle;
        updateLastCache();
      }
      writeLS(LS_BOOKS, state.books);
      renderBooks(state.books, $(".shelf-list"));
      toast("书名已更新");
    } catch (err) {
      toast(`重命名失败：${err.message}`);
    }
  });
}

async function importFiles(files) {
  const listEl = $(".shelf-list");
  const statusLine = el("div", "empty", `正在导入 ${files.length} 本…`);
  listEl.prepend(statusLine);
  try {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    const { results } = await api("/api/books/import", { method: "POST", body: fd });
    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);
    const { books } = await api("/api/books");
    state.books = books;
    writeLS(LS_BOOKS, books);
    renderBooks(books, listEl);
    toast(`导入完成：成功 ${ok.length} 本，失败 ${fail.length} 本`);
    if (fail.length) {
      const failBox = el("div", "empty fail-box", "导入失败：" + fail.map((r) => `${r.name}（${r.error}）`).join("；"));
      listEl.prepend(failBox);
    }
  } catch (err) {
    statusLine.textContent = `导入失败：${err.message}`;
  }
  listEl.scrollTop = 0;
}

function toggleManage() {
  state.manageMode = !state.manageMode;
  state.selected.clear();
  document.querySelector(".shelf-head h3").textContent = state.manageMode ? "选择书籍" : "书库";
  document.querySelector(".manage-btn").textContent = state.manageMode ? "完成" : "管理";
  renderBooks(state.books, $(".shelf-list"));
  renderShelfActions();
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const item = document.querySelector(`.book-item[data-book-id="${id}"]`);
  if (item) {
    item.classList.toggle("sel", state.selected.has(id));
    const ck = item.querySelector(".ck");
    if (ck) ck.textContent = state.selected.has(id) ? "✓" : "";
  }
  renderShelfActions();
}

function renderShelfActions() {
  const bar = $(".shelf-actions");
  bar.textContent = "";
  if (!state.manageMode) return;
  const allBtn = el("button", "mini", state.selected.size === state.books.length ? "取消全选" : "全选");
  const delBtn = el("button", "mini danger", `删除选中 (${state.selected.size})`);
  delBtn.disabled = state.selected.size === 0;
  allBtn.addEventListener("click", () => {
    if (state.selected.size === state.books.length && state.books.length > 0) state.selected.clear();
    else state.books.forEach((b) => state.selected.add(b.id));
    renderBooks(state.books, $(".shelf-list"));
    renderShelfActions();
  });
  delBtn.addEventListener("click", () => {
    const ids = [...state.selected];
    confirmDialog(`删除选中的 ${ids.length} 本书？此操作不可撤销。`, async () => {
      let fail = 0;
      for (const id of ids) {
        try {
          await api(`/api/books/${id}`, { method: "DELETE" });
          try { localStorage.removeItem(`bookmate.chat.${id}`); } catch {}
        } catch {
          fail++;
        }
      }
      state.selected.clear();
      if (state.bookId && ids.includes(state.bookId)) {
        clearReading();
      }
      const { books } = await api("/api/books");
      state.books = books;
      writeLS(LS_BOOKS, books);
      renderBooks(state.books, $(".shelf-list"));
      renderShelfActions();
      toast(fail ? `已删除 ${ids.length - fail} 本，失败 ${fail} 本` : `已删除 ${ids.length} 本`);
    });
  });
  bar.append(allBtn, delBtn);
}

async function removeBook(bookId) {
  const b = state.books.find((x) => x.id === bookId);
  confirmDialog(`从书库删除《${b?.title ?? bookId}》？此操作不可撤销。`, async () => {
    try {
      await api(`/api/books/${bookId}`, { method: "DELETE" });
      state.books = state.books.filter((x) => x.id !== bookId);
      writeLS(LS_BOOKS, state.books);
      if (state.bookId === bookId) clearReading();
      try { localStorage.removeItem(`bookmate.chat.${bookId}`); } catch {}
      toast(`已删除《${b?.title ?? bookId}》`);
      loadBooks();
    } catch (err) {
      toast(`删除失败：${err.message}`);
    }
  });
}

function clearReading() {
  state.bookId = null;
  state.meta = null;
  state.chapters = [];
  state.chapterTexts = {};
  view.start = 0;
  view.end = -1;
  $("#column").textContent = "";
  $(".topbar .book").textContent = "";
  $(".topbar .chap").textContent = "";
  writeLS(LS_LAST, null);
}

/* ---------- 阅读核心：打开书 / 章节数据 ---------- */

async function fetchChapterText(idx) {
  if (state.chapterTexts[idx]) return state.chapterTexts[idx];
  const { chapter } = await api(`/api/books/${state.bookId}/chapters/${idx}`);
  const data = {
    paragraphs: chapter.paragraphs || [],
    subheadings: chapter.subheadings || [],
    images: chapter.images || [],
  };
  state.chapterTexts[idx] = data;
  return data;
}

/* 读取本书对话（每书一段连续对话；旧版按章归档按章序合并迁移） */
function readChat(bookId) {
  const raw = readLS(`bookmate.chat.${bookId}`, []);
  if (Array.isArray(raw)) return raw;
  const merged = [];
  for (const k of Object.keys(raw).sort((a, b) => Number(a) - Number(b))) {
    if (Array.isArray(raw[k])) merged.push(...raw[k]);
  }
  return merged;
}

function readThreads(bookId) {
  const raw = readLS(`bookmate.threads.${bookId}`, []);
  return Array.isArray(raw) ? raw : [];
}

async function openBook(bookId, chapter) {
  state.bookId = bookId;
  state.chatArchive = readChat(bookId);
  state.history = state.chatArchive.map((m) => ({ ...m }));
  state.threads = readThreads(bookId);
  state.viewingThread = null;
  state.viewingList = false;
  state.highlights = [];
  state.chapterTexts = {};
  state.greeting = null;
  view.start = 0;
  view.end = -1;
  $("#column").textContent = "";
  syncActive();
  try {
    const [{ meta, progress }, { chapters }, { highlights }] = await Promise.all([
      api(`/api/books/${bookId}`),
      api(`/api/books/${bookId}/chapters`),
      api(`/api/books/${bookId}/highlights`),
    ]);
    state.meta = meta;
    state.chapters = chapters;
    state.highlights = normalizeHighlights(highlights);
    $(".topbar .book").textContent = meta.title;
    document.querySelector(".sb-head .meta").textContent = `《${meta.title}》`;
    syncActive();
    if (chapters.length === 0) {
      $("#column").append(el("div", "empty-note", "这本书没有可读的章节。"));
      return;
    }
    /* 打开书后重建导轨 */
    buildRail();
    const start = Math.min(chapter ?? progress.chapter ?? 0, chapters.length - 1);
    /* 开场白：有进度且本书还没有任何对话时，书友先开口（临时气泡，不入档） */
    if ((progress.chapter > 0 || progress.paragraph > 0) && state.history.length === 0 && state.threads.length === 0) {
      state.greeting = `上次读到第 ${start + 1} 章「${chapters[start].title}」。接着来？`;
    }
    await jumpToChapter(start, { instant: true });
    updateLastCache();
  } catch (err) {
    $("#column").append(el("div", "empty-note", `打开失败：${err.message}`));
  }
}

/* 把当前阅读会话写进缓存，供下次进入页面秒回 */
function updateLastCache() {
  if (!state.bookId || !state.meta) return;
  writeLS(LS_LAST, {
    bookId: state.bookId,
    chapter: state.chapterIdx,
  });
}

/* ---------- 无限滚渲染器 ---------- */

function sectionOf(idx) {
  return document.querySelector(`.chapter[data-idx="${idx}"]`);
}

/* 章节名直接使用原标题（为空才补序号） */
function chapterLabel(idx, title) {
  const t = String(title ?? "").trim();
  return t || `第${idx + 1}章`;
}

/* 构建一章的 DOM：行内分隔线 + 章题 + 段落（含划线渲染）+ 原位插图 */
async function buildChapterSection(idx) {
  const data = await fetchChapterText(idx);
  const section = el("section", "chapter");
  section.dataset.idx = idx;

  if (idx === 0) {
    const head = el("div", "book-head");
    head.append(
      el("div", "book-title", state.meta?.title ?? ""),
      el("div", "book-author", state.meta?.author || "佚名"),
    );
    section.append(head);
    section.append(el("div", "chapter-head", chapterLabel(0, state.chapters[0]?.title)));
  } else {
    const label = chapterLabel(idx, state.chapters[idx]?.title);
    const divider = el("div", "divider");
    divider.dataset.chap = label;
    divider.append(el("span", null, label));
    section.append(divider);
  }

  for (const sh of data.subheadings || []) {
    section.append(el("div", "subheading", sh));
  }

  const textWrap = el("div", "text");
  renderParagraphs(textWrap, idx, data.paragraphs, data.images);
  section.append(textWrap);
  return section;
}

/* 段落渲染：按划线区间切分 + 图片原位插入（与 v1 同一套数据约定） */
function renderParagraphs(wrap, chapterIdx, paragraphs, images = []) {
  const marks = state.highlights.filter((h) => h.chapter === chapterIdx);
  const byPara = new Map();
  for (const m of marks) {
    if (!byPara.has(m.paragraph)) byPara.set(m.paragraph, []);
    byPara.get(m.paragraph).push(m);
  }
  const imgs = (images || []).map((it) =>
    typeof it === "string" ? { path: it, pos: null } : { path: it.path, pos: it.pos ?? null }
  );
  const byPos = new Map();
  const tailImgs = [];
  for (const im of imgs) {
    if (im.pos == null || paragraphs.length === 0) { tailImgs.push(im); continue; }
    const k = Math.max(0, Math.min(Number(im.pos) || 0, paragraphs.length));
    if (!byPos.has(k)) byPos.set(k, []);
    byPos.get(k).push(im);
  }
  const appendImg = (im) => {
    const imgEl = el("img", "chapter-img");
    imgEl.src = `${apiBase}/api/books/${state.bookId}/images/${encodeURIComponent(im.path)}?appSurfaceSession=${encodeURIComponent(ticket)}`;
    imgEl.alt = "插图";
    imgEl.loading = "lazy";
    imgEl.addEventListener("error", () => imgEl.remove(), { once: true });
    wrap.append(imgEl);
  };
  const flushImgs = (k) => { for (const im of byPos.get(k) || []) appendImg(im); };
  paragraphs.forEach((text, pIdx) => {
    flushImgs(pIdx);
    const p = el("p", "para");
    p.dataset.chapter = chapterIdx;
    p.dataset.p = pIdx;
    const list = byPara.get(pIdx) || [];
    if (!list.length) {
      p.textContent = text;
    } else {
      const sorted = [...list].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      let cursor = 0;
      for (const m of sorted) {
        const s = Math.max(0, Math.min(m.start ?? 0, text.length));
        const e = Math.max(s, Math.min(m.end ?? text.length, text.length));
        if (e <= cursor) continue; // 已被前一条完全覆盖，跳过（防御重叠数据）
        const s2 = Math.max(s, cursor);
        if (s2 > cursor) p.appendChild(document.createTextNode(text.slice(cursor, s2)));
        if (e > s2) {
          const span = el("span", `hl-${m.type || "mark"}`);
          span.dataset.hid = m.id;
          span.style.setProperty("--hl-color", m.color || HIGHLIGHT_COLORS.mark);
          span.textContent = text.slice(s2, e);
          span.title = "点击编辑划线";
          span.addEventListener("click", (ev) => {
            ev.stopPropagation();
            showMarkToolbar(span.getBoundingClientRect(), "edit", m);
          });
          span.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            hideMarkToolbar();
            deleteMark(m);
          });
          p.appendChild(span);
        }
        cursor = Math.max(cursor, e);
      }
      if (cursor < text.length) p.appendChild(document.createTextNode(text.slice(cursor)));
    }
    wrap.append(p);
  });
  if (paragraphs.length === 0 && !(images || []).length) {
    wrap.append(el("p", "empty-note", "本章没有可显示的文本内容。"));
  }
  flushImgs(paragraphs.length);
  for (const im of tailImgs) appendImg(im);
}

/* 确保 [lo, hi] 区间章节已渲染（按需追加/补挂） */
async function ensureWindow(lo, hi) {
  lo = Math.max(0, lo);
  hi = Math.min(state.chapters.length - 1, hi);
  if (lo > hi) return;
  const column = $("#column");
  /* 向后追加 */
  for (let i = Math.max(view.end + 1, lo); i <= hi; i++) {
    const section = await buildChapterSection(i);
    const next = sectionOf(i + 1);
    if (next) column.insertBefore(section, next);
    else column.append(section);
    if (view.end < i) view.end = i;
  }
  /* 向前补挂（保持滚动位置：按插入高度补偿 scrollTop） */
  for (let i = Math.min(view.start - 1, hi); i >= lo; i--) {
    if (sectionOf(i)) continue;
    const readerEl = $("#reader");
    const section = await buildChapterSection(i);
    column.insertBefore(section, column.firstChild);
    const dh = section.getBoundingClientRect().height;
    if (readerEl.scrollTop > 0 || i < state.chapterIdx) readerEl.scrollTop += dh;
    if (view.start > i || view.end === -1) view.start = i;
  }
}

/* 卸载窗口外章节（|idx - center| > MARGIN），保持滚动位置稳定 */
function pruneWindow(center) {
  const column = $("#column");
  const readerEl = $("#reader");
  let removedAbove = 0;
  for (const section of [...column.querySelectorAll(".chapter")]) {
    const idx = Number(section.dataset.idx);
    if (Math.abs(idx - center) <= MARGIN) continue;
    const rect = section.getBoundingClientRect();
    const readerRect = readerEl.getBoundingClientRect();
    if (rect.bottom < readerRect.top) removedAbove += rect.height;
    section.remove();
  }
  if (removedAbove > 0) readerEl.scrollTop -= removedAbove;
  const rendered = [...column.querySelectorAll(".chapter")].map((s) => Number(s.dataset.idx));
  if (rendered.length) {
    view.start = Math.min(...rendered);
    view.end = Math.max(...rendered);
  } else {
    view.start = 0;
    view.end = -1;
  }
}

/* 跳到指定章：窗口居中到它，然后滚到章首 */
async function jumpToChapter(idx, opts = {}) {
  if (!state.meta || idx < 0 || idx >= state.chapters.length) return;
  if (opts.instant !== true && idx === state.chapterIdx && sectionOf(idx)) {
    $("#reader").scrollTo({ top: sectionOf(idx).offsetTop - 8, behavior: "smooth" });
    return;
  }
  settleChapterStats();
  state.chapterIdx = idx;
  state.lastVisiblePara = 0;
  state.chapterStartAt = Date.now();
  if (!sectionOf(idx)) {
    /* 远跳：清空窗口，以目标章为中心重建（避免旧章节闪烁） */
    if (idx > view.end + AHEAD || idx < view.start - BEHIND) {
      $("#column").textContent = "";
      view.start = idx;
      view.end = idx - 1;
    }
    await ensureWindow(idx - BEHIND, idx + AHEAD);
  }
  const section = sectionOf(idx);
  if (section) {
    $("#reader").scrollTo({ top: section.offsetTop - 8, behavior: opts.instant ? "auto" : "smooth" });
  }
  pruneWindow(idx);
  updateChromeLabels();
  updateLastCache();
  saveProgress();
  updateStatus();
}

/* 滚动追踪：参考线落在哪章哪段 → 当前章 / 段落 / 进度；接近边界滑动窗口 */
function trackReadingPosition() {
  if (!state.meta || !state.chapters.length) return;
  const readerEl = $("#reader");
  const lineY = readerEl.getBoundingClientRect().top + Math.min(120, readerEl.clientHeight * 0.3);
  const sections = [...document.querySelectorAll(".chapter")];
  if (!sections.length) return;
  let current = sections[0];
  for (const s of sections) {
    if (s.getBoundingClientRect().top <= lineY) current = s;
  }
  const idx = Number(current.dataset.idx);
  const paras = [...current.querySelectorAll(".para")];
  let pIdx = 0;
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].getBoundingClientRect().bottom > lineY) { pIdx = i; break; }
    pIdx = i;
  }
  state.lastVisiblePara = pIdx;

  if (idx !== state.chapterIdx) {
    settleChapterStats();
    state.chapterIdx = idx;
    state.chapterStartAt = Date.now();
    updateChromeLabels();
    updateLastCache();
    saveProgress();
  }
  const nearBottom = readerEl.scrollTop + readerEl.clientHeight > readerEl.scrollHeight - 900;
  const nearTop = readerEl.scrollTop < 500;
  if (nearBottom && view.end < state.chapters.length - 1) {
    ensureWindow(view.start, view.end + 1).then(() => pruneWindow(idx));
  } else if (nearTop && view.start > 0) {
    ensureWindow(view.start - 1, view.end).then(() => pruneWindow(idx));
  }
  updateStatus();
}

/* 章节导轨（顶层函数：buildLayout 装配元素，openBook 重建内容） */
function buildRail() {
  const rail = document.querySelector(".rail");
  const proto = $("#proto");
  if (!rail || !proto) return;
  rail.textContent = "";
  const n = state.chapters.length;
  if (!n) return;
  const avail = Math.max(200, proto.clientHeight - 180);
  rail.style.setProperty("--rail-size", Math.max(6, Math.min(22, Math.floor(avail / n))) + "px");
  state.chapters.forEach((ch, i) => {
    const item = el("button", "rail-item" + (i === state.chapterIdx ? " current" : ""));
    item.dataset.idx = i;
    item.title = ch.title;
    item.append(el("span", "rail-tick"));
    item.addEventListener("mouseenter", () => railHover(i));
    item.addEventListener("focus", () => railHover(i));
    item.addEventListener("click", async () => {
      railHover(null);
      await jumpToChapter(i);
    });
    rail.append(item);
  });
}

function railHover(i) {
  const rail = document.querySelector(".rail");
  const railPreview = document.querySelector(".rail-preview");
  const proto = $("#proto");
  if (!rail || !railPreview || !proto) return;
  const items = [...rail.querySelectorAll(".rail-item")];
  if (i == null) {
    items.forEach((it) => it.querySelector(".rail-tick").style.transform = "scaleX(.25)");
    railPreview.classList.remove("show");
    return;
  }
  items.forEach((it, j) => {
    const d = Math.abs(j - i);
    const scale = d === 0 ? 1 : d === 1 ? 0.68 : d === 2 ? 0.44 : 0.25;
    it.querySelector(".rail-tick").style.transform = `scaleX(${scale})`;
  });
  const ch = state.chapters[i];
  if (!ch) return;
  railPreview.innerHTML = "";
  railPreview.append(el("div", "pos", `第 ${i + 1} / ${state.chapters.length} 章`), document.createTextNode(ch.title));
  const rect = items[i].getBoundingClientRect();
  const hostRect = proto.getBoundingClientRect();
  railPreview.style.top = Math.max(8, Math.min(rect.top - hostRect.top - 6, hostRect.height - 70)) + "px";
  railPreview.classList.add("show");
}

function updateChromeLabels() {
  const ch = state.chapters[state.chapterIdx];
  $(".topbar .chap").textContent = ch ? chapterLabel(state.chapterIdx, ch.title) : "";
  const pl = $(".progress-line");
  if (pl && state.chapters.length) {
    pl.style.width = (((state.chapterIdx + 1) / state.chapters.length) * 100).toFixed(1) + "%";
  }
  /* 导轨的当前章标记跟随滚动 */
  document.querySelectorAll(".rail-item").forEach((it, i) => it.classList.toggle("current", i === state.chapterIdx));
}

async function saveProgress() {
  if (!state.bookId) return;
  clearTimeout(state._progressTimer);
  state._progressTimer = setTimeout(() => {
    api(`/api/books/${state.bookId}/progress`, {
      method: "POST",
      body: { chapter: state.chapterIdx },
    }).catch(() => {});
  }, 800);
}

/* ---------- 划线数据（三元组锥定：章/段/段内偏移，窗口装卸不漂） ---------- */

const HIGHLIGHT_COLORS = {
  line: "#c0392b",
  wave: "#c0392b",
  mark: "rgba(255, 208, 0, 0.5)",
  green: "rgba(96, 200, 130, 0.45)",
  pink: "rgba(240, 120, 170, 0.42)",
  blue: "rgba(90, 155, 235, 0.42)",
};

function normalizeHighlights(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((h, i) => {
    if (h.id) return h;
    return {
      id: `hl_legacy_${i}`,
      chapter: h.chapter,
      paragraph: h.paragraph,
      start: 0,
      end: (h.text || "").length,
      text: h.text || "",
      type: "mark",
      color: HIGHLIGHT_COLORS.mark,
    };
  });
}

async function persistHighlights() {
  await api(`/api/books/${state.bookId}/highlights`, {
    method: "POST",
    body: { highlights: state.highlights },
  }).catch(() => {});
}

/* 划线变更后重渲染受影响章节（保持滚动位置） */
function reRenderAffectedChapters(chapters) {
  const readerEl = $("#reader");
  const scroll = readerEl.scrollTop;
  for (const idx of new Set(chapters)) {
    const section = sectionOf(idx);
    if (!section) continue;
    const data = state.chapterTexts[idx];
    if (!data) continue;
    const wrap = section.querySelector(".text");
    if (!wrap) continue;
    wrap.textContent = "";
    renderParagraphs(wrap, idx, data.paragraphs, data.images);
  }
  readerEl.scrollTop = scroll;
}

function offsetInPara(paraEl, container, offset) {
  let total = 0;
  const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node === container) return total + offset;
    total += node.textContent.length;
  }
  return total;
}

/* ---------- 划选悬浮工具条（划线样式 + 引用） ---------- */

let pendingMark = null;

function handleTextSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const range = sel.getRangeAt(0);
  const startContainer = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const endContainer = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement;
  const paraEl = startContainer?.closest?.(".para");
  if (!paraEl || !endContainer?.closest?.(".para")) return;
  /* 引用/划线都只支持段内选择（跨段选择暂不处理，保持数据锥定可靠） */
  if (endContainer.closest(".para") !== paraEl) return;
  const paraIndex = Number(paraEl.dataset.p);
  const chapterIdx = Number(paraEl.dataset.chapter);
  if (!Number.isFinite(paraIndex) || !Number.isFinite(chapterIdx)) return;
  const paraLen = paraEl.textContent.length;
  const start = Math.min(offsetInPara(paraEl, range.startContainer, range.startOffset), paraLen);
  const end = Math.min(offsetInPara(paraEl, range.endContainer, range.endOffset), paraLen);
  if (end <= start) return;
  pendingMark = {
    chapter: chapterIdx,
    paragraph: paraIndex,
    start,
    end,
    text: paraEl.textContent.slice(start, end),
  };
  showMarkToolbar(range.getBoundingClientRect());
}

function showMarkToolbar(rect, mode = "create", hl = null) {
  const tb = $(".mark-toolbar");
  if (!tb) return;
  tb.textContent = "";
  let defs;
  if (mode === "edit" && hl) {
    defs = [
      { t: "—", title: "改为下划线", act: () => updateMark(hl, "line", HIGHLIGHT_COLORS.line) },
      { t: "〰", title: "改为波浪线", act: () => updateMark(hl, "wave", HIGHLIGHT_COLORS.wave) },
      { t: "", cls: "c-yellow", title: "黄色荧光笔", act: () => updateMark(hl, "mark", HIGHLIGHT_COLORS.mark) },
      { t: "", cls: "c-green", title: "绿色荧光笔", act: () => updateMark(hl, "mark", HIGHLIGHT_COLORS.green) },
      { t: "", cls: "c-pink", title: "粉色荧光笔", act: () => updateMark(hl, "mark", HIGHLIGHT_COLORS.pink) },
      { t: "", cls: "c-blue", title: "蓝色荧光笔", act: () => updateMark(hl, "mark", HIGHLIGHT_COLORS.blue) },
      { t: "引用", cls: "quote", title: "引用到书友问答", act: () => quoteMark(hl) },
      { t: "删除", cls: "del", title: "删除此划线", act: () => deleteMark(hl) },
    ];
  } else {
    defs = [
      { t: "—", title: "下划线", act: () => addMark("line", HIGHLIGHT_COLORS.line) },
      { t: "〰", title: "波浪线", act: () => addMark("wave", HIGHLIGHT_COLORS.wave) },
      { t: "", cls: "c-yellow", title: "黄色荧光笔", act: () => addMark("mark", HIGHLIGHT_COLORS.mark) },
      { t: "", cls: "c-green", title: "绿色荧光笔", act: () => addMark("mark", HIGHLIGHT_COLORS.green) },
      { t: "", cls: "c-pink", title: "粉色荧光笔", act: () => addMark("mark", HIGHLIGHT_COLORS.pink) },
      { t: "", cls: "c-blue", title: "蓝色荧光笔", act: () => addMark("mark", HIGHLIGHT_COLORS.blue) },
      { t: "引用", cls: "quote", title: "引用到书友问答", act: () => quotePending() },
    ];
  }
  for (const d of defs) {
    const btn = el("button", "mb-btn" + (d.cls ? " " + d.cls : ""));
    if (d.t) btn.textContent = d.t;
    btn.title = d.title;
    btn.addEventListener("click", d.act);
    tb.append(btn);
  }
  tb.style.display = "flex";
  const top = Math.max(8, rect.top - tb.offsetHeight - 8);
  const left = Math.max(8, rect.left + rect.width / 2 - 80);
  tb.style.top = top + "px";
  tb.style.left = left + "px";
}

function hideMarkToolbar() {
  const tb = $(".mark-toolbar");
  if (tb) tb.style.display = "none";
  pendingMark = null;
}

async function addMark(type, color) {
  if (!pendingMark) return;
  /* 一段文本同时只持一种样式：与新划线重叠的旧划线先移除，而不是叠加 */
  const nm = pendingMark;
  state.highlights = state.highlights.filter((h) =>
    !(h.chapter === nm.chapter && h.paragraph === nm.paragraph && h.start < nm.end && nm.start < h.end)
  );
  const hl = {
    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ...nm,
    type,
    color,
  };
  state.highlights.push(hl);
  window.getSelection()?.removeAllRanges();
  hideMarkToolbar();
  await persistHighlights();
  reRenderAffectedChapters([hl.chapter]);
}

async function updateMark(hl, type, color) {
  hl.type = type;
  hl.color = color;
  hideMarkToolbar();
  await persistHighlights();
  reRenderAffectedChapters([hl.chapter]);
}

async function deleteMark(hl) {
  hideMarkToolbar();
  state.highlights = state.highlights.filter((h) => h.id !== hl.id);
  await persistHighlights();
  reRenderAffectedChapters([hl.chapter]);
  toast("已删除划线");
}

/* ---------- 引用到书友（现有功能的原型呈现） ---------- */

function quotePending() {
  if (!pendingMark) return;
  quoteToCompanion(pendingMark.text);
}

function quoteMark(hl) {
  quoteToCompanion(hl.text);
}

function quoteToCompanion(text) {
  if (!text) return;
  state.pendingQuote = { text };
  window.getSelection()?.removeAllRanges();
  hideMarkToolbar();
  renderQuoteBar();
  openSidebar();
  $(".composer-row input").focus();
}

function openSidebar() {
  document.getElementById("sidebar").classList.add("open");
  document.querySelectorAll(".fab")[1]?.classList.add("active");
}

function renderQuoteBar() {
  const bar = $(".quote-bar");
  if (!bar) return;
  bar.textContent = "";
  if (!state.pendingQuote) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const q = el(
    "div",
    "quote-text",
    state.pendingQuote.text.slice(0, 120) + (state.pendingQuote.text.length > 120 ? "…" : ""),
  );
  const x = el("button", "quote-x", "×");
  x.title = "取消引用";
  x.addEventListener("click", () => {
    state.pendingQuote = null;
    renderQuoteBar();
  });
  bar.append(q, x);
}

/* ---------- 书友对话（每书一段连续对话；新对话/历史/清除） ---------- */

function saveThreads() {
  if (!state.bookId) return;
  writeLS(`bookmate.threads.${state.bookId}`, state.threads);
}

function renderThreadList() {
  const body = $(".sb-body");
  body.textContent = "";
  document.querySelector(".sb-viewbar")?.remove();
  const bar = el("div", "sb-viewbar");
  bar.append(el("span", null, "历史对话"));
  const back = el("button", null, "返回");
  back.addEventListener("click", () => {
    state.viewingList = false;
    renderChat();
  });
  bar.append(back);
  body.before(bar);
  if (!state.threads.length) {
    const empty = el("div", "sb-empty");
    empty.append(el("div", "seal", "史"), el("div", "eline", "还没有归档的对话"));
    body.append(empty);
    return;
  }
  [...state.threads].reverse().forEach((th) => {
    const first = th.messages.find((m) => m.role === "user");
    const item = el("div", "thread-item");
    item.append(
      el("div", "thread-date", new Date(th.createdAt).toLocaleString("zh-CN")),
      el("div", "thread-preview", `${first ? first.content.slice(0, 40) : "（空对话）"} · ${th.messages.length} 条`),
    );
    item.addEventListener("click", () => {
      state.viewingList = false;
      openThreadView(th.id);
    });
    body.append(item);
  });
}

function newConversation() {
  if (state.viewingThread) return;
  if (state.history.length === 0) return;
  state.threads.push({
    id: `th_${Date.now()}`,
    createdAt: new Date().toISOString(),
    messages: state.history.map((m) => ({ ...m })),
  });
  saveThreads();
  state.history = [];
  saveChatArchive();
  renderChat();
  toast("已展开新的对话，上一段已归入历史");
}

function clearConversation() {
  if (state.viewingThread) return;
  if (state.history.length === 0) return;
  confirmDialog("清除当前对话的全部记录？此操作不可恢复。", () => {
    state.history = [];
    saveChatArchive();
    renderChat();
    toast("对话已清除");
  });
}

function openThreadView(threadId) {
  const th = state.threads.find((t) => t.id === threadId);
  if (!th) return;
  state.viewingThread = th;
  renderChat();
}

function closeThreadView() {
  state.viewingThread = null;
  renderChat();
}

async function distillChapter() {
  if (!state.bookId || state.busy) return;
  state.busy = true;
  const btn = $(".distill-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "沉淀中…";
  }
  try {
    const res = await api(`/api/books/${state.bookId}/chapters/${state.chapterIdx}/distill`, {
      method: "POST",
      body: {},
    });
    toast(res.ok && res.note?.theme ? `已沉淀：${res.note.theme}` : "已沉淀本章");
  } catch (err) {
    toast(`沉淀失败：${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "沉淀本章";
    }
    state.busy = false;
  }
}

async function exportBook() {
  if (!state.bookId) {
    toast("请先选择一本书");
    return;
  }
  let dir;
  try {
    dir = await hanaPickDirectory();
  } catch {
    dir = undefined;
  }
  if (dir === null) return;
  try {
    toast("正在导出…");
    const res = await api(`/api/books/${state.bookId}/export`, {
      method: "POST",
      body: dir ? { dir } : {},
    });
    toast(`已导出：${res.path}`);
  } catch (err) {
    toast(err.message);
  }
}

function hanaPickDirectory() {
  return hana.resources
    .pick({ mode: "directory", multiple: false })
    .then((res) => res?.resources?.[0]?.path ?? null);
}

/* 当前书友的显示名：选定 agent 用其 id，默认助手用配置的人格名 */
function companionName() {
  return state.agentId ? state.agentId : state.settings?.companionName || "书友";
}

function saveChatArchive() {
  if (!state.bookId) return;
  writeLS(`bookmate.chat.${state.bookId}`, state.history);
}

async function sendMessage() {
  const input = $(".composer-row input");
  const message = input.value.trim();
  if ((!message && !state.pendingQuote) || state.busy || !state.bookId || state.viewingThread) return;
  const quote = state.pendingQuote?.text || undefined;
  const sendChapter = state.chapterIdx; // 上下文随当下阅读位置，记录仍是全书一段
  input.value = "";
  state.pendingQuote = null;
  renderQuoteBar();
  const userEntry = { role: "user", content: message || "这段话怎么理解？", quote };
  state.history.push(userEntry);
  saveChatArchive();
  renderChat();
  state.busy = true;
  $(".composer-row button").disabled = true;
  try {
    const reply = await converseStream(sendChapter, userEntry.content, quote);
    state.history.push({ role: "companion", content: reply });
    saveChatArchive();
  } catch (err) {
    state.history.push({ role: "companion", content: `（书友走神了：${err.message}）` });
    saveChatArchive();
  }
  state.busy = false;
  $(".composer-row button").disabled = false;
  renderChat();
}

/* 流式对话：fetch + ReadableStream 读 SSE，增量追加到消息气泡。返回完整回复。 */
async function converseStream(chapter, message, quote) {
  const url = `${apiBase}/api/books/${state.bookId}/converse/stream?appSurfaceSession=${encodeURIComponent(ticket)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chapter, message, agentId: state.agentId || undefined, quote }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  if (!res.body) throw new Error("流不可用");
  const bubble = appendStreamBubble();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "delta" && typeof ev.text === "string") {
          accumulated += ev.text;
          bubble.render(accumulated);
        } else if (ev.type === "done") {
          const reply = typeof ev.reply === "string" ? ev.reply : accumulated;
          bubble.render(reply);
          bubble.finish();
          return reply;
        } else if (ev.type === "error") {
          throw new Error(ev.error || "书友走神了");
        }
      }
    }
    bubble.render(accumulated);
    bubble.finish();
    return accumulated;
  } catch (err) {
    bubble.remove();
    throw err;
  }
}

function appendStreamBubble() {
  const body = $(".sb-body");
  const wrap = el("div", "letter");
  const html = el("div", "lbody md");
  wrap.append(html);
  body.append(wrap);
  body.scrollTop = body.scrollHeight;
  /* 逐字显现：宿主目前整条下发回复（无流式增量），前端按已收到文本递进展示；
     未来宿主真出增量时，delta 会推动 target 增长，同一套逻辑即变成真流式 */
  let target = "";
  let shown = 0;
  let timer = null;
  const tick = () => {
    if (shown >= target.length) { timer = null; return; }
    shown = Math.min(target.length, shown + Math.max(2, Math.round(target.length / 120)));
    html.innerHTML = mdToHtml(target.slice(0, shown));
    body.scrollTop = body.scrollHeight;
    timer = setTimeout(tick, 24);
  };
  return {
    render(text) {
      target = String(text ?? "");
      if (timer == null) tick();
    },
    finish() {
      if (!wrap.querySelector(".sign")) {
        wrap.append(el("div", "sign", "—— " + companionName()));
      }
    },
    remove() {
      clearTimeout(timer);
      wrap.remove();
    },
  };
}

function renderChat() {
  const body = $(".sb-body");
  body.textContent = "";
  const viewbar = document.querySelector(".sb-viewbar");
  if (viewbar) viewbar.remove();
  if (state.viewingThread) {
    const th = state.viewingThread;
    const bar = el("div", "sb-viewbar");
    bar.append(el("span", null, `历史对话 · ${new Date(th.createdAt).toLocaleDateString("zh-CN")}`));
    const back = el("button", null, "返回当前对话");
    back.addEventListener("click", closeThreadView);
    bar.append(back);
    body.before(bar);
    for (const m of th.messages) {
      body.append(buildMsgNode(m));
    }
    body.scrollTop = body.scrollHeight;
    return;
  }
  if (state.greeting) {
    const g = el("div", "letter");
    g.append(el("div", "lbody", state.greeting), el("div", "sign", "—— " + companionName()));
    body.append(g);
    state.greeting = null;
  }
  if (state.history.length === 0 && !body.children.length) {
    const empty = el("div", "sb-empty");
    empty.append(el("div", "seal", "书友"), el("div", "eline", "书读到此处，有话便说"));
    body.append(empty);
    return;
  }
  for (const m of state.history) {
    body.append(buildMsgNode(m));
  }
  body.scrollTop = body.scrollHeight;
}

function buildMsgNode(m) {
  if (m.role === "user") {
    const note = el("div", "note");
    if (m.quote) {
      note.append(el("div", "qref", m.quote.slice(0, 120) + (m.quote.length > 120 ? "…" : "")));
    }
    note.append(el("div", "ntext", m.content));
    return note;
  }
  const letter = el("div", "letter");
  if (m.quote) {
    letter.append(el("div", "qref", m.quote.slice(0, 120) + (m.quote.length > 120 ? "…" : "")));
  }
  const body = el("div", "lbody md");
  body.innerHTML = mdToHtml(m.content);
  letter.append(body, el("div", "sign", "—— " + companionName()));
  return letter;
}

/* ---------- 进度与阅读时长 ---------- */

const PAGE_CHARS = 500;

function computeProgress() {
  const totalChars = state.chapters.reduce((n, c) => n + (c.chars || 0), 0);
  let readChars = state.chapters.slice(0, state.chapterIdx).reduce((n, c) => n + (c.chars || 0), 0);
  const cur = state.chapters[state.chapterIdx];
  if (cur && cur.paragraphs > 0) {
    const last = state.lastVisiblePara ?? 0;
    readChars += Math.round((cur.chars || 0) * (Math.min(last + 1, cur.paragraphs) / cur.paragraphs));
  }
  const totalPages = Math.max(1, Math.round(totalChars / PAGE_CHARS));
  const readPages = Math.min(totalPages, Math.round(readChars / PAGE_CHARS));
  return { totalChars, readChars, totalPages, readPages };
}

function settleChapterStats() {
  if (state.chapterStartAt == null) return;
  const ms = Date.now() - state.chapterStartAt;
  state.chapterStartAt = null;
  if (ms < 3000) return;
  const prev = state.chapters[state.chapterIdx - 1];
  if (!prev?.chars) return;
  const st = readLS("bookmate.stats", { ms: 0, chars: 0 });
  st.ms += ms;
  st.chars += prev.chars;
  writeLS("bookmate.stats", st);
}

function computeEta() {
  const st = readLS("bookmate.stats", { ms: 0, chars: 0 });
  if (st.ms < 5 * 60 * 1000 || st.chars < 10 * PAGE_CHARS) return null;
  const speed = st.chars / st.ms;
  const { totalChars, readChars } = computeProgress();
  const remaining = Math.max(0, totalChars - readChars);
  const etaMs = remaining / speed;
  const h = Math.floor(etaMs / 3600000);
  const m = Math.max(1, Math.ceil((etaMs % 3600000) / 60000));
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function updateStatus() {
  if (!state.statusBar) return;
  if (!state.meta || !state.chapters.length) {
    state.statusBar.textContent = "选中文字可划线、可引用 · ✦ 打开书友";
    return;
  }
  const { totalPages, readPages } = computeProgress();
  const eta = computeEta();
  state.statusBar.textContent = `已读 ${readPages}/${totalPages} 页` + (eta ? ` · 预计还需 ${eta}` : "");
}

/* ---------- Markdown 轻量渲染 ---------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*`])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>");
}

function mdToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let inList = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre class="md-code">${codeBuf.join("\n")}</pre>`);
        codeBuf = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (!line.trim()) {
      if (inList) {
        out.push("</div>");
        inList = false;
      }
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      if (inList) {
        out.push("</div>");
        inList = false;
      }
      out.push(`<div class="md-h${h[1].length}">${inlineMd(h[2])}</div>`);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) {
        out.push('<div class="md-list">');
        inList = true;
      }
      out.push(`<div class="md-li">${inlineMd(li[1])}</div>`);
      continue;
    }
    if (inList) {
      out.push("</div>");
      inList = false;
    }
    const qt = /^>\s?(.*)$/.exec(line);
    if (qt) {
      out.push(`<div class="md-quote">${inlineMd(qt[1])}</div>`);
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      out.push('<div class="md-hr"></div>');
      continue;
    }
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="md-code">${codeBuf.join("\n")}</pre>`);
  if (inList) out.push("</div>");
  return out.join("");
}

/* ---------- 启动 ---------- */

buildLayout();
/* 宿主主题跟随：订阅宿主外观，应用主题为「跟随」时实时切换 */
window.__hostAppearance = hana.theme?.getSnapshot?.()?.appearance || "light";
hana.theme?.subscribe?.((snap) => {
  window.__hostAppearance = snap?.appearance || "light";
  const s = getReaderSettings();
  if (s.theme === "follow") applyReaderSettings(s);
});
applyReaderSettings(getReaderSettings());
ensureFontFaces();
loadBooks();
