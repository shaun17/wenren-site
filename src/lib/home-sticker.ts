type StickerCleanup = () => void;

export interface StickerTranslation {
  x: number;
  y: number;
}

export interface StickerTranslationBounds {
  minimumX: number;
  maximumX: number;
  minimumY: number;
  maximumY: number;
}

export interface StickerPressureBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StickerPressurePose {
  tiltX: number;
  tiltY: number;
}

export type StickerRotationDirection = -1 | 1;

export interface HomeStickerDefinition {
  id: string;
  asset: string;
  label: string;
  width: number;
  height: number;
  initialXPercent: number;
  initialYPercent: number;
  initialLayer: number;
}

interface HomeStickerOptions {
  initialRotation?: number;
  onActivate?: () => void;
  random?: () => number;
}

/**
 * 六张贴纸沿右上方向左交错排开。相邻中心横向间隔 58%，第二相邻贴纸已完全错开，
 * 因而默认状态每张只会被下一层遮住约三分之一；用户拖动后则不再做贴纸间避让。
 */
export const HOME_STICKER_DEFINITIONS = [
  {
    id: "mcdonald",
    asset: "/stickers/mcdonald-logo-sticker-705aee4ab869.png",
    label: "麦当劳金色拱门贴纸",
    width: 512,
    height: 512,
    initialXPercent: 0,
    initialYPercent: 0,
    initialLayer: 1,
  },
  {
    id: "memo-logo",
    asset: "/stickers/memo-logo-sticker-3f55c5c48975.webp",
    label: "黑色 M 图形贴纸",
    width: 512,
    height: 341,
    initialXPercent: -58,
    initialYPercent: 18,
    initialLayer: 2,
  },
  {
    id: "blonde-avatar",
    asset: "/stickers/blonde-avatar-sticker-8ff5844bb149.webp",
    label: "金发人物头像贴纸",
    width: 477,
    height: 512,
    initialXPercent: -116,
    initialYPercent: 0,
    initialLayer: 3,
  },
  {
    id: "owl-reader",
    asset: "/stickers/owl-reader-sticker-ce2afb2c71f3.webp",
    label: "猫头鹰读书贴纸",
    width: 512,
    height: 454,
    initialXPercent: -174,
    initialYPercent: 18,
    initialLayer: 4,
  },
  {
    id: "petly",
    asset: "/stickers/petly-sticker-43756132f0e3.webp",
    label: "Petly 品牌贴纸",
    width: 512,
    height: 512,
    initialXPercent: -232,
    initialYPercent: 0,
    initialLayer: 5,
  },
  {
    id: "green-orbit",
    asset: "/stickers/green-orbit-sticker-6c8cfb4150d7.webp",
    label: "绿色环形标志贴纸",
    width: 512,
    height: 512,
    initialXPercent: -290,
    initialYPercent: 18,
    initialLayer: 6,
  },
] as const satisfies readonly HomeStickerDefinition[];

const VIEWPORT_PADDING = 16;
const CLICK_DRAG_THRESHOLD = 6;
const MIN_ANGULAR_VELOCITY = 65;
export const STICKER_CLICK_ROTATION_SPEEDS = [
  720, 840, 960, 1_080, 1_200,
] as const;
const ANGULAR_DAMPING = 2.2;
const ANGULAR_STOP_SPEED = 14;
const MAX_INERTIA_DURATION_MS = 2_400;
const PRESS_MAX_TILT = 6;
const MIN_INITIAL_ROTATION = -10;
const MAX_INITIAL_ROTATION = 10;

/** 将数值限制在指定闭区间，供所有指针物理计算复用。 */
const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** 把可注入随机数映射为克制的初始角度，既能形成随手贴上的感觉，也不破坏默认遮挡。 */
export const selectStickerInitialRotation = (randomValue: number): number => {
  const normalizedRandom = clampNumber(randomValue, 0, 1);
  return (
    MIN_INITIAL_ROTATION +
    normalizedRandom * (MAX_INITIAL_ROTATION - MIN_INITIAL_ROTATION)
  );
};

