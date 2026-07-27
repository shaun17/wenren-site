import { SPATIAL_AVATAR_READING_PHASE_RATIO } from "../config/spatial-avatar-layout";
import { prepareSpatialAvatarModelLoad } from "./spatial-avatar-model";

type SceneCleanup = () => void;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const MODEL_LOADING_CLASSES = [
  "is-cache-probing",
  "is-loading-poster-visible",
  "is-model-cache-warm",
  "is-model-bytes-ready",
] as const;

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
  let phaseUpdateId = 0;
  let pendingSceneLoadController: AbortController | null = null;

  /** 同步首屏与阅读态，静态降级在边界处直接换图而不制造额外动画。 */
  const updatePortraitPhase = (): void => {
    const hero = page.querySelector<HTMLElement>("[data-spatial-hero]");
    const pageTop = page.getBoundingClientRect().top + window.scrollY;
    const transitionDistance =
      (hero?.offsetHeight ?? window.innerHeight) *
      SPATIAL_AVATAR_READING_PHASE_RATIO;
    const isContentPhase = window.scrollY - pageTop >= transitionDistance;
    page.classList.toggle("is-content-phase", isContentPhase);
    if (isContentPhase && !root.classList.contains("is-webgl-ready")) {
      void ensureStaticPoster();
    }
  };

  /** 合并高频滚动事件，确保降级海报每帧最多判断一次展示阶段。 */
  const schedulePortraitPhaseUpdate = (): void => {
    if (phaseUpdateId || isDisposed) return;
    phaseUpdateId = window.requestAnimationFrame(() => {
      phaseUpdateId = 0;
      updatePortraitPhase();
    });
  };

  /** 按需加载静态降级海报；正常 WebGL 首屏不会为不可见图片浪费请求。 */
  const loadStaticPoster = (): Promise<boolean> => {
    if (staticPosterLoad) return staticPosterLoad;
    if (!staticPosterSource || !staticPosterImage) {
      return Promise.resolve(false);
    }

    staticPosterSource.srcset = staticPosterSource.dataset.srcset ?? "";
    staticPosterImage.src = staticPosterImage.dataset.src ?? "";
    if (staticPosterImage.complete) {
      const loaded = staticPosterImage.naturalWidth > 0;
      if (!loaded) {
        staticPosterSource.removeAttribute("srcset");
        staticPosterImage.removeAttribute("src");
      }
      return Promise.resolve(loaded);
    }

    const loadAttempt = new Promise<boolean>((resolve) => {
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
    staticPosterLoad = loadAttempt.then((loaded) => {
      if (!loaded) {
        staticPosterLoad = null;
        staticPosterSource.removeAttribute("srcset");
        staticPosterImage.removeAttribute("src");
      }
      return loaded;
    });
    return staticPosterLoad;
  };

  /** 只有静态海报真实加载成功后才允许 CSS 切图，失败时继续保留可用近景。 */
  const ensureStaticPoster = (): Promise<boolean> =>
    loadStaticPoster().then((loaded) => {
      if (isDisposed) return false;
      root.classList.toggle("is-static-poster-ready", loaded);
      return loaded;
    });
  /** 释放已经运行的三维场景，并回到服务端默认的同模型海报。 */
  const activateStaticPoster = (
    rootClass: "is-static" | "is-webgl-unavailable",
    message: string,
  ): void => {
    const version = ++loadVersion;
    pendingSceneLoadController?.abort();
    pendingSceneLoadController = null;
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove(
      "is-webgl-ready",
      "is-static",
      "is-webgl-unavailable",
      ...MODEL_LOADING_CLASSES,
    );
    root.classList.add("is-loading-poster-visible");
    page.classList.add("is-spatial-static");
    if (status) status.textContent = message;
    void ensureStaticPoster().then((loaded) => {
      if (!loaded || isDisposed || version !== loadVersion) return;
      root.classList.remove(...MODEL_LOADING_CLASSES);
      root.classList.add(rootClass);
    });
  };

  /** 按当前动态偏好异步建立真实 GLB 场景，并忽略已经过期的加载结果。 */
  const startScene = async (): Promise<void> => {
    const version = ++loadVersion;
    pendingSceneLoadController?.abort();
    pendingSceneLoadController = null;
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove(
      "is-static",
      "is-webgl-unavailable",
      "is-webgl-ready",
      ...MODEL_LOADING_CLASSES,
    );
    root.classList.add("is-cache-probing");
    page.classList.add("is-spatial-static");
    if (status) status.textContent = "正在加载三维人物模型。";

    if (!supportsSpatialAvatarWebGL()) {
      activateStaticPoster(
        "is-webgl-unavailable",
        "当前浏览器无法运行三维场景，已展示同模型静态海报。",
      );
      return;
    }

    const sceneLoadController = new AbortController();
    pendingSceneLoadController = sceneLoadController;

    try {
      const sceneModule = import("./spatial-avatar-scene");
      const modelLoad = await prepareSpatialAvatarModelLoad(
        sceneLoadController.signal,
      );
      if (
        isDisposed ||
        sceneLoadController.signal.aborted ||
        motionPreference.matches ||
        version !== loadVersion
      ) {
        sceneLoadController.abort();
        return;
      }

      root.classList.remove("is-cache-probing");
      if (modelLoad.source === "http-cache") {
        root.classList.add("is-model-cache-warm");
        if (status) status.textContent = "三维人物模型正在解析。";
      } else {
        root.classList.add("is-loading-poster-visible");
      }

      const { initSpatialAvatarScene } = await sceneModule;
      if (
        isDisposed ||
        sceneLoadController.signal.aborted ||
        motionPreference.matches ||
        version !== loadVersion
      ) {
        sceneLoadController.abort();
        return;
      }

      const cleanupScene = initSpatialAvatarScene(root, {
        modelBytes: modelLoad.bytes,
        onDispose: (): void => {
          sceneLoadController.abort();
        },
        onModelBytesReady: (): void => {
          if (
            isDisposed ||
            sceneLoadController.signal.aborted ||
            version !== loadVersion
          ) {
            return;
          }
          root.classList.remove(
            "is-cache-probing",
            "is-loading-poster-visible",
            "is-model-cache-warm",
          );
          root.classList.add("is-model-bytes-ready");
          if (status) status.textContent = "三维人物模型正在解析。";
        },
        onReady: (): void => {
          if (
            isDisposed ||
            sceneLoadController.signal.aborted ||
            version !== loadVersion
          ) {
            return;
          }
          pendingSceneLoadController = null;
          root.classList.remove(
            "is-static",
            "is-webgl-unavailable",
            ...MODEL_LOADING_CLASSES,
          );
          root.classList.add("is-webgl-ready");
          page.classList.remove("is-spatial-static");
          if (status) status.textContent = "三维人物模型已加载。";
        },
        onStaticPosterRequested: (): void => {
          void ensureStaticPoster();
        },
        onUnavailable: (message: string): void => {
          if (isDisposed || version !== loadVersion) return;
          activateStaticPoster("is-webgl-unavailable", message);
        },
      });
      if (
        isDisposed ||
        sceneLoadController.signal.aborted ||
        version !== loadVersion
      ) {
        cleanupScene();
        return;
      }
      sceneCleanup = (): void => {
        sceneLoadController.abort();
        if (pendingSceneLoadController === sceneLoadController) {
          pendingSceneLoadController = null;
        }
        cleanupScene();
      };
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
    if (phaseUpdateId) window.cancelAnimationFrame(phaseUpdateId);
    phaseUpdateId = 0;
    pendingSceneLoadController?.abort();
    pendingSceneLoadController = null;
    abortController.abort();
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove("is-static-poster-ready");
    page.classList.remove("is-content-phase");
    delete root.dataset.spatialInitialized;
  };

  window.addEventListener("scroll", schedulePortraitPhaseUpdate, {
    passive: true,
    signal,
  });
  window.addEventListener("resize", schedulePortraitPhaseUpdate, {
    passive: true,
    signal,
  });
  motionPreference.addEventListener("change", reconcileMotionPreference, { signal });
  document.addEventListener("astro:before-swap", cleanup, { once: true, signal });
  updatePortraitPhase();
  reconcileMotionPreference();
  return cleanup;
};
