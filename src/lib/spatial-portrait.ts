type SceneCleanup = () => void;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 初始化空间肖像的轻量入口。
 * 只有允许动态效果时才加载 Three.js 与 GLTFLoader，静态访问不会承担三维依赖。
 */
export const initSpatialPortrait = (root: HTMLElement): SceneCleanup => {
  if (root.dataset.spatialInitialized === "true") return () => undefined;

  const page = root.closest<HTMLElement>("[data-spatial-page]");
  const status = root.querySelector<HTMLElement>("[data-spatial-status]");
  if (!page) return () => undefined;

  root.dataset.spatialInitialized = "true";
  const motionPreference = window.matchMedia(REDUCED_MOTION_QUERY);
  const abortController = new AbortController();
  const { signal } = abortController;
  let sceneCleanup: SceneCleanup | null = null;
  let loadVersion = 0;
  let isDisposed = false;

  /** 释放已经运行的三维场景，并回到服务端默认的同模型海报。 */
  const activateStaticPoster = (
    rootClass: "is-static" | "is-webgl-unavailable",
    message: string,
  ): void => {
    loadVersion += 1;
    sceneCleanup?.();
    sceneCleanup = null;
    root.classList.remove(
      "is-webgl-ready",
      "is-static",
      "is-webgl-unavailable",
    );
    root.classList.add(rootClass);
    page.classList.add("is-spatial-static");
    if (status) status.textContent = message;
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
          root.classList.remove("is-webgl-ready", "is-static");
          root.classList.add("is-webgl-unavailable");
          page.classList.add("is-spatial-static");
          if (status) status.textContent = message;
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