/** 将贴纸位移限制在当前可视区域内，始终保留一圈可操作边距。 */
export const clampStickerTranslation = (
  translation: StickerTranslation,
  bounds: StickerTranslationBounds,
): StickerTranslation => {
  const minimumX = Math.min(bounds.minimumX, bounds.maximumX);
  const maximumX = Math.max(bounds.minimumX, bounds.maximumX);
  const minimumY = Math.min(bounds.minimumY, bounds.maximumY);
  const maximumY = Math.max(bounds.minimumY, bounds.maximumY);
  return {
    x: Math.min(maximumX, Math.max(minimumX, translation.x)),
    y: Math.min(maximumY, Math.max(minimumY, translation.y)),
  };
};

/**
 * 浏览器尺寸变化只修正横向越界；纵向位置属于页面文档坐标，
 * 不能因手机滚动后地址栏收起触发 resize，就被吸附到当前正文视口。
 */
export const clampStickerTranslationAfterViewportResize = (
  translation: StickerTranslation,
  bounds: StickerTranslationBounds,
): StickerTranslation =>
  clampStickerTranslation(translation, {
    ...bounds,
    minimumY: translation.y,
    maximumY: translation.y,
  });

/**
 * 把屏幕中的鼠标落点反向旋转到贴纸局部坐标，再映射为静态 3D 压感。
 * 倾斜总量采用径向上限，角落不会叠加成夸张折角；中心支点让落点侧缩小、对侧放大。
 */
export const mapStickerPressure = (
  pointer: StickerTranslation,
  bounds: StickerPressureBounds,
  rotationDegrees = 0,
): StickerPressurePose => {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const normalizedX = clampNumber(
    ((pointer.x - bounds.left) / width - 0.5) * 2,
    -1,
    1,
  );
  const normalizedY = clampNumber(
    ((pointer.y - bounds.top) / height - 0.5) * 2,
    -1,
    1,
  );

  const rotationRadians = (rotationDegrees * Math.PI) / 180;
  const rotationCosine = Math.cos(rotationRadians);
  const rotationSine = Math.sin(rotationRadians);
  const localX =
    normalizedX * rotationCosine + normalizedY * rotationSine;
  const localY =
    -normalizedX * rotationSine + normalizedY * rotationCosine;
  const localLength = Math.hypot(localX, localY);
  if (localLength < Number.EPSILON) return { tiltX: 0, tiltY: 0 };

  const pressureStrength = Math.min(1, localLength);
  const tiltStrength = PRESS_MAX_TILT * pressureStrength;
  const tiltX = (-localY / localLength) * tiltStrength;
  const tiltY = (localX / localLength) * tiltStrength;

  return {
    tiltX: Math.abs(tiltX) < Number.EPSILON ? 0 : tiltX,
    tiltY: Math.abs(tiltY) < Number.EPSILON ? 0 : tiltY,
  };
};

/** 位移没有超过阈值才算点击，拖拽无论快慢都不会再触发旋转。 */
export const isStickerClickGesture = (maximumTravel: number): boolean =>
  Math.max(0, maximumTravel) <= CLICK_DRAG_THRESHOLD;

/**
 * 从离散速度池随机选择点击转速，并排除上一次速度，
 * 因而相邻两次点击既有随机性，也一定不会得到相同速率。
 */
export const selectStickerClickRotationSpeed = (
  randomValue: number,
  previousSpeed: number | null,
): number => {
  const candidates = STICKER_CLICK_ROTATION_SPEEDS.filter(
    (speed) => speed !== previousSpeed,
  );
  const normalizedRandom = clampNumber(randomValue, 0, 1);
  const index = Math.min(
    candidates.length - 1,
    Math.floor(normalizedRandom * candidates.length),
  );
  return candidates[index] ?? STICKER_CLICK_ROTATION_SPEEDS[0];
};

/** 每次点击后翻转方向，形成严格的顺时针与逆时针交替序列。 */
export const readOppositeStickerRotationDirection = (
  direction: StickerRotationDirection,
): StickerRotationDirection => (direction === 1 ? -1 : 1);

/** 使用帧率无关的指数阻尼衰减角速度，快慢屏幕上的旋转手感保持一致。 */
export const decayStickerAngularVelocity = (
  angularVelocity: number,
  deltaSeconds: number,
): number =>
  angularVelocity * Math.exp(-ANGULAR_DAMPING * Math.max(0, deltaSeconds));

/** 把累计角度压回一个视觉等价的单圈数值，避免长期点击后数值无限增长。 */
export const normalizeStickerRotation = (rotation: number): number => {
  const normalizedRotation = rotation % 360;
  return Math.abs(normalizedRotation) < 0.0005 ? 0 : normalizedRotation;
};

