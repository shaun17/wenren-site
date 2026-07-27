import { spatialAvatarAssets } from "../config/spatial-avatar-assets";

export interface SpatialAvatarModelLoad {
  bytes: Promise<ArrayBuffer>;
  source: "http-cache" | "network";
}

const MODEL_CACHE_PROBE_TIMEOUT_MS = 48;

/** 给提前启动的模型 Promise 安装拒绝观察器，场景模块尚未就绪时也不会产生未处理错误。 */
const observeModelLoad = (
  modelLoad: Promise<ArrayBuffer>,
): Promise<ArrayBuffer> => {
  void modelLoad.catch(() => undefined);
  return modelLoad;
};

/**
 * 使用统一的同源请求读取模型字节，让首页预取与 Avatar 页面加载共享浏览器 HTTP 缓存。
 */
export const loadSpatialAvatarModelBytes = async (
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<ArrayBuffer> => {
  const response = await request(spatialAvatarAssets.model, {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`模型请求失败：${response.status}`);
  return response.arrayBuffer();
};

/**
 * 在极短时间内检查内容寻址模型是否已进入 HTTP 缓存。
 * 热命中直接复用同一个响应；未命中、超时或浏览器不支持时立即走正常请求。
 */
export const prepareSpatialAvatarModelLoad = async (
  signal?: AbortSignal,
  request: typeof fetch = fetch,
  cacheProbeTimeoutMs = MODEL_CACHE_PROBE_TIMEOUT_MS,
): Promise<SpatialAvatarModelLoad> => {
  const cacheProbeController = new AbortController();
  let cacheProbeTimedOut = false;

  /** 页面释放时同步终止只读缓存探测，不让旧页面继续影响加载状态。 */
  const handleAbort = (): void => {
    cacheProbeController.abort(signal?.reason);
  };
  if (signal?.aborted) handleAbort();
  else signal?.addEventListener("abort", handleAbort, { once: true });

  let cacheProbeTimeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const cacheProbeTimeout = new Promise<null>((resolve) => {
    cacheProbeTimeoutId = globalThis.setTimeout(() => {
      cacheProbeTimedOut = true;
      cacheProbeController.abort();
      resolve(null);
    }, cacheProbeTimeoutMs);
  });

  /** 缓存 miss 在不同 Chromium 版本中可能表现为 504 或 TypeError，统一收敛为 null。 */
  const cachedResponse = request(spatialAvatarAssets.model, {
    cache: "only-if-cached",
    credentials: "same-origin",
    mode: "same-origin",
    signal: cacheProbeController.signal,
  })
    .then((response) => {
      if (!cacheProbeTimedOut) return response;
      if (response.body) void response.body.cancel().catch(() => undefined);
      return null;
    })
    .catch(() => null);

  const response = await Promise.race([cachedResponse, cacheProbeTimeout]);
  if (cacheProbeTimeoutId !== undefined) {
    globalThis.clearTimeout(cacheProbeTimeoutId);
  }
  signal?.removeEventListener("abort", handleAbort);

  if (response?.ok && !cacheProbeTimedOut) {
    return {
      bytes: observeModelLoad(response.arrayBuffer()),
      source: "http-cache",
    };
  }
  if (response?.body) void response.body.cancel().catch(() => undefined);

  return {
    bytes: observeModelLoad(loadSpatialAvatarModelBytes(signal, request)),
    source: "network",
  };
};
