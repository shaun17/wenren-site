import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { SPATIAL_AVATAR_READING_PHASE_RATIO } from "../config/spatial-avatar-layout";

export interface PortraitLayoutFrame {
  modelX: number;
  modelY: number;
  scale: number;
}

interface PortraitLayoutMetrics {
  pageTop: number;
  transitionDistance: number;
}

interface SpatialAvatarSceneCallbacks {
  modelBytes: Promise<ArrayBuffer>;
  onDispose: () => void;
  onModelBytesReady: () => void;
  onReady: () => void;
  onStaticPosterRequested: () => void;
  onUnavailable: (message: string) => void;
}

interface EyeRig {
  baseQuaternion: THREE.Quaternion;
  pivot: THREE.Object3D;
  targetQuaternion: THREE.Quaternion;
}

interface PointerGazeRegion {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
}

interface EyeRigContract {
  meshNames: readonly string[];
  pivotName: string;
}

const EYE_RIG_CONTRACTS: readonly EyeRigContract[] = [
  {
    pivotName: "EyeAimL",
    meshNames: [
      "Eye_L",
      "EyeHighlightMainL",
      "EyeHighlightSmallL",
      "IrisL",
      "IrisAccentL",
      "IrisRingL",
      "PupilL",
    ],
  },
  {
    pivotName: "EyeAimR",
    meshNames: [
      "Eye_R",
      "EyeHighlightMainR",
      "EyeHighlightSmallR",
      "IrisR",
      "IrisAccentR",
      "IrisRingR",
      "PupilR",
    ],
  },
] as const;
const MAX_EYE_YAW = THREE.MathUtils.degToRad(22);
const MAX_EYE_PITCH = THREE.MathUtils.degToRad(13);
const AVATAR_TARGET_EXTENT = 1.9;
// 新模型的局部 +Y 朝向相机，-Z 与 +X 分别对应画面水平和垂直转动轴。
const EYE_YAW_AXIS = new THREE.Vector3(0, 0, -1);
const EYE_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const MODEL_DAMPING = 8.5;
const EYE_DAMPING = 13;
const SETTLE_EPSILON = 0.00008;
const DEFAULT_CAMERA_Y = 0.03;
const DEFAULT_CAMERA_Z = 3.8;
const DEFAULT_CAMERA_TARGET_Y = 0.02;
const DEFAULT_GAZE_X = 0;
const DEFAULT_GAZE_Y = 0.04;
export const PORTRAIT_TONE_MAPPING_EXPOSURE = 0.92;
export const PORTRAIT_ENVIRONMENT_INTENSITY = 0.38;

/** 生成中性影棚环境贴图，让 PBR 材质接收到模型四周真实的反射光。 */
const createPortraitEnvironment = (
  renderer: THREE.WebGLRenderer,
): THREE.WebGLRenderTarget => {
  const environmentScene = new RoomEnvironment();
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  try {
    return pmremGenerator.fromScene(environmentScene, 0.035);
  } finally {
    environmentScene.dispose();
    pmremGenerator.dispose();
  }
};

/** 建立柔和暖主光、中性灰蓝补光与背部轮廓光，在米白环境中保留自然肤色。 */
export const createPortraitLightRig = (): THREE.Group => {
  const lightRig = new THREE.Group();
  lightRig.name = "PortraitLightRig";

  const hemisphere = new THREE.HemisphereLight(0xfff8ee, 0xa9aaa4, 1.3);
  hemisphere.name = "PortraitHemisphereLight";

  const keyLight = new THREE.DirectionalLight(0xffe0c5, 2.05);
  keyLight.name = "PortraitKeyLight";
  keyLight.position.set(2.8, 4.2, 5.2);

  const fillLight = new THREE.DirectionalLight(0xdce5ea, 0.9);
  fillLight.name = "PortraitFillLight";
  fillLight.position.set(-3.8, 1.6, 4.1);

  const rimLight = new THREE.DirectionalLight(0xf7f3eb, 0.78);
  rimLight.name = "PortraitRimLight";
  rimLight.position.set(0.7, 2.7, -4.2);

  lightRig.add(hemisphere, keyLight, fillLight, rimLight);
  return lightRig;
};

