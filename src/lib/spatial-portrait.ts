import { spatialAvatarAssets } from "../config/spatial-avatar-assets";

type SceneCleanup = () => void;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 用轻量原生能力检测排除无 WebGL2 设备，并立即释放探测上下文。 */
export const supportsSpatialAvatarWebGL = (
  createCanvas: () => HTMLCanvasElement = () =>
    document.createElement("canvas"),
): boolean => {
  try {
    const context = createCanvas().getContext("webgl2", {
      powerPreference: "high-performance",
    });
    if (!context) return false;
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
};

/**
 * 初始化空间肖像的轻量入口。
 * 只有允许动态效果时才加载 Three.js 与 GLTFLoader，静态访问不会承担三维依赖。
 */
export const initSpatialPortrait = (root: HTMLElement): SceneCleanup => {
  if (root.dataset.spatialInitialized === "true") return () => undefined;

  const page = root.closest<HTMLElement>("[data-spatial-page]");
  const status = root.querySelector<HTMLElement>("[data-spatial-status]");
  const staticPosterSource = root.querySelector<HTMLSourceElement>(
    "[data-spatial-static-source]",
  );
  const staticPosterImage = root.querySelector<HTMLImageElement>(
    "[data-spatial-static-image]",
  );
  if (!page) return () => undefined;

  root.dataset.spatialInitialized = "true";
  const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY);
  const abortController = new AbortController();
  const { signal } = abortController;
  let sceneCleanup: SceneCleanup | null = null;
  let loadVersion = 0;
  let isDisposed = false;
  let staticPosterLoad: Promise<boolean> | null = null;

  /** 按需加载静态降级海报；正常 WebGL 首屏不会为不可见图片浪费请求。 */
  const loadStaticPoster = (): Promise<boolean> => {
    if (staticPosterLoad) return staticPosterLoad;
    if (!staticPosterSource || !staticPosterImage) {
      return Promise.resolve(false);
    }

    staticPosterSource.srcset = staticPosterSource.dataset.srcset ?? "";
    staticPosterImage.src = staticPosterImage.dataset.src ?? "";
    if (staticPosterImage.complete) {
      return Promise.resolve(staticPosterImage.naturalWidth > 0);
    }

    staticPosterLoad = new Promise<boolean>((resolve) => {
      /** 收敛图片加载、失败与页面释放三种结果，并移除本次临时监听器。 */
      const finish = (loaded: boolean): void => {
        staticPosterImage.removeEventListener("load", handleLoad);
        staticPosterImage.removeEventListener("error", handleError);
        signal.removeEventListener("abort", handleAbort);
        resolve(loaded);
      };
      const handleLoad = (): void => finish(true);
      const handleError = (): void => finish(false);
      const handleAbort = (): void => finish(false);
      staticPosterImage.addEventListener("load", handleLoad, { once: true });
      staticPosterImage.addEventListener("error", handleError, { once: true });
      signal.addEventListener("abort", handleAbort, { once: true });
    });
    return staticPosterLoad;
  };

  /** WebGL 可用后再让模型与 Three.js 场景包并行下载，避免无能力设备获取完整 GLB。 */
  const preloadSpatialAvatarModel = (): void => {
    if (document.head.querySelector("[data-spatial-avatar-preload]")) return;
    const preload = document.createElement("link");
    preload.rel = "preload";
    preload.as = "fetch";
    preload.href = spatialAvatarAssets.model;
    preload.crossOrigin = "anonymous";
    preload.fetchPriority = "low";
    preload.dataset.spatialAvatarPreload = "";
    document.head.append(preload);
  };

  /** 释放已经运行的三维场景，并回到服务端默认的同模型海报。 */
  const activateStaticPoster = (
    rootClass: "is-static" | "is-webgl-unavailable",
    message: string,
  ): void => {
    const version = ++loadVersion;
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove(
      "is-webgl-ready",
      "is-static",
      "is-webgl-unavailable",
    );
    page.classList.add("is-spatial-static");
    if (status) status.textContent = message;
    void loadStaticPoster().then((loaded) => {
      if (!loaded || isDisposed || version !== loadVersion) return;
      root.classList.add(rootClass);
    });
  };

  /** 按当前动态偏好异步建立真实 GLB 场景，并忽略已经过期的加载结果。 */
  const startScene = async (): Promise<void> => {
    const version = ++loadVersion;
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove(
      "is-static",
      "is-webgl-unavailable",
      "is-webgl-ready",
    );
    page.classList.add("is-spatial-static");
    if (status) status.textContent = "正在加载三维人物模型。";

    if (!supportsSpatialAvatarWebGL()) {
      activateStaticPoster(
        "is-webgl-unavailable",
        "当前浏览器无法运行三维场景，已展示同模型静态海报。",
      );
      return;
    }
    preloadSpatialAvatarModel();

    try {
      const { initSpatialAvatarScene } = await import("./spatial-avatar-scene");
      if (isDisposed || motionPreference.matches || version !== loadVersion) return;

      sceneCleanup = initSpatialAvatarScene(root, {
        onReady: (): void => {
          if (isDisposed || version !== loadVersion) return;
          root.classList.remove("is-static", "is-webgl-unavailable");
          root.classList.add("is-webgl-ready");
          page.classList.remove("is-spatial-static");
          if (status) status.textContent = "三维人物模型已加载。";
        },
        onUnavailable: (message: string): void => {
          if (isDisposed || version !== loadVersion) return;
          activateStaticPoster("is-webgl-unavailable", message);
        },
      });
    } catch {
      if (isDisposed || version !== loadVersion) return;
      activateStaticPoster(
        "is-webgl-unavailable",
        "三维场景加载失败，当前展示同模型静态海报。",
      );
    }
  };

  /** 运行中切换“减少动态”时立即释放 GPU，再次允许动态时重新加载。 */
  const reconcileMotionPreference = (): void => {
    if (motionPreference.matches) {
      activateStaticPoster("is-static", "已根据动态偏好展示同模型静态海报。");
      return;
    }
    void startScene();
  };

  /** 幂等释放入口监听器与可能存在的三维场景。 */
  const cleanup = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    loadVersion += 1;
    abortController.abort();
    sceneCleanup?.();
    sceneCleanup = null;
    delete root.dataset.spatialInitialized;
  };

  motionPreference.addEventListener("change", reconcileMotionPreference, { signal });
  document.addEventListener("astro:before-swap", cleanup, { once: true, signal });
  reconcileMotionPreference();
  return cleanup;
};