/** 初始化单张首页贴纸的自由摆放、落点压感和点击随机旋转。 */
export const initHomeSticker = (
  sticker: HTMLElement,
  options: HomeStickerOptions = {},
): StickerCleanup => {
  if (sticker.dataset.homeStickerInitialized === "true") {
    return () => undefined;
  }

  sticker.dataset.homeStickerInitialized = "true";
  const abortController = new AbortController();
  const { signal } = abortController;
  const reducedMotionQuery = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  const precisePointerQuery = window.matchMedia(
    "(hover: hover) and (pointer: fine)",
  );
  const random = options.random ?? Math.random;
  const poseProperties = [
    "--sticker-x",
    "--sticker-y",
    "--sticker-rotation",
    "--sticker-tilt-x",
    "--sticker-tilt-y",
  ] as const;
  const initialInlinePose = new Map(
    poseProperties.map((property) => [
      property,
      sticker.style.getPropertyValue(property),
    ]),
  );
  let translation: StickerTranslation = { x: 0, y: 0 };
  let rotation = normalizeStickerRotation(options.initialRotation ?? 0);
  let activePointerId: number | null = null;
  let pointerOrigin: StickerTranslation = { x: 0, y: 0 };
  let maximumPointerTravel = 0;
  let hasDragged = false;
  let translationOrigin: StickerTranslation = { x: 0, y: 0 };
  let translationBounds: StickerTranslationBounds = {
    minimumX: 0,
    maximumX: 0,
    minimumY: 0,
    maximumY: 0,
  };
  let previousClickRotationSpeed: number | null = null;
  let nextClickRotationDirection: StickerRotationDirection = 1;
  let rotationFrame: number | null = null;
  let pressurePointer: StickerTranslation | null = null;
  let isCleaned = false;

  /** 只把持久位移写给按钮外层，让拖拽摆放不干扰内层旋转。 */
  const renderTranslation = (): void => {
    sticker.style.setProperty("--sticker-x", `${translation.x.toFixed(2)}px`);
    sticker.style.setProperty("--sticker-y", `${translation.y.toFixed(2)}px`);
  };

  /** 按当前保留角度重算屏幕落点，旋转后鼠标压下的位置仍与视觉方向一致。 */
  const renderStoredPointerPressure = (): void => {
    if (!pressurePointer) return;
    const bounds = sticker.getBoundingClientRect();
    const pose = mapStickerPressure(pressurePointer, bounds, rotation);
    sticker.style.setProperty(
      "--sticker-tilt-x",
      `${pose.tiltX.toFixed(2)}deg`,
    );
    sticker.style.setProperty(
      "--sticker-tilt-y",
      `${pose.tiltY.toFixed(2)}deg`,
    );
    sticker.classList.add("is-pointer-over");
  };

  /** 只把累计角度写给旋转层，并同步校正仍停留在贴纸上的鼠标压感。 */
  const renderRotation = (): void => {
    sticker.style.setProperty(
      "--sticker-rotation",
      `${rotation.toFixed(3)}deg`,
    );
    renderStoredPointerPressure();
  };

  /** 保存当前屏幕落点；鼠标不动时姿态稳定，旋转时则只校正局部坐标。 */
  const renderPointerPressure = (event: PointerEvent): void => {
    if (!precisePointerQuery.matches && event.pointerType !== "mouse") return;

    pressurePointer = { x: event.clientX, y: event.clientY };
    renderStoredPointerPressure();
  };

  /** 清除压感姿态，并让贴纸表面短暂平滑回到水平状态。 */
  const clearPointerPressure = (): void => {
    pressurePointer = null;
    sticker.classList.remove("is-pointer-over");
    sticker.style.setProperty("--sticker-tilt-x", "0deg");
    sticker.style.setProperty("--sticker-tilt-y", "0deg");
  };

  /** 读取 CSS 边界修正中的真实位置，快速二次抓取时不会跳到过渡终点。 */
  const readRenderedTranslation = (): StickerTranslation => {
    const transform = window.getComputedStyle(sticker).transform;
    if (!transform || transform === "none") return { x: 0, y: 0 };

    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  };

  /** 按旋转后可见层的包围盒计算范围，任意保留角度下都不会把白边拖出屏幕。 */
  const readTranslationBounds = (): StickerTranslationBounds => {
    const visibleSticker =
      sticker.querySelector<HTMLElement>(".home-sticker-spin") ?? sticker;
    const bounds = visibleSticker.getBoundingClientRect();
    return {
      minimumX: translation.x + VIEWPORT_PADDING - bounds.left,
      maximumX:
        translation.x + window.innerWidth - VIEWPORT_PADDING - bounds.right,
      minimumY: translation.y + VIEWPORT_PADDING - bounds.top,
      maximumY:
        translation.y + window.innerHeight - VIEWPORT_PADDING - bounds.bottom,
    };
  };

  /** 停止当前旋转并保留画面角度；只做视觉等价的单圈规范化，绝不回正。 */
  const stopRotationPreservingAngle = (): void => {
    if (rotationFrame !== null) cancelAnimationFrame(rotationFrame);
    rotationFrame = null;
    sticker.classList.remove("is-spinning");
    rotation = normalizeStickerRotation(rotation);
    renderRotation();
  };

  /** 按点击角速度启动惯性；阻尼结束后停在当时角度，不再补整圈或回正。 */
  const startInertialRotation = (initialVelocity: number): void => {
    stopRotationPreservingAngle();
    if (reducedMotionQuery.matches) {
      rotation = normalizeStickerRotation(
        rotation + initialVelocity / ANGULAR_DAMPING,
      );
      renderRotation();
      return;
    }
    if (Math.abs(initialVelocity) < MIN_ANGULAR_VELOCITY) {
      return;
    }

    let angularVelocity = initialVelocity;
    let previousTime = performance.now();
    const startTime = previousTime;
    sticker.classList.add("is-spinning");

    /** 每帧积分角度并衰减角速度，限制异常长帧避免切回页面时突跳。 */
    const inertiaFrame = (now: number): void => {
      const deltaSeconds = Math.min((now - previousTime) / 1_000, 0.05);
      previousTime = now;
      rotation += angularVelocity * deltaSeconds;
      angularVelocity = decayStickerAngularVelocity(
        angularVelocity,
        deltaSeconds,
      );
      renderRotation();

      const shouldStop =
        Math.abs(angularVelocity) < ANGULAR_STOP_SPEED ||
        now - startTime >= MAX_INERTIA_DURATION_MS;
      if (shouldStop) {
        stopRotationPreservingAngle();
        return;
      }

      rotationFrame = requestAnimationFrame(inertiaFrame);
    };

    rotationFrame = requestAnimationFrame(inertiaFrame);
  };

  /** 用不同随机速度启动本次点击旋转，并立即把下一次方向翻转。 */
  const startClickRotation = (): void => {
    const speed = selectStickerClickRotationSpeed(
      random(),
      previousClickRotationSpeed,
    );
    previousClickRotationSpeed = speed;
    startInertialRotation(speed * nextClickRotationDirection);
    nextClickRotationDirection = readOppositeStickerRotationDirection(
      nextClickRotationDirection,
    );
  };

  /** 只结束当前指针捕获；pointerup 会在随后决定点击旋转或保留拖拽位置。 */
  const finishPointerInteraction = (): void => {
    const pointerId = activePointerId;
    activePointerId = null;
    sticker.classList.remove("is-dragging");
    if (pointerId !== null && sticker.hasPointerCapture(pointerId)) {
      sticker.releasePointerCapture(pointerId);
    }
  };

  /** 中断交互时停住运动，但完整保留用户已经摆放的位置与视觉角度。 */
  const stopMotionPreservingPose = (): void => {
    finishPointerInteraction();
    stopRotationPreservingAngle();
    renderTranslation();
    clearPointerPressure();
  };

  /** 视口变化时只修正横向越界，纵向文档位置与完整视觉角度保持不变。 */
  const keepPoseInsidePageWidth = (): void => {
    finishPointerInteraction();
    stopRotationPreservingAngle();
    translation = readRenderedTranslation();
    translation = clampStickerTranslationAfterViewportResize(
      translation,
      readTranslationBounds(),
    );
    renderTranslation();
    clearPointerPressure();
  };

  /** 记录抓取起点并停止旧惯性，后续用最大位移区分点击和拖拽。 */
  const handlePointerDown = (event: PointerEvent): void => {
    if (activePointerId !== null || event.button !== 0 || !event.isPrimary) {
      return;
    }

    event.preventDefault();
    options.onActivate?.();
    sticker.focus({ preventScroll: true });
    stopRotationPreservingAngle();
    translation = readRenderedTranslation();
    renderTranslation();
    sticker.classList.add("is-dragging");
    activePointerId = event.pointerId;
    pointerOrigin = { x: event.clientX, y: event.clientY };
    maximumPointerTravel = 0;
    hasDragged = false;
    translationOrigin = { ...translation };
    translationBounds = readTranslationBounds();
    renderPointerPressure(event);
    sticker.setPointerCapture(event.pointerId);
  };

  /** 拖拽时只更新位移与最大行程，悬浮时则只更新鼠标落点压感。 */
  const handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) {
      renderPointerPressure(event);
      return;
    }

    event.preventDefault();
    maximumPointerTravel = Math.max(
      maximumPointerTravel,
      Math.hypot(
        event.clientX - pointerOrigin.x,
        event.clientY - pointerOrigin.y,
      ),
    );
    hasDragged = hasDragged || !isStickerClickGesture(maximumPointerTravel);
    if (!hasDragged) {
      renderPointerPressure(event);
      return;
    }
    translation = clampStickerTranslation(
      {
        x: translationOrigin.x + event.clientX - pointerOrigin.x,
        y: translationOrigin.y + event.clientY - pointerOrigin.y,
      },
      translationBounds,
    );
    renderTranslation();
    renderPointerPressure(event);
  };

  /** 鼠标进入时根据当前落点压下贴纸表面，不启动任何循环动画。 */
  const handlePointerEnter = (event: PointerEvent): void => {
    renderPointerPressure(event);
  };

  /** 鼠标离开后恢复平面；拖拽捕获期间仍保留抓取点的压感。 */
  const handlePointerLeave = (): void => {
    if (activePointerId === null) clearPointerPressure();
  };

  /** 松手后保留拖拽终点；只有未超过阈值的单击才启动随机交替旋转。 */
  const handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;

    maximumPointerTravel = Math.max(
      maximumPointerTravel,
      Math.hypot(
        event.clientX - pointerOrigin.x,
        event.clientY - pointerOrigin.y,
      ),
    );
    hasDragged = hasDragged || !isStickerClickGesture(maximumPointerTravel);
    const shouldRotate = !hasDragged;
    if (hasDragged) {
      translation = clampStickerTranslation(
        {
          x: translationOrigin.x + event.clientX - pointerOrigin.x,
          y: translationOrigin.y + event.clientY - pointerOrigin.y,
        },
        translationBounds,
      );
      renderTranslation();
    }
    finishPointerInteraction();
    if (shouldRotate) {
      renderPointerPressure(event);
      startClickRotation();
    } else {
      clearPointerPressure();
    }
  };

  /** 系统取消手势时不制造虚假惯性，停在最后收到的安全位置。 */
  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === activePointerId) stopMotionPreservingPose();
  };

  /** 捕获被浏览器意外夺走时保留当前姿态，正常释放因编号已清空不会重复处理。 */
  const handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId === activePointerId) stopMotionPreservingPose();
  };

  /** 键盘激活键复用点击旋转序列，Escape 停住运动但保留角度。 */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      stopMotionPreservingPose();
      return;
    }

    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      options.onActivate?.();
      startClickRotation();
    }
  };

  /** 动态偏好或窗口焦点变化只停住运动，当前位置与角度都保持不变。 */
  const handleEnvironmentChange = (): void => stopMotionPreservingPose();

  /** 键盘 Tab 聚焦也把贴纸带到最上层，保证被部分遮住时仍有清晰的焦点反馈。 */
  const handleFocus = (): void => options.onActivate?.();

  /** 页面进入后台时停住运动，重新显示时不会续播过期惯性，也不会丢失姿态。 */
  const handleVisibilityChange = (): void => {
    if (document.hidden) stopMotionPreservingPose();
  };

  /** 幂等移除所有监听器和动画，并恢复服务端渲染时的初始样式。 */
  const cleanup = (): void => {
    if (isCleaned) return;
    isCleaned = true;
    abortController.abort();
    finishPointerInteraction();
    stopRotationPreservingAngle();
    for (const property of poseProperties) {
      const initialValue = initialInlinePose.get(property) ?? "";
      if (initialValue) {
        sticker.style.setProperty(property, initialValue);
      } else {
        sticker.style.removeProperty(property);
      }
    }
    delete sticker.dataset.homeStickerInitialized;
  };

  sticker.addEventListener("pointerenter", handlePointerEnter, { signal });
  sticker.addEventListener("pointermove", handlePointerMove, { signal });
  sticker.addEventListener("pointerleave", handlePointerLeave, { signal });
  sticker.addEventListener("pointerdown", handlePointerDown, { signal });
  sticker.addEventListener("pointerup", handlePointerUp, { signal });
  sticker.addEventListener("pointercancel", handlePointerCancel, { signal });
  sticker.addEventListener("lostpointercapture", handleLostPointerCapture, {
    signal,
  });
  sticker.addEventListener("focus", handleFocus, { signal });
  sticker.addEventListener("keydown", handleKeyDown, { signal });
  window.addEventListener("blur", handleEnvironmentChange, { signal });
  window.addEventListener("resize", keepPoseInsidePageWidth, {
    passive: true,
    signal,
  });
  reducedMotionQuery.addEventListener("change", handleEnvironmentChange, {
    signal,
  });
  document.addEventListener("visibilitychange", handleVisibilityChange, {
    signal,
  });
  document.addEventListener("astro:before-swap", cleanup, {
    once: true,
    signal,
  });
  translation = readRenderedTranslation();
  renderTranslation();
  renderRotation();
  clearPointerPressure();
  return cleanup;
};

