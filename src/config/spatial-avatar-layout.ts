/** 首屏滚动到该比例后进入固定阅读态，三维场景与静态降级共用同一边界。 */
export const SPATIAL_AVATAR_READING_PHASE_RATIO = 0.82;

/** 滚动提示在首段前半程提前退出，把视觉重心平稳交给 About 与模型。 */
const SPATIAL_SCROLL_CUE_FADE_END = 0.34;

/** 目录中心进入视口中央安全区后保持完整清晰。 */
export const SPATIAL_DIRECTORY_FOCUS_INNER_RATIO = 0.18;

/** 目录中心接近视口边缘时完全融回背景，避免同屏出现两个视觉重点。 */
export const SPATIAL_DIRECTORY_FOCUS_OUTER_RATIO = 0.48;

export interface SpatialAvatarIntroPresentation {
  aboutOpacity: number;
  cueOpacity: number;
}

/** 把任意数值限制到首屏过渡的归一化区间。 */
const clampTransitionProgress = (value: number): number =>
  Math.min(1, Math.max(0, value));

/** 使用平滑端点生成滚动渐变，避免开始和结束位置出现明暗跳变。 */
const easeTransitionProgress = (value: number): number => {
  const progress = clampTransitionProgress(value);
  return progress * progress * (3 - 2 * progress);
};

/**
 * 把页面滚动距离统一映射到首屏过渡进度。
 * 文字、静态海报与 Three.js 模型必须共用该函数，避免切换边界漂移。
 */
export const readSpatialAvatarTransitionProgress = (
  scrollY: number,
  pageTop: number,
  transitionDistance: number,
): number =>
  clampTransitionProgress(
    (scrollY - pageTop) / Math.max(1, transitionDistance),
  );

/** 根据同一首屏进度返回 About 与滚动提示的可见度。 */
export const readSpatialAvatarIntroPresentation = (
  progress: number,
): SpatialAvatarIntroPresentation => ({
  aboutOpacity: 1 - easeTransitionProgress(progress),
  cueOpacity:
    1 - easeTransitionProgress(progress / SPATIAL_SCROLL_CUE_FADE_END),
});

/**
 * 根据目录章节中心与视口中心的距离计算可见度。
 * 只改变文字透明度，不在背景上叠加颜色，因此滚动交接不会产生横向硬边。
 */
export const readSpatialDirectoryFocusOpacity = (
  chapterCenterY: number,
  viewportCenterY: number,
  viewportHeight: number,
): number => {
  const normalizedDistance =
    Math.abs(chapterCenterY - viewportCenterY) / Math.max(1, viewportHeight);
  const fadeProgress =
    (normalizedDistance - SPATIAL_DIRECTORY_FOCUS_INNER_RATIO) /
    (SPATIAL_DIRECTORY_FOCUS_OUTER_RATIO -
      SPATIAL_DIRECTORY_FOCUS_INNER_RATIO);
  return 1 - easeTransitionProgress(fadeProgress);
};
