import { spatialAvatarAssets } from "../config/spatial-avatar-assets";
import { loadSpatialAvatarModelBytes } from "./spatial-avatar-model";

interface SpatialAvatarPrefetchConditions {
  effectiveType?: string;
  reducedMotion: boolean;
  saveData: boolean;
}

interface NavigatorConnection {
  effectiveType?: string;
  saveData?: boolean;
}

interface IdlePrefetchWindow {
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions,
  ) => number;
}

const SLOW_CONNECTION_TYPES = new Set(["slow-2g", "2g"]);
let prefetchStarted = false;

/** 只在模型确实会使用且网络允许时预取，避免浪费省流量或慢网用户的带宽。 */
export const shouldPrefetchSpatialAvatar = ({
  effectiveType,
  reducedMotion,
  saveData,
}: SpatialAvatarPrefetchConditions): boolean =>
  !reducedMotion &&
  !saveData &&
  !SLOW_CONNECTION_TYPES.has(effectiveType ?? "");

/** 自动空闲预取只用于浏览器明确报告的快速网络；未知网况与 3G 只响应用户意图。 */
export const shouldIdlePrefetchSpatialAvatar = (
  conditions: SpatialAvatarPrefetchConditions,
): boolean =>
  shouldPrefetchSpatialAvatar(conditions) &&
  conditions.effectiveType === "4g";

/** 检查浏览器能否用低优先级资源提示预取未来页面所需的 GLB。 */
const supportsNativePrefetch = (): boolean => {
  const link = document.createElement("link");
  return (
    typeof link.relList.supports === "function" &&
    link.relList.supports("prefetch")
  );
};

/** 幂等启动模型缓存预热；不把可选优化的失败暴露成页面错误。 */
const startSpatialAvatarPrefetch = (): void => {
  if (prefetchStarted) return;
  prefetchStarted = true;

  if (supportsNativePrefetch()) {
    const hint = document.createElement("link");
    hint.rel = "prefetch";
    hint.as = "fetch";
    hint.href = spatialAvatarAssets.model;
    hint.crossOrigin = "anonymous";
    hint.dataset.spatialAvatarPrefetch = "";
    document.head.append(hint);
    return;
  }

  void loadSpatialAvatarModelBytes().catch(() => undefined);
};

/** 在首页空闲时预取，并让 hover、键盘焦点或触摸提前触发同一个幂等任务。 */
export const initSpatialAvatarPrefetch = (
  avatarLink: HTMLAnchorElement,
): void => {
  const navigatorWithConnection = navigator as Navigator & {
    connection?: NavigatorConnection;
  };
  const connection = navigatorWithConnection.connection;
  const conditions: SpatialAvatarPrefetchConditions = {
    effectiveType: connection?.effectiveType,
    reducedMotion: window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches,
    saveData: connection?.saveData === true,
  };
  if (!shouldPrefetchSpatialAvatar(conditions)) return;

  const trigger = (): void => startSpatialAvatarPrefetch();
  avatarLink.addEventListener("pointerenter", trigger, {
    once: true,
    passive: true,
  });
  avatarLink.addEventListener("focus", trigger, { once: true });
  avatarLink.addEventListener("touchstart", trigger, {
    once: true,
    passive: true,
  });
  if (!shouldIdlePrefetchSpatialAvatar(conditions)) return;

  /** 等首页完成关键加载后再安排低优先级预取，避免与字体和首屏样式争抢。 */
  const scheduleIdlePrefetch = (): void => {
    const idleWindow = window as unknown as IdlePrefetchWindow;
    if (typeof idleWindow.requestIdleCallback === "function") {
      idleWindow.requestIdleCallback(trigger, { timeout: 1_500 });
      return;
    }
    window.setTimeout(trigger, 250);
  };

  if (document.readyState === "complete") scheduleIdlePrefetch();
  else window.addEventListener("load", scheduleIdlePrefetch, { once: true });
};
