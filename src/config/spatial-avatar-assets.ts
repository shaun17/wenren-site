/**
 * 集中声明空间肖像的内容寻址资源，保证首页预取、模型加载和静态海报始终指向同一版本。
 */
export const spatialAvatarAssets = {
  model: "/3d/wenren-avatar-617f0102b1df.glb",
  loadingPoster: "/3d/wenren-avatar-loading-poster-47853e3d4a94.jpg",
  loadingPosterMobile:
    "/3d/wenren-avatar-loading-poster-mobile-f4a45f288e5b.jpg",
  staticPoster: "/3d/wenren-avatar-poster-8a79a7b0a61d.jpg",
  staticPosterMobile:
    "/3d/wenren-avatar-poster-mobile-49a408e5118b.jpg",
} as const;