/** 按模型声明的本地轴组合目光，并把增量叠加到眼球初始姿态。 */
export const setEyeTargetQuaternion = (
  baseQuaternion: THREE.Quaternion,
  targetQuaternion: THREE.Quaternion,
  gazeX: number,
  gazeY: number,
  gazeRotation = new THREE.Quaternion(),
  gazeYaw = new THREE.Quaternion(),
  gazePitch = new THREE.Quaternion(),
): THREE.Quaternion => {
  gazeYaw.setFromAxisAngle(EYE_YAW_AXIS, gazeX * MAX_EYE_YAW);
  gazePitch.setFromAxisAngle(EYE_PITCH_AXIS, gazeY * MAX_EYE_PITCH);
  gazeRotation.copy(gazeYaw).multiply(gazePitch);
  return targetQuaternion.copy(baseQuaternion).multiply(gazeRotation);
};

/** 把数值限制在指定区间，统一保护滚动与指针输入。 */
const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** 模型完成且 WebGL 上下文可用时，画布才具备安全展示条件。 */
export const canPresentSpatialAvatarScene = (
  sceneReady: boolean,
  isContextLost: boolean,
): boolean => sceneReady && !isContextLost;

/** 以双眼在屏幕上的实际中心为原点，把指针位置映射到受限目光范围。 */
export const mapPointerToGaze = (
  clientX: number,
  clientY: number,
  region: PointerGazeRegion,
): { x: number; y: number } => ({
  x: clamp((clientX - region.centerX) / Math.max(1, region.radiusX), -1, 1),
  y: clamp((clientY - region.centerY) / Math.max(1, region.radiusY), -1, 1),
});

/** 按相机视图空间的纵深计算透视尺度，避免人物横向移动误触发缩放。 */
export const readPortraitDepthScale = (
  camera: THREE.Camera,
  worldPosition: THREE.Vector3,
  viewPosition = new THREE.Vector3(),
): number => {
  viewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse);
  return DEFAULT_CAMERA_Z / Math.max(0.5, -viewPosition.z);
};

/** 在两个关键值之间做线性插值，统一生成每个姿态通道。 */
const interpolate = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount;

/** 让首屏与阅读态之间自然减速，避免缩放和左移突然停止。 */
const easeLayoutAmount = (amount: number): number =>
  amount * amount * (3 - 2 * amount);

/** 只生成首屏近景和固定阅读态，目录数量不再决定三维人物姿态。 */
export const createPortraitLayoutFrames = (
  compact: boolean,
): readonly [PortraitLayoutFrame, PortraitLayoutFrame] => {
  return compact
    ? [
        {
          modelX: 0,
          modelY: -0.2,
          scale: 1.24,
        },
        {
          modelX: 0,
          modelY: 0.1,
          scale: 0.84,
        },
      ]
    : [
        {
          modelX: 0,
          modelY: -0.46,
          scale: 1.48,
        },
        {
          modelX: -0.72,
          modelY: -0.015,
          scale: 0.94,
        },
      ];
};

/** 只在首屏滚动区间插值，进入阅读态后始终返回同一份固定布局。 */
export const readPortraitLayoutFrame = (
  progress: number,
  frames: readonly [PortraitLayoutFrame, PortraitLayoutFrame],
): PortraitLayoutFrame => {
  const amount = easeLayoutAmount(clamp(progress, 0, 1));
  const [heroFrame, readingFrame] = frames;
  return {
    modelX: interpolate(heroFrame.modelX, readingFrame.modelX, amount),
    modelY: interpolate(heroFrame.modelY, readingFrame.modelY, amount),
    scale: interpolate(heroFrame.scale, readingFrame.scale, amount),
  };
};

/** 把页面滚动距离限制在首屏过渡内，后续目录滚动不再改变模型。 */
export const readPortraitLayoutProgress = (
  scrollY: number,
  pageTop: number,
  transitionDistance: number,
): number =>
  clamp(
    (scrollY - pageTop) / Math.max(1, transitionDistance),
    0,
    1,
  );

/** 按当前断点选择桌面或紧凑布局，尺寸变化后重新生成两种状态。 */
const createResponsivePortraitLayoutFrames = (): readonly [
  PortraitLayoutFrame,
  PortraitLayoutFrame,
] =>
  createPortraitLayoutFrames(window.matchMedia("(max-width: 800px)").matches);

