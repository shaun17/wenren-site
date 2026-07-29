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
  originX: number;
  originY: number;
}

export type StickerRotationDirection = -1 | 1;

const VIEWPORT_PADDING = 16;
const CLICK_DRAG_THRESHOLD = 6;
const MIN_ANGULAR_VELOCITY = 65;
export const STICKER_CLICK_ROTATION_SPEEDS = [
  720, 840, 960, 1_080, 1_200,
] as const;
const ANGULAR_DAMPING = 2.6;
const ANGULAR_STOP_SPEED = 14;
const MAX_INERTIA_DURATION_MS = 2_400;
const ROTATION_SETTLE_DURATION_MS = 380;
const PRESS_MAX_TILT = 6;
const PRESS_ORIGIN_SHIFT = 36;

/** 将数值限制在指定闭区间，供所有指针物理计算复用。 */
const clampNumber = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

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
 * 把鼠标落点映射为静态 3D 压感：落点一侧向下，支点移到反方向，
 * 因而鼠标停住时画面也会稳定停住，不再循环摆动。
 */
export const mapStickerPressure = (
  pointer: StickerTranslation,
  bounds: StickerPressureBounds,
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

  return {
    tiltX: -normalizedY * PRESS_MAX_TILT,
    tiltY: normalizedX * PRESS_MAX_TILT,
    originX: 50 - normalizedX * PRESS_ORIGIN_SHIFT,
    originY: 50 - normalizedY * PRESS_ORIGIN_SHIFT,
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

/** 按指定方向找到下一完整圈；未指定方向时退回最近完整圈。 */
export const readStickerRestRotation = (
  rotation: number,
  direction?: StickerRotationDirection,
): number => {
  if (direction === 1) return Math.ceil(rotation / 360) * 360;
  if (direction === -1) return Math.floor(rotation / 360) * 360;
  return Math.round(rotation / 360) * 360;
};

/** 初始化首页贴纸的拖拽归位、落点压感和点击随机旋转。 */
export const initHomeSticker = (sticker: HTMLElement): StickerCleanup => {
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
  let translation: StickerTranslation = { x: 0, y: 0 };
  let rotation = 0;
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

  /** 只把位移写给按钮外层，让松手归位不干扰内层旋转。 */
  const renderTranslation = (): void => {
    sticker.style.setProperty("--sticker-x", `${translation.x.toFixed(2)}px`);
    sticker.style.setProperty("--sticker-y", `${translation.y.toFixed(2)}px`);
  };

  /** 只把累计角度写给旋转层，惯性期间允许连续跨越多个完整圈。 */
  const renderRotation = (): void => {
    sticker.style.setProperty(
      "--sticker-rotation",
      `${rotation.toFixed(3)}deg`,
    );
  };

  /** 把当前鼠标落点写成固定压感姿态，鼠标不动时数值也不再变化。 */
  const renderPointerPressure = (event: PointerEvent): void => {
    if (!precisePointerQuery.matches && event.pointerType !== "mouse") return;

    const bounds = sticker.getBoundingClientRect();
    const pose = mapStickerPressure(
      { x: event.clientX, y: event.clientY },
      bounds,
    );
    sticker.style.setProperty(
      "--sticker-tilt-x",
      `${pose.tiltX.toFixed(2)}deg`,
    );
    sticker.style.setProperty(
      "--sticker-tilt-y",
      `${pose.tiltY.toFixed(2)}deg`,
    );
    sticker.style.setProperty(
      "--sticker-origin-x",
      `${pose.originX.toFixed(2)}%`,
    );
    sticker.style.setProperty(
      "--sticker-origin-y",
      `${pose.originY.toFixed(2)}%`,
    );
    sticker.classList.add("is-pointer-over");
  };

  /** 清除压感姿态，并让贴纸表面短暂平滑回到水平状态。 */
  const clearPointerPressure = (): void => {
    sticker.classList.remove("is-pointer-over");
    sticker.style.setProperty("--sticker-tilt-x", "0deg");
    sticker.style.setProperty("--sticker-tilt-y", "0deg");
    sticker.style.setProperty("--sticker-origin-x", "50%");
    sticker.style.setProperty("--sticker-origin-y", "50%");
  };

  /** 读取 CSS 归位过渡中的真实位置，快速二次抓取时不会突然跳回目标值。 */
  const readRenderedTranslation = (): StickerTranslation => {
    const transform = window.getComputedStyle(sticker).transform;
    if (!transform || transform === "none") return { x: 0, y: 0 };

    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41, y: matrix.m42 };
  };

  /** 按贴纸当前包围盒计算可移动范围，拖拽后仍保留可操作边距。 */
  const readTranslationBounds = (): StickerTranslationBounds => {
    const bounds = sticker.getBoundingClientRect();
    return {
      minimumX: translation.x + VIEWPORT_PADDING - bounds.left,
      maximumX:
        translation.x + window.innerWidth - VIEWPORT_PADDING - bounds.right,
      minimumY: translation.y + VIEWPORT_PADDING - bounds.top,
      maximumY:
        translation.y + window.innerHeight - VIEWPORT_PADDING - bounds.bottom,
    };
  };

  /** 停止当前旋转帧，但保留画面上的累计角度供下一次抓取继续。 */
  const cancelRotationAnimation = (): void => {
    if (rotationFrame !== null) cancelAnimationFrame(rotationFrame);
    rotationFrame = null;
    sticker.classList.remove("is-spinning");
  };

  /** 惯性减弱后收敛到最近完整圈，再无视觉跳变地把内部数值归零。 */
  const settleRotation = (direction?: StickerRotationDirection): void => {
    cancelRotationAnimation();
    const startRotation = rotation;
    const targetRotation = readStickerRestRotation(rotation, direction);
    if (Math.abs(targetRotation - startRotation) < 0.01) {
      rotation = 0;
      renderRotation();
      return;
    }

    const startTime = performance.now();
    sticker.classList.add("is-spinning");

    /** 用三次缓出完成最后转正，整个过程仍由独立旋转层承担。 */
    const settleFrame = (now: number): void => {
      const progress = clampNumber(
        (now - startTime) / ROTATION_SETTLE_DURATION_MS,
        0,
        1,
      );
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      rotation =
        startRotation + (targetRotation - startRotation) * easedProgress;
      renderRotation();

      if (progress < 1) {
        rotationFrame = requestAnimationFrame(settleFrame);
        return;
      }

      rotationFrame = null;
      rotation = 0;
      renderRotation();
      sticker.classList.remove("is-spinning");
    };

    rotationFrame = requestAnimationFrame(settleFrame);
  };

  /** 按释放角速度启动多圈惯性，并用指数阻尼自然减速后转正。 */
  const startInertialRotation = (initialVelocity: number): void => {
    cancelRotationAnimation();
    const rotationDirection: StickerRotationDirection =
      initialVelocity < 0 ? -1 : 1;
    if (reducedMotionQuery.matches) {
      rotation = 0;
      renderRotation();
      return;
    }
    if (Math.abs(initialVelocity) < MIN_ANGULAR_VELOCITY) {
      settleRotation(rotationDirection);
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
        rotationFrame = null;
        settleRotation(rotationDirection);
        return;
      }

      rotationFrame = requestAnimationFrame(inertiaFrame);
    };

    rotationFrame = requestAnimationFrame(inertiaFrame);
  };

  /** 用不同随机速度启动本次点击旋转，并立即把下一次方向翻转。 */
  const startClickRotation = (): void => {
    const speed = selectStickerClickRotationSpeed(
      Math.random(),
      previousClickRotationSpeed,
    );
    previousClickRotationSpeed = speed;
    startInertialRotation(speed * nextClickRotationDirection);
    nextClickRotationDirection = readOppositeStickerRotationDirection(
      nextClickRotationDirection,
    );
  };

  /** 只结束当前指针捕获；pointerup 会在随后决定点击旋转或拖拽归位。 */
  const finishPointerInteraction = (): void => {
    const pointerId = activePointerId;
    activePointerId = null;
    sticker.classList.remove("is-dragging");
    if (pointerId !== null && sticker.hasPointerCapture(pointerId)) {
      sticker.releasePointerCapture(pointerId);
    }
  };

  /** 松手后立即把位移目标设回锚点，CSS 只负责这一层的平滑回弹。 */
  const returnTranslationHome = (): void => {
    translation = { x: 0, y: 0 };
    renderTranslation();
  };

  /** 异常中断时取消所有动画并完整归位，避免留下半完成状态。 */
  const resetSticker = (): void => {
    finishPointerInteraction();
    cancelRotationAnimation();
    translation = { x: 0, y: 0 };
    rotation = 0;
    renderTranslation();
    renderRotation();
    clearPointerPressure();
  };

  /** 记录抓取起点并停止旧惯性，后续用最大位移区分点击和拖拽。 */
  const handlePointerDown = (event: PointerEvent): void => {
    if (activePointerId !== null || event.button !== 0 || !event.isPrimary) {
      return;
    }

    event.preventDefault();
    sticker.focus({ preventScroll: true });
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

  /** 松手后拖拽只归位；只有未超过阈值的单击才启动随机交替旋转。 */
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
    finishPointerInteraction();
    returnTranslationHome();
    clearPointerPressure();
    if (shouldRotate) startClickRotation();
  };

  /** 系统取消手势时不制造虚假惯性，直接安全归位。 */
  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === activePointerId) resetSticker();
  };

  /** 捕获被浏览器意外夺走时执行兜底归位，正常释放因编号已清空不会重复处理。 */
  const handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId === activePointerId) resetSticker();
  };

  /** 键盘激活键复用点击旋转序列，Escape 立即归位。 */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      resetSticker();
      return;
    }

    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      startClickRotation();
    }
  };

  /** 视口或动态偏好变化会终止旧坐标系中的动画并回到稳定锚点。 */
  const handleEnvironmentChange = (): void => resetSticker();

  /** 页面进入后台时同步归位，重新显示时不会继续过期的惯性帧。 */
  const handleVisibilityChange = (): void => {
    if (document.hidden) resetSticker();
  };

  /** 幂等移除所有监听器和动画，并恢复服务端渲染时的初始样式。 */
  const cleanup = (): void => {
    abortController.abort();
    finishPointerInteraction();
    cancelRotationAnimation();
    for (const property of [
      "--sticker-x",
      "--sticker-y",
      "--sticker-rotation",
      "--sticker-tilt-x",
      "--sticker-tilt-y",
      "--sticker-origin-x",
      "--sticker-origin-y",
    ]) {
      sticker.style.removeProperty(property);
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
  sticker.addEventListener("keydown", handleKeyDown, { signal });
  window.addEventListener("blur", handleEnvironmentChange, { signal });
  window.addEventListener("resize", handleEnvironmentChange, {
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
  renderTranslation();
  renderRotation();
  clearPointerPressure();
  return cleanup;
};
