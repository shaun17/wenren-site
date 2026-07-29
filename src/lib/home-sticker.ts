type StickerCleanup = () => void;
type StickerPointerMode = "move" | "rotate";

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

const VIEWPORT_PADDING = 16;
const KEYBOARD_MOVE_STEP = 12;
const KEYBOARD_ROTATE_STEP = 6;

/** 把任意角度收敛到 -180 至 180 度，避免连续旋转累积出过大的 CSS 数值。 */
export const normalizeStickerRotation = (degrees: number): number => {
  const normalized = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
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

/** 读取指针相对贴纸中心的角度，供 Shift 拖拽直接控制旋转。 */
const readPointerAngle = (
  event: PointerEvent,
  center: StickerTranslation,
): number =>
  (Math.atan2(event.clientY - center.y, event.clientX - center.x) * 180) /
  Math.PI;

/** 初始化一张首页贴纸；交互结束后保留状态，直到失焦才缓慢回到右上角。 */
export const initHomeSticker = (sticker: HTMLElement): StickerCleanup => {
  if (sticker.dataset.homeStickerInitialized === "true") {
    return () => undefined;
  }

  sticker.dataset.homeStickerInitialized = "true";
  const abortController = new AbortController();
  const { signal } = abortController;
  let translation: StickerTranslation = { x: 0, y: 0 };
  let rotation = 0;
  let activePointerId: number | null = null;
  let pointerMode: StickerPointerMode | null = null;
  let pointerOrigin: StickerTranslation = { x: 0, y: 0 };
  let translationOrigin: StickerTranslation = { x: 0, y: 0 };
  let translationBounds: StickerTranslationBounds = {
    minimumX: 0,
    maximumX: 0,
    minimumY: 0,
    maximumY: 0,
  };
  let rotationOrigin = 0;
  let pointerAngleOrigin = 0;
  let rotationCenter: StickerTranslation = { x: 0, y: 0 };

  /** 把当前交互状态写入组合层，避免拖拽时触发布局与重排。 */
  const renderTransform = (): void => {
    sticker.style.setProperty("--sticker-x", `${translation.x.toFixed(2)}px`);
    sticker.style.setProperty("--sticker-y", `${translation.y.toFixed(2)}px`);
    sticker.style.setProperty(
      "--sticker-rotation",
      `${rotation.toFixed(2)}deg`,
    );
  };

  /** 按贴纸当前包围盒计算可移动范围，旋转后的四角也不会完全离开视口。 */
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

  /** 清除指针编号和交互样式，供正常释放与系统丢失捕获共同复用。 */
  const clearPointerInteractionState = (): void => {
    activePointerId = null;
    pointerMode = null;
    sticker.classList.remove("is-dragging", "is-rotating");
  };

  /** 取消活动指针，让 CSS 重新接管平滑过渡。 */
  const finishPointerInteraction = (): void => {
    if (
      activePointerId !== null &&
      sticker.hasPointerCapture(activePointerId)
    ) {
      sticker.releasePointerCapture(activePointerId);
    }
    clearPointerInteractionState();
  };

  /** 将位移和手动角度一起归零，形成一次完整的缓慢归位。 */
  const returnHome = (): void => {
    finishPointerInteraction();
    translation = { x: 0, y: 0 };
    rotation = 0;
    renderTransform();
  };

  /** 按普通拖拽或 Shift 旋转两种模式记录本次指针交互起点。 */
  const handlePointerDown = (event: PointerEvent): void => {
    if (activePointerId !== null || event.button !== 0 || !event.isPrimary) {
      return;
    }

    event.preventDefault();
    sticker.focus({ preventScroll: true });
    activePointerId = event.pointerId;
    pointerMode = event.shiftKey ? "rotate" : "move";
    pointerOrigin = { x: event.clientX, y: event.clientY };
    translationOrigin = { ...translation };
    rotationOrigin = rotation;
    const bounds = sticker.getBoundingClientRect();
    rotationCenter = {
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    };
    pointerAngleOrigin = readPointerAngle(event, rotationCenter);
    translationBounds = readTranslationBounds();
    sticker.classList.add(
      pointerMode === "rotate" ? "is-rotating" : "is-dragging",
    );
    sticker.setPointerCapture(event.pointerId);
  };

  /** 在动画帧友好的 transform 通道中更新位移或旋转，不修改页面布局。 */
  const handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId || !pointerMode) return;
    event.preventDefault();

    if (pointerMode === "rotate") {
      const pointerAngle = readPointerAngle(event, rotationCenter);
      rotation = normalizeStickerRotation(
        rotationOrigin + pointerAngle - pointerAngleOrigin,
      );
    } else {
      translation = clampStickerTranslation(
        {
          x: translationOrigin.x + event.clientX - pointerOrigin.x,
          y: translationOrigin.y + event.clientY - pointerOrigin.y,
        },
        translationBounds,
      );
    }
    renderTransform();
  };

  /** 指针释放后保留用户调整结果；下一次失焦才触发缓慢归位。 */
  const handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;
    finishPointerInteraction();
  };

  /** 系统中断手势时直接归位，避免贴纸停留在无法继续操作的半完成状态。 */
  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;
    returnHome();
  };

  /** 浏览器意外移除指针捕获时结束手势，避免遗留抓取光标或无过渡状态。 */
  const handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) return;
    clearPointerInteractionState();
  };

  /** 鼠标滚轮提供连续旋转，并把单次大幅滚动限制为可控角度。 */
  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    sticker.focus({ preventScroll: true });
    const deltaScale =
      event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? window.innerHeight
          : 1;
    const degrees = Math.min(
      14,
      Math.max(-14, event.deltaY * deltaScale * 0.06),
    );
    rotation = normalizeStickerRotation(rotation + degrees);
    renderTransform();
  };

  /** 键盘方向键移动贴纸，Shift 加左右方向键旋转，Escape 或激活按钮归位。 */
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      returnHome();
      return;
    }

    if (event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      rotation = normalizeStickerRotation(
        rotation + direction * KEYBOARD_ROTATE_STEP,
      );
      renderTransform();
      return;
    }

    const movementByKey: Partial<Record<string, StickerTranslation>> = {
      ArrowUp: { x: 0, y: -KEYBOARD_MOVE_STEP },
      ArrowDown: { x: 0, y: KEYBOARD_MOVE_STEP },
      ArrowLeft: { x: -KEYBOARD_MOVE_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_MOVE_STEP, y: 0 },
    };
    const movement = movementByKey[event.key];
    if (!movement) return;

    event.preventDefault();
    translation = clampStickerTranslation(
      {
        x: translation.x + movement.x,
        y: translation.y + movement.y,
      },
      readTranslationBounds(),
    );
    renderTransform();
  };

  /** 点击贴纸以外的任意区域都视为结束操作，弥补空白元素不会主动接收焦点的情况。 */
  const handleDocumentPointerDown = (event: PointerEvent): void => {
    if (event.composedPath().includes(sticker)) return;
    sticker.blur();
    returnHome();
  };

  /** 浏览器窗口尺寸改变后回到稳定锚点，避免沿用旧视口的边界。 */
  const handleViewportChange = (): void => returnHome();

  /** 页面进入后台时同步归位，重新显示时不会留下过期交互状态。 */
  const handleVisibilityChange = (): void => {
    if (document.hidden) returnHome();
  };

  /** 幂等移除所有监听器，并恢复服务端渲染时的初始样式。 */
  const cleanup = (): void => {
    abortController.abort();
    finishPointerInteraction();
    sticker.style.removeProperty("--sticker-x");
    sticker.style.removeProperty("--sticker-y");
    sticker.style.removeProperty("--sticker-rotation");
    delete sticker.dataset.homeStickerInitialized;
  };

  sticker.addEventListener("pointerdown", handlePointerDown, { signal });
  sticker.addEventListener("pointermove", handlePointerMove, { signal });
  sticker.addEventListener("pointerup", handlePointerUp, { signal });
  sticker.addEventListener("pointercancel", handlePointerCancel, { signal });
  sticker.addEventListener("lostpointercapture", handleLostPointerCapture, {
    signal,
  });
  sticker.addEventListener("wheel", handleWheel, { passive: false, signal });
  sticker.addEventListener("keydown", handleKeyDown, { signal });
  sticker.addEventListener("blur", returnHome, { signal });
  document.addEventListener("pointerdown", handleDocumentPointerDown, {
    capture: true,
    signal,
  });
  window.addEventListener("blur", returnHome, { signal });
  window.addEventListener("resize", handleViewportChange, {
    passive: true,
    signal,
  });
  document.addEventListener("visibilitychange", handleVisibilityChange, {
    signal,
  });
  document.addEventListener("astro:before-swap", cleanup, {
    once: true,
    signal,
  });
  renderTransform();
  return cleanup;
};