/** 只在尺寸变化时测量首屏过渡，滚动过程中仅读取缓存值。 */
const measurePortraitLayout = (page: HTMLElement): PortraitLayoutMetrics => {
  const hero = page.querySelector<HTMLElement>("[data-spatial-hero]");
  return {
    pageTop: page.getBoundingClientRect().top + window.scrollY,
    transitionDistance: Math.max(
      1,
      (hero?.offsetHeight ?? window.innerHeight) *
        SPATIAL_AVATAR_READING_PHASE_RATIO,
    ),
  };
};

/** 直接使用独立眼球的球心节点，保留资产声明的初始方向。 */
const createEyeRig = (pivot: THREE.Object3D): EyeRig => {
  return {
    pivot,
    baseQuaternion: pivot.quaternion.clone(),
    targetQuaternion: pivot.quaternion.clone(),
  };
};

/** 按新附件的完整眼球层级解析控制节点，避免只转动瞳孔或高光。 */
const resolveEyePivots = (activeScene: THREE.Object3D): THREE.Object3D[] =>
  EYE_RIG_CONTRACTS.map(({ meshNames, pivotName }) => {
    const pivot = activeScene.getObjectByName(pivotName);
    if (!(pivot instanceof THREE.Object3D) || pivot.parent !== activeScene) {
      throw new Error(`模型缺少根级眼球控制节点：${pivotName}`);
    }

    const children = new Set(pivot.children.map((child) => child.name));
    const hasCompleteEye =
      pivot.children.length === meshNames.length &&
      meshNames.every((meshName) => {
        const mesh = activeScene.getObjectByName(meshName);
        return (
          mesh instanceof THREE.Mesh &&
          mesh.parent === pivot &&
          children.has(meshName)
        );
      });
    if (!hasCompleteEye) {
      throw new Error(`模型眼球组件不完整：${pivotName}`);
    }
    return pivot;
  });

/** 在独立展示层上按真实边界居中缩放，不覆盖 GLB 根节点与眼球局部姿态。 */
const fitAvatarModel = (modelFrame: THREE.Group): void => {
  modelFrame.position.set(0, 0, 0);
  modelFrame.rotation.set(0, -Math.PI / 2, 0);
  modelFrame.scale.setScalar(1);
  modelFrame.updateWorldMatrix(true, true);

  const bounds = new THREE.Box3().setFromObject(modelFrame);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largestExtent = Math.max(size.x, size.y);
  if (!Number.isFinite(largestExtent) || largestExtent <= 0) {
    throw new Error("模型边界无效");
  }

  const scale = AVATAR_TARGET_EXTENT / largestExtent;
  modelFrame.scale.setScalar(scale);
  modelFrame.position.set(
    -center.x * scale,
    -center.y * scale + 0.01,
    -center.z * scale,
  );
};

/** 遍历并去重释放 GLB 的几何体、材质、纹理及图片资源。 */
const disposeObjectTree = (root: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const images = new Set<{ close: () => void }>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (!(value instanceof THREE.Texture)) continue;
        textures.add(value);
        const image = value.source.data as { close?: () => void } | null;
        if (typeof image?.close === "function") {
          images.add(image as { close: () => void });
        }
      }
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  for (const image of images) image.close();
};

/**
 * 建立真实 GLB 场景。
 * 模型只在输入发生后短暂渲染至收敛，不维持永久动画循环。
 */
