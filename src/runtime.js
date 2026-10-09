// 跨模块共享运行时：defineApp 入口创建后写入，routes/lib 从这里取。
// v2 的 routes/ 与 index.js 在同一进程同一 ESM 模块缓存，单例可靠
// （v1 需要把共享态挂到 ctx 上，是因为 v1 的各装载点分处不同模块上下文，v2 没这个问题）。

export const runtime = { current: null };

export function setRuntime(r) {
  runtime.current = r;
}

export function requireRuntime() {
  if (!runtime.current?.store) {
    throw new Error("书友尚未初始化，请确认应用已启用。");
  }
  return runtime.current;
}