/**
 * 初始化共享贴纸舞台：每次进入首页重新生成初始角度，并把最近操作的贴纸提升到最上层。
 * 舞台只管理初始化和层级；拖拽范围仍由每张贴纸独立维护，不限制贴纸彼此完全覆盖。
 */
export const initHomeStickerDeck = (
  deck: HTMLElement,
  random: () => number = Math.random,
): StickerCleanup => {
  if (deck.dataset.homeStickerDeckInitialized === "true") {
    return () => undefined;
  }

  const stickers = Array.from(
    deck.querySelectorAll<HTMLElement>("[data-home-sticker]"),
  );
  if (stickers.length === 0) return () => undefined;

  deck.dataset.homeStickerDeckInitialized = "true";
  let highestLayer = stickers.reduce(
    (highest, sticker) =>
      Math.max(highest, Number(sticker.dataset.stickerLayer) || 0),
    0,
  );
  const initialLayers = stickers.map((sticker) => ({
    dataset: sticker.dataset.stickerLayer,
    style: sticker.style.getPropertyValue("--sticker-layer"),
  }));

  /** 把当前贴纸移到队尾，并把所有层级重新压回 1 至 6，避免长期操作后层级无限增长。 */
  const bringStickerToFront = (activeSticker: HTMLElement): void => {
    const currentLayer = Number(activeSticker.dataset.stickerLayer) || 0;
    if (currentLayer === highestLayer) return;

    const orderedStickers = [...stickers]
      .sort(
        (left, right) =>
          (Number(left.dataset.stickerLayer) || 0) -
          (Number(right.dataset.stickerLayer) || 0),
      )
      .filter((sticker) => sticker !== activeSticker);
    orderedStickers.push(activeSticker);
    orderedStickers.forEach((sticker, index) => {
      const layer = String(index + 1);
      sticker.dataset.stickerLayer = layer;
      sticker.style.setProperty("--sticker-layer", layer);
    });
    highestLayer = stickers.length;
  };

  const cleanups = stickers.map((sticker) =>
    initHomeSticker(sticker, {
      initialRotation: selectStickerInitialRotation(random()),
      random,
      onActivate: () => bringStickerToFront(sticker),
    }),
  );
  let isCleaned = false;

  /** 幂等清理全部实例，并把服务端给出的默认层级交还给静态页面。 */
  const cleanup = (): void => {
    if (isCleaned) return;
    isCleaned = true;
    cleanups.forEach((dispose) => dispose());
    stickers.forEach((sticker, index) => {
      const initialLayer = initialLayers[index];
      if (!initialLayer) return;
      if (initialLayer.dataset === undefined) {
        delete sticker.dataset.stickerLayer;
      } else {
        sticker.dataset.stickerLayer = initialLayer.dataset;
      }
      if (initialLayer.style) {
        sticker.style.setProperty("--sticker-layer", initialLayer.style);
      } else {
        sticker.style.removeProperty("--sticker-layer");
      }
    });
    delete deck.dataset.homeStickerDeckInitialized;
  };

  document.addEventListener("astro:before-swap", cleanup, { once: true });
  return cleanup;
};