export const initSpatialAvatarScene = (
  root: HTMLElement,
  callbacks: SpatialAvatarSceneCallbacks,
): (() => void) => {
  const canvas = root.querySelector<HTMLCanvasElement>("[data-spatial-canvas]");
  const page = root.closest<HTMLElement>("[data-spatial-page]");
  const status = root.querySelector<HTMLElement>("[data-spatial-status]");
  if (!canvas || !page) {
    callbacks.onUnavailable("三维容器不可用，当前展示同模型静态海报。");
    return () => undefined;
  }

  const finePointer = window.matchMedia(
    "(hover: hover) and (pointer: fine)",
  ).matches;
  const abortController = new AbortController();
  const { signal } = abortController;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas,
      powerPreference: "default",
    });
  } catch {
    callbacks.onUnavailable(
      "当前浏览器无法显示三维模型，已展示同模型静态海报。",
    );
    return () => abortController.abort();
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = PORTRAIT_TONE_MAPPING_EXPOSURE;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  let environmentRenderTarget: THREE.WebGLRenderTarget;
  try {
    environmentRenderTarget = createPortraitEnvironment(renderer);
  } catch {
    renderer.dispose();
    callbacks.onUnavailable(
      "当前浏览器无法建立环境反射，已展示同模型静态海报。",
    );
    return () => abortController.abort();
  }
  scene.environment = environmentRenderTarget.texture;
  scene.environmentIntensity = PORTRAIT_ENVIRONMENT_INTENSITY;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, DEFAULT_CAMERA_Y, DEFAULT_CAMERA_Z);
  camera.lookAt(0, DEFAULT_CAMERA_TARGET_Y, 0);
  camera.updateMatrixWorld(true);

  // 展示层只负责首屏到阅读态的一次缩放和左移；相机与身体朝向始终固定。
  const portraitGroup = new THREE.Group();
  portraitGroup.name = "PortraitStage";
  scene.add(portraitGroup, createPortraitLightRig());

  let modelScene: THREE.Object3D | null = null;
  let eyeRigs: EyeRig[] = [];
  let frameId = 0;
  let layoutUpdateId = 0;
  let isVisible = true;
  let isDisposed = false;
  let isContextLost = false;
  let sceneReady = false;
  let isScenePresented = false;
  let pointerActive = false;
  let pointerClientX = 0;
  let pointerClientY = 0;
  let pointerX = 0;
  let pointerY = 0;
  const pointerGazeRegion: PointerGazeRegion = {
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2,
    radiusX: Math.max(1, window.innerWidth / 2),
    radiusY: Math.max(1, window.innerHeight / 2),
  };
  const canvasScreenRect = {
    height: Math.max(1, canvas.clientHeight),
    left: 0,
    top: 0,
    width: Math.max(1, canvas.clientWidth),
  };
  const eyeWorldPosition = new THREE.Vector3();
  const projectedEyeCenter = new THREE.Vector3();
  const portraitWorldPosition = new THREE.Vector3();
  const portraitViewPosition = new THREE.Vector3();
  const projectedPortraitCenter = new THREE.Vector3();
  let layoutFrames = createResponsivePortraitLayoutFrames();
  let layoutMetrics = measurePortraitLayout(page);
  let layoutFrame = layoutFrames[0];
  let currentModelX = layoutFrame.modelX;
  let currentModelY = layoutFrame.modelY;
  let currentModelScale = layoutFrame.scale;
  let lastFrameTime = 0;
  const gazeYaw = new THREE.Quaternion();
  const gazePitch = new THREE.Quaternion();
  const gazeRotation = new THREE.Quaternion();

  /** 投影平滑后的模型中心，让影棚柔光位置和尺度始终跟随真实屏幕构图。 */
  const updateBackdropPresentation = (): void => {
    portraitGroup.getWorldPosition(portraitWorldPosition);
    projectedPortraitCenter.copy(portraitWorldPosition).project(camera);
    const subjectScreenX =
      canvasScreenRect.left +
      ((projectedPortraitCenter.x + 1) / 2) * canvasScreenRect.width;
    const canvasCenterX = canvasScreenRect.left + canvasScreenRect.width / 2;
    const shiftInViewportWidths =
      ((subjectScreenX - canvasCenterX) / Math.max(1, window.innerWidth)) * 100;
    page.style.setProperty(
      "--spatial-light-shift",
      `${shiftInViewportWidths.toFixed(3)}vw`,
    );
    page.style.setProperty(
      "--spatial-light-scale",
      clamp(
        currentModelScale *
          readPortraitDepthScale(
            camera,
            portraitWorldPosition,
            portraitViewPosition,
          ),
        0.96,
        1.18,
      ).toFixed(4),
    );
  };

  /** 静态海报接管画面时移除运行时变量，恢复响应式背景的稳定默认值。 */
  const resetBackdropPresentation = (): void => {
    page.style.removeProperty("--spatial-light-shift");
    page.style.removeProperty("--spatial-light-scale");
  };

  /** 缓存包含 CSS 位移与缩放的画布范围，指针移动时不再触发布局测量。 */
  const measureCanvasScreenRect = (): void => {
    const bounds = canvas.getBoundingClientRect();
    canvasScreenRect.left = bounds.left;
    canvasScreenRect.top = bounds.top;
    canvasScreenRect.width = Math.max(1, bounds.width);
    canvasScreenRect.height = Math.max(1, bounds.height);
    pointerGazeRegion.radiusX = Math.max(1, bounds.width * 0.56);
    pointerGazeRegion.radiusY = Math.max(1, bounds.height * 0.56);
  };

  /** 把双眼三维中点投影到当前画布，保证肖像换位后仍真正看向指针。 */
  const updateProjectedEyeCenter = (): void => {
    if (eyeRigs.length !== EYE_RIG_CONTRACTS.length) {
      pointerGazeRegion.centerX =
        canvasScreenRect.left + canvasScreenRect.width / 2;
      pointerGazeRegion.centerY =
        canvasScreenRect.top + canvasScreenRect.height / 2;
      return;
    }

    projectedEyeCenter.set(0, 0, 0);
    for (const eye of eyeRigs) {
      eye.pivot.getWorldPosition(eyeWorldPosition);
      projectedEyeCenter.add(eyeWorldPosition);
    }
    projectedEyeCenter.multiplyScalar(1 / eyeRigs.length).project(camera);
    pointerGazeRegion.centerX =
      canvasScreenRect.left +
      ((projectedEyeCenter.x + 1) / 2) * canvasScreenRect.width;
    pointerGazeRegion.centerY =
      canvasScreenRect.top +
      ((1 - projectedEyeCenter.y) / 2) * canvasScreenRect.height;
  };

  /** 用最后一次真实指针坐标重新计算目光，肖像换位时不沿用过期方向。 */
  const updatePointerGaze = (): void => {
    if (!pointerActive) return;
    const gaze = mapPointerToGaze(
      pointerClientX,
      pointerClientY,
      pointerGazeRegion,
    );
    pointerX = gaze.x;
    pointerY = gaze.y;
  };

  /** 将固定默认目光或精细指针输入写入两只眼球的目标姿态。 */
  const updateEyeTargets = (): void => {
    const gazeX = pointerActive ? pointerX : DEFAULT_GAZE_X;
    const gazeY = pointerActive ? pointerY : DEFAULT_GAZE_Y;
    for (const eye of eyeRigs) {
      setEyeTargetQuaternion(
        eye.baseQuaternion,
        eye.targetQuaternion,
        gazeX,
        gazeY,
        gazeRotation,
        gazeYaw,
        gazePitch,
      );
    }
  };

  /** 只在场景可见、已就绪且浏览器前台时安排下一帧。 */
  const requestRender = (): void => {
    if (
      frameId ||
      isDisposed ||
      isContextLost ||
      !isVisible ||
      !sceneReady ||
      document.hidden
    ) {
      return;
    }
    lastFrameTime = 0;
    frameId = window.requestAnimationFrame(renderFrame);
  };

  /** 使用按时间计算的阻尼平滑首段布局与目光，收敛后停止请求新帧。 */
  const renderFrame = (time: number): void => {
    frameId = 0;
    if (
      isDisposed ||
      isContextLost ||
      !isVisible ||
      !sceneReady ||
      document.hidden
    ) {
      return;
    }

    const delta = lastFrameTime
      ? clamp((time - lastFrameTime) / 1000, 0, 0.05)
      : 1 / 60;
    lastFrameTime = time;
    const modelFactor = 1 - Math.exp(-MODEL_DAMPING * delta);
    const eyeFactor = 1 - Math.exp(-EYE_DAMPING * delta);

    currentModelX = THREE.MathUtils.lerp(
      currentModelX,
      layoutFrame.modelX,
      modelFactor,
    );
    currentModelY = THREE.MathUtils.lerp(
      currentModelY,
      layoutFrame.modelY,
      modelFactor,
    );
    currentModelScale = THREE.MathUtils.lerp(
      currentModelScale,
      layoutFrame.scale,
      modelFactor,
    );
    portraitGroup.position.set(currentModelX, currentModelY, 0);
    portraitGroup.scale.setScalar(currentModelScale);
    updateBackdropPresentation();
    updateProjectedEyeCenter();
    updatePointerGaze();
    updateEyeTargets();
    for (const eye of eyeRigs) {
      eye.pivot.quaternion.slerp(eye.targetQuaternion, eyeFactor);
    }

    renderer.render(scene, camera);
    const modelUnsettled =
      Math.abs(currentModelX - layoutFrame.modelX) > SETTLE_EPSILON ||
      Math.abs(currentModelY - layoutFrame.modelY) > SETTLE_EPSILON ||
      Math.abs(currentModelScale - layoutFrame.scale) > SETTLE_EPSILON;
    const eyesUnsettled = eyeRigs.some(
      (eye) =>
        1 - Math.abs(eye.pivot.quaternion.dot(eye.targetQuaternion)) >
        SETTLE_EPSILON,
    );
    if (modelUnsettled || eyesUnsettled) {
      frameId = window.requestAnimationFrame(renderFrame);
    }
  };

  /** 仅依据首屏滚动距离更新一次构图，后续目录始终保持阅读态。 */
  const updatePortraitLayout = (): void => {
    layoutFrame = readPortraitLayoutFrame(
      readPortraitLayoutProgress(
        window.scrollY,
        layoutMetrics.pageTop,
        layoutMetrics.transitionDistance,
      ),
      layoutFrames,
    );
    measureCanvasScreenRect();
    updateProjectedEyeCenter();
    updatePointerGaze();
    updateEyeTargets();
    requestRender();
  };

  /** 合并高频滚动事件，确保每一帧只计算一次首段布局。 */
  const scheduleLayoutUpdate = (): void => {
    if (layoutUpdateId || isDisposed) return;
    layoutUpdateId = window.requestAnimationFrame(() => {
      layoutUpdateId = 0;
      updatePortraitLayout();
    });
  };

  /** 同步画布分辨率、相机比例与滚动测量，限制高分屏 GPU 占用。 */
  const resize = (): void => {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, width < 680 ? 1.25 : 1.5),
    );
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    layoutFrames = createResponsivePortraitLayoutFrames();
    layoutMetrics = measurePortraitLayout(page);
    measureCanvasScreenRect();
    updatePortraitLayout();
  };

  /** 精细指针只控制双眼目光，不改变固定相机或人物身体朝向。 */
  const handlePointerMove = (event: PointerEvent): void => {
    pointerActive = true;
    pointerClientX = event.clientX;
    pointerClientY = event.clientY;
    updatePointerGaze();
    updateEyeTargets();
    requestRender();
  };

  /** 指针离开页面后让眼球平稳回到固定的默认注视方向。 */
  const handlePointerLeave = (): void => {
    pointerActive = false;
    pointerX = 0;
    pointerY = 0;
    updateEyeTargets();
    requestRender();
  };

  /** 暂停待处理的动画帧，但保留可供 bfcache 恢复的模型资源。 */
  const pauseFrames = (): void => {
    if (frameId) window.cancelAnimationFrame(frameId);
    if (layoutUpdateId) window.cancelAnimationFrame(layoutUpdateId);
    frameId = 0;
    layoutUpdateId = 0;
    lastFrameTime = 0;
  };

  const resizeObserver = new ResizeObserver(resize);
  const intersectionObserver = new IntersectionObserver(
    ([entry]) => {
      isVisible = entry?.isIntersecting ?? true;
      if (isVisible) requestRender();
      else pauseFrames();
    },
    { rootMargin: "80px" },
  );

  /** 幂等释放 GLB、独立眼球、监听器和 WebGL 资源。 */
  const cleanup = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    callbacks.onDispose();
    abortController.abort();
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    pauseFrames();
    if (modelScene) disposeObjectTree(modelScene);
    portraitGroup.clear();
    environmentRenderTarget.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    resetBackdropPresentation();
    root.classList.remove("is-webgl-ready");
  };

  /**
   * 只有模型和 WebGL 上下文同时可用时才展示画布。
   * 模型下载与上下文恢复可能以任意顺序完成，两条路径统一在这里收敛。
   */
  const presentSceneIfReady = (): boolean => {
    if (
      isDisposed ||
      !canPresentSpatialAvatarScene(sceneReady, isContextLost)
    ) {
      return false;
    }
    renderer.render(scene, camera);
    if (!isScenePresented) {
      isScenePresented = true;
      callbacks.onReady();
    }
    requestRender();
    return true;
  };

  window.addEventListener("scroll", scheduleLayoutUpdate, {
    passive: true,
    signal,
  });
  window.addEventListener("resize", resize, { passive: true, signal });
  if (finePointer) {
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
      signal,
    });
    document.documentElement.addEventListener(
      "mouseleave",
      handlePointerLeave,
      { signal },
    );
  }
  resizeObserver.observe(canvas);
  intersectionObserver.observe(page);

  /** 页面进入后台时停止 GPU，恢复后重置时间基线并按需重绘。 */
  const handleVisibilityChange = (): void => {
    if (document.hidden) pauseFrames();
    else requestRender();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange, {
    signal,
  });

  /** 上下文丢失时展示同模型海报，浏览器恢复上下文后再绘制一次。 */
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      event.preventDefault();
      isContextLost = true;
      isScenePresented = false;
      pauseFrames();
      root.classList.remove("is-webgl-ready");
      root.classList.add("is-webgl-unavailable");
      page.classList.add("is-spatial-static");
      resetBackdropPresentation();
      callbacks.onStaticPosterRequested();
      if (status)
        status.textContent = "三维显示暂时中断，当前展示同模型静态海报。";
    },
    { signal },
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      if (isDisposed) return;
      isContextLost = false;
      try {
        const restoredEnvironment = createPortraitEnvironment(renderer);
        environmentRenderTarget.dispose();
        environmentRenderTarget = restoredEnvironment;
      } catch {
        cleanup();
        callbacks.onUnavailable(
          "环境反射恢复失败，当前展示同模型静态海报。",
        );
        return;
      }
      scene.environment = environmentRenderTarget.texture;
      resize();
      presentSceneIfReady();
    },
    { signal },
  );

  /** 进入 bfcache 时只暂停，普通离开页面时完整释放 WebGL。 */
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) pauseFrames();
    else cleanup();
  };

  /** 从 bfcache 恢复时重新测量并按需渲染，不累加后台停留时间。 */
  const handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || isDisposed) return;
    resize();
    requestRender();
  };
  window.addEventListener("pagehide", handlePageHide, { signal });
  window.addEventListener("pageshow", handlePageShow, { signal });

  /** 等待已提前启动的模型请求；字节到齐后先撤下海报，再解析并渲染首帧。 */
  const loadModel = async (): Promise<void> => {
    let loadedScene: THREE.Object3D | null = null;
    try {
      const modelBytes = await callbacks.modelBytes;
      if (isDisposed) return;
      callbacks.onModelBytesReady();
      if (isDisposed) return;
      const gltf = await new GLTFLoader()
        .setMeshoptDecoder(MeshoptDecoder)
        .parseAsync(modelBytes, "/");
      const activeScene = gltf.scene;
      loadedScene = activeScene;
      if (isDisposed) {
        disposeObjectTree(activeScene);
        return;
      }

      const eyePivots = resolveEyePivots(activeScene);

      modelScene = activeScene;
      const modelFrame = new THREE.Group();
      modelFrame.name = "AvatarFitFrame";
      modelFrame.add(activeScene);
      fitAvatarModel(modelFrame);
      portraitGroup.add(modelFrame);

      eyeRigs = eyePivots.map((eye) => createEyeRig(eye));
      updateEyeTargets();

      resize();
      portraitGroup.position.set(currentModelX, currentModelY, 0);
      portraitGroup.scale.setScalar(currentModelScale);
      updateBackdropPresentation();
      updateProjectedEyeCenter();
      updatePointerGaze();
      updateEyeTargets();
      sceneReady = true;
      presentSceneIfReady();
    } catch {
      if (isDisposed || signal.aborted) return;
      if (loadedScene && loadedScene !== modelScene)
        disposeObjectTree(loadedScene);
      callbacks.onUnavailable("三维模型加载失败，当前展示同模型静态海报。");
      cleanup();
    }
  };

  layoutMetrics = measurePortraitLayout(page);
  updatePortraitLayout();
  void loadModel();
  return cleanup;
};
