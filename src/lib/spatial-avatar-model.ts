import { spatialAvatarAssets } from "../config/spatial-avatar-assets";

/**
 * 使用统一的同源请求读取模型字节，让首页预取与 Avatar 页面加载共享浏览器 HTTP 缓存。
 */
export const loadSpatialAvatarModelBytes = async (
  signal?: AbortSignal,
): Promise<ArrayBuffer> => {
  const response = await fetch(spatialAvatarAssets.model, {
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`模型请求失败：${response.status}`);
  return response.arrayBuffer();
};
