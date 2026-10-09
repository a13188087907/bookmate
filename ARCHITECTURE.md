# BookMate 架构

一页纸讲清 BookMate 的结构与数据流向，给想读代码或贡献的人。

## 分层

```
index.js                  入口：defineApp 装配（store / parser / companion / 工具注册 / 角色兜底创建）
manifest.json             清单：能力声明、设置 schema、卡片声明（structural page）
roles/shuyou/card.json    内嵌「书友」角色包：人格文本随应用分发，宿主托管只读模板
routes/api.js             Hono 后端路由：书库 / 章节 / 进度 / 划线 / 对话 / 沉淀 / 导出
lib/
  store-v3.js             本地 JSON 存储（app-data/bookmate/：meta / chapters / progress / highlights）
  epub-parse.js           EPUB 解析（调用本机 Python：scripts/parse_epub.py）
  session-companion-v2.js 书友会话通道：每书+每助手一个插件私有会话（session:create/send/history）
  companion-agent.js      书友 Agent 创建与复用（agent:create-from-role 主路径，agent:create 兜底）
  companion.js            对话提示词组装（章节上下文 + 骨架 + 引用）
  skeleton.js             全书骨架：章节沉淀笔记的生成与注入
  export.js               导出 Markdown（骨架 / 立场演变 / 划线）
src/runtime.js            运行时单例（同进程 ESM 模块缓存，routes 与入口共享状态）
ui/
  reader.html             静态壳 + 启动引导（无构建步骤）
  assets/reader.js        阅读器全部前端逻辑（窗口化滚动 / 划线 / 尺牍对话 / 导轨 / 排版面板）
  assets/reader.css       设计令牌与全部样式（body[data-theme] 主题变量）
sdk/                      打包时随附的 App SDK 本地副本（安装后不依赖宿主 node_modules）
scripts/parse_epub.py     EPUB 解析辅助脚本
```

## 数据流

**阅读**：EPUB → Python 解析 → 章节 JSON 存 app-data → UI 按章懒加载正文，窗口化渲染（±1 章渲染、±2 章保留、滚动补偿卸载）。

**对话**：UI 选中句子/输入 → `POST /api/books/<id>/converse/stream`（SSE）→ 路由解析伴读 agentId（UI 显式选择 > 设置项 companionAgentId > ensure 创建）→ session-companion 按 书+助手 复用或创建插件私有会话 → 注入章节上下文 + 全书骨架 + 引用 → 宿主模型通道返回 → 前端打字机显现为信笺。

**骨架**：「沉淀本章」→ 章节节选 + 近期对话 → 宿主 utility 模型 → 结构化 JSON 存入书数据 → 后续对话自动注入。

**划线**：前端按（章节 idx · 段落 idx · start · end）锚定存 app-data/highlights；窗口卸载重排不丢。

## 关键设计

- **每书一段连续对话**：聊天归档不按章切分；发送时的章节只作为上下文，不作为归档边界。新对话归档进 threads（本地，可回看），清除只清当前段
- **书友人格走 v2 角色包**：`roles/shuyou/` 是只读模板，宿主在首次创建时打下 `plugin_private` 归属；人格升级随应用版本分发，用户的私有实例不受影响
- **模型不指定**：会话创建不传 model，一路回落到用户默认模型；应用不过手任何第三方 API
- **启动 IO 推迟**：激活窗口内的重活（存储装载、角色兜底）延迟执行，避免激活期 RPC 故障被归因为装载失败

## 已知边界

- EPUB 解析依赖本机 Python（设置项可配命令名）；无 Python 环境时导入不可用，其余功能不受影响
- 宿主当前对伴读会话不下发流式增量（单条 delta），前端的逐字显现是客户端模拟；宿主真出增量时同一套逻辑自动变成真流式
