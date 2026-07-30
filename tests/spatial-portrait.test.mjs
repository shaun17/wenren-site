import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageSize } from "image-size";
import sharp from "sharp";
import * as THREE from "three";
import { spatialAvatarAssets } from "../src/config/spatial-avatar-assets.ts";
import {
  readSpatialAvatarIntroPresentation,
  readSpatialAvatarTransitionProgress,
  readSpatialDirectoryFocusOpacity,
  SPATIAL_AVATAR_READING_PHASE_RATIO,
  SPATIAL_DIRECTORY_FOCUS_INNER_RATIO,
  SPATIAL_DIRECTORY_FOCUS_OUTER_RATIO,
} from "../src/config/spatial-avatar-layout.ts";
import {
  canPresentSpatialAvatarScene,
  createPortraitLightRig,
  createPortraitLayoutFrames,
  mapPointerToGaze,
  MAX_EYE_PITCH,
  MAX_EYE_YAW,
  MAX_PORTRAIT_DRAG_YAW,
  POINTER_GAZE_RADIUS_X_RATIO,
  POINTER_GAZE_RADIUS_Y_RATIO,
  PORTRAIT_ENVIRONMENT_INTENSITY,
  PORTRAIT_TONE_MAPPING_EXPOSURE,
  readPortraitDragYaw,
  readPortraitLayoutFrame,
  readPortraitLayoutProgress,
  readPortraitDepthScale,
  resolvePortraitYaw,
  setEyeTargetQuaternion,
} from "../src/lib/spatial-avatar-scene.ts";
import {
  shouldIdlePrefetchSpatialAvatar,
  shouldPrefetchSpatialAvatar,
} from "../src/lib/spatial-avatar-prefetch.ts";
import { prepareSpatialAvatarModelLoad } from "../src/lib/spatial-avatar-model.ts";
import { supportsSpatialAvatarWebGL } from "../src/lib/spatial-portrait.ts";

/** 把站点根路径资源解析到 public 目录，测试与生产代码共享同一份资产契约。 */
const resolvePublicAssetUrl = (assetPath) =>
  new URL(`../public${assetPath}`, import.meta.url);

const modelUrl = resolvePublicAssetUrl(spatialAvatarAssets.model);
const loadingPosterUrl = resolvePublicAssetUrl(
  spatialAvatarAssets.loadingPoster,
);
const loadingMobilePosterUrl = resolvePublicAssetUrl(
  spatialAvatarAssets.loadingPosterMobile,
);
const posterUrl = resolvePublicAssetUrl(spatialAvatarAssets.staticPoster);
const mobilePosterUrl = resolvePublicAssetUrl(
  spatialAvatarAssets.staticPosterMobile,
);
const MODEL_SHA256 =
  "617f0102b1df6e1fb59eac134a3ba0d97f785a3767ba0a24deb0fc65fd14cda7";
const LOADING_POSTER_SHA256 =
  "47853e3d4a94b5f4be5bdf7f80ca68b20a326b728ae7e43268fbd2b874356774";
const LOADING_MOBILE_POSTER_SHA256 =
  "f4a45f288e5b4824acde1e08282ccab2f8e294cd844e01f61dff9b207dab1e90";
const POSTER_SHA256 =
  "8a79a7b0a61dfa08e267e12ff660f25771739ea5af431a63f53b723311c8db81";
const MOBILE_POSTER_SHA256 =
  "49a408e5118b9f42729c19f9c6656024b4c5b35a9f2e592d6afc178f13a38f5b";
const BODY_NODE_NAME = "tripo_node_7ab0ba04-e9ae-45f9-836c-f4b5c53c7fae";
const EYE_CONTRACTS = [
  {
    sourcePivotName: "EyeAim.L",
    pivotName: "EyeAimL",
    sourceMeshNames: [
      "Eye_L",
      "EyeHighlightMain.L",
      "EyeHighlightSmall.L",
      "Iris.L",
      "IrisAccent.L",
      "IrisRing.L",
      "Pupil.L",
    ],
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
    sourcePivotName: "EyeAim.R",
    pivotName: "EyeAimR",
    sourceMeshNames: [
      "Eye_R",
      "EyeHighlightMain.R",
      "EyeHighlightSmall.R",
      "Iris.R",
      "IrisAccent.R",
      "IrisRing.R",
      "Pupil.R",
    ],
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
];

/** 从 GLB 二进制中读取 JSON 与 BIN 块，直接验证最终模型数据契约。 */
const readGlbAsset = (buffer) => {
  assert.equal(buffer.toString("ascii", 0, 4), "glTF");
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  const jsonLength = buffer.readUInt32LE(12);
  assert.equal(buffer.toString("ascii", 16, 20), "JSON");
  const document = JSON.parse(
    buffer.toString("utf8", 20, 20 + jsonLength).trim(),
  );
  const binaryHeader = 20 + jsonLength;
  const binaryLength = buffer.readUInt32LE(binaryHeader);
  assert.equal(
    buffer.toString("ascii", binaryHeader + 4, binaryHeader + 7),
    "BIN",
  );
  const binary = buffer.subarray(
    binaryHeader + 8,
    binaryHeader + 8 + binaryLength,
  );
  return { binary, document };
};

/** 返回某个 bufferView 的原始字节，用实际图片内容核对纹理尺寸。 */
const readBufferViewBytes = (asset, viewIndex) => {
  const view = asset.document.bufferViews[viewIndex];
  const byteOffset = view.byteOffset ?? 0;
  return asset.binary.subarray(byteOffset, byteOffset + view.byteLength);
};

/** 从网格中选择距离局部原点最远的顶点，让旋转位移稳定可观测。 */
const readObservableMeshVertex = (mesh) => {
  const positions = mesh.geometry.getAttribute("position");
  let selectedIndex = 0;
  let selectedDistance = -Infinity;
  for (let index = 0; index < positions.count; index += 1) {
    const distance =
      positions.getX(index) ** 2 +
      positions.getY(index) ** 2 +
      positions.getZ(index) ** 2;
    if (distance <= selectedDistance) continue;
    selectedDistance = distance;
    selectedIndex = index;
  }
  return new THREE.Vector3().fromBufferAttribute(positions, selectedIndex);
};

/** 把网格局部顶点转换到世界坐标，用真实矩阵验证眼球独立转动。 */
const readWorldVertex = (mesh, localVertex) =>
  localVertex.clone().applyMatrix4(mesh.matrixWorld);

/** 一次记录整组网格的世界顶点，避免只验证单个虹膜组件。 */
const captureWorldVertices = (meshes, localVertices) =>
  meshes.map((mesh, index) => readWorldVertex(mesh, localVertices[index]));

/** 逐项比较两组世界顶点，验证主动眼球与被动对象是否按预期移动。 */
const readVertexDistances = (before, after) =>
  before.map((vertex, index) => vertex.distanceTo(after[index]));

/** 允许 glTF 浮点序列化产生极小误差，同时保留坐标契约的可读性。 */
const assertVectorClose = (actual, expected, epsilon = 1e-7) => {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of actual.entries()) {
    assert.ok(
      Math.abs(value - expected[index]) <= epsilon,
      `第 ${index} 轴偏差过大：${value} !== ${expected[index]}`,
    );
  }
};

/** 以稳定的暗部阈值提取人物边界，防止内容哈希正确但构图再次偏离画面中心。 */
const readPortraitBounds = async (buffer) => {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minimumX = info.width;
  let maximumX = -1;
  let maximumY = -1;
  let selectedPixels = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const lightness =
        (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
      if (lightness >= 190) continue;
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      selectedPixels += 1;
    }
  }

  assert.ok(selectedPixels > info.width * info.height * 0.05);
  return {
    centerRatio: (minimumX + maximumX) / (2 * info.width),
    height: info.height,
    maximumX,
    maximumY,
    minimumX,
    width: info.width,
  };
};

/** 把肖像布局帧转成固定顺序的向量，集中比较首屏过渡允许改变的全部通道。 */
const portraitLayoutFrameValues = (frame) => [
  frame.gazeX,
  frame.modelX,
  frame.modelY,
  frame.modelYaw,
  frame.scale,
];

/** 肖像只从首屏近景过渡一次到阅读态，超过首屏距离后必须永久固定。 */
test("transitions once from the centered close-up to the stable reading layout", () => {
  const desktop = createPortraitLayoutFrames(false);
  const compact = createPortraitLayoutFrames(true);
  assert.equal(desktop.length, 2);
  assert.equal(compact.length, 2);

  for (const frame of [...desktop, ...compact]) {
    assert.deepEqual(Object.keys(frame).sort(), [
      "gazeX",
      "modelX",
      "modelY",
      "modelYaw",
      "scale",
    ]);
    assert.ok(portraitLayoutFrameValues(frame).every(Number.isFinite));
    assert.ok(frame.scale > 0);
  }

  assert.equal(desktop[0].modelX, 0, "桌面首屏近景必须水平居中");
  assert.equal(desktop[0].modelYaw, 0, "桌面首屏必须保持正面朝向");
  assert.equal(desktop[0].gazeX, 0, "桌面首屏必须保持居中目光");
  assert.ok(desktop[1].modelX < 0, "桌面阅读态必须把模型固定到左侧");
  assert.ok(
    desktop[1].modelYaw >= THREE.MathUtils.degToRad(5) &&
      desktop[1].modelYaw <= THREE.MathUtils.degToRad(12),
    "桌面阅读态必须只向右轻转 5 至 12 度",
  );
  assert.ok(desktop[1].gazeX > 0, "桌面阅读态目光必须配合身体看向右栏");
  assert.ok(
    Math.abs(
      desktop[1].gazeX * MAX_EYE_YAW - THREE.MathUtils.degToRad(5.25),
    ) < 1e-10,
    "扩大活动范围后必须保持阅读态原有的默认右视角",
  );
  assert.equal(compact[0].modelX, 0, "移动端首屏近景必须水平居中");
  assert.equal(compact[1].modelX, 0, "移动端阅读态必须继续保持水平居中");
  assert.equal(compact[0].modelYaw, 0, "移动端首屏必须保持正面朝向");
  assert.equal(compact[1].modelYaw, 0, "移动端阅读态不应向侧边旋转");
  assert.equal(compact[0].gazeX, 0, "移动端首屏必须保持居中目光");
  assert.equal(compact[1].gazeX, 0, "移动端阅读态必须保持居中目光");
  assert.ok(desktop[0].scale > desktop[1].scale, "桌面首屏必须比阅读态更近");
  assert.ok(compact[0].scale > compact[1].scale, "移动端首屏必须比阅读态更近");

  const pageTop = 100;
  const viewportHeight = 800;
  const transitionDistance =
    viewportHeight * SPATIAL_AVATAR_READING_PHASE_RATIO;
  assert.equal(
    readPortraitLayoutProgress(pageTop - 20, pageTop, transitionDistance),
    0,
  );
  assert.equal(
    readPortraitLayoutProgress(pageTop, pageTop, transitionDistance),
    0,
  );
  assert.equal(
    readPortraitLayoutProgress(
      pageTop + transitionDistance / 2,
      pageTop,
      transitionDistance,
    ),
    0.5,
  );
  assert.equal(
    readPortraitLayoutProgress(
      pageTop + transitionDistance,
      pageTop,
      transitionDistance,
    ),
    1,
  );
  assert.equal(
    readPortraitLayoutProgress(
      pageTop + viewportHeight,
      pageTop,
      transitionDistance,
    ),
    1,
    "Résumé 进入视口时模型必须已经完成阅读态过渡",
  );

  assertVectorClose(
    portraitLayoutFrameValues(readPortraitLayoutFrame(-1, desktop)),
    portraitLayoutFrameValues(desktop[0]),
  );
  assertVectorClose(
    portraitLayoutFrameValues(readPortraitLayoutFrame(2, desktop)),
    portraitLayoutFrameValues(desktop[1]),
  );
  const desktopMiddle = readPortraitLayoutFrame(0.5, desktop);
  assertVectorClose(
    portraitLayoutFrameValues(desktopMiddle),
    portraitLayoutFrameValues(desktop[0]).map(
      (value, index) =>
        (value + portraitLayoutFrameValues(desktop[1])[index]) / 2,
    ),
  );

  for (const frames of [desktop, compact]) {
    for (const scrollY of [
      pageTop + viewportHeight,
      pageTop + viewportHeight * 2,
      pageTop + viewportHeight * 3,
      pageTop + viewportHeight * 4,
    ]) {
      const progress = readPortraitLayoutProgress(
        scrollY,
        pageTop,
        transitionDistance,
      );
      assert.equal(progress, 1);
      assertVectorClose(
        portraitLayoutFrameValues(readPortraitLayoutFrame(progress, frames)),
        portraitLayoutFrameValues(frames[1]),
      );
    }
  }
});

/** 横向拖动只产生有限的绝对水平朝向，不改变布局层已有的其他通道。 */
test("clamps direct portrait dragging to 45 degrees on either side", () => {
  const dragDistance = 320;
  const readingYaw = THREE.MathUtils.degToRad(8);
  assert.equal(MAX_PORTRAIT_DRAG_YAW, Math.PI / 4);
  assert.equal(readPortraitDragYaw(0, 0, dragDistance), 0);
  assert.equal(
    readPortraitDragYaw(0, dragDistance, dragDistance),
    MAX_PORTRAIT_DRAG_YAW,
  );
  assert.equal(
    readPortraitDragYaw(0, -dragDistance, dragDistance),
    -MAX_PORTRAIT_DRAG_YAW,
  );
  assert.equal(
    readPortraitDragYaw(readingYaw, dragDistance * 4, dragDistance),
    MAX_PORTRAIT_DRAG_YAW,
    "阅读态已有的右转不得让最终角度超过 45 度",
  );
  assert.equal(
    readPortraitDragYaw(readingYaw, -dragDistance * 4, dragDistance),
    -MAX_PORTRAIT_DRAG_YAW,
  );

  const samples = [-640, -320, -120, 0, 120, 320, 640].map((deltaX) =>
    readPortraitDragYaw(readingYaw, deltaX, dragDistance),
  );
  for (const [index, yaw] of samples.entries()) {
    assert.ok(Number.isFinite(yaw));
    assert.ok(yaw >= -MAX_PORTRAIT_DRAG_YAW);
    assert.ok(yaw <= MAX_PORTRAIT_DRAG_YAW);
    if (index > 0) assert.ok(yaw >= samples[index - 1]);
  }
  assert.equal(resolvePortraitYaw(readingYaw, null), readingYaw);
  assert.equal(
    resolvePortraitYaw(readingYaw, Math.PI),
    MAX_PORTRAIT_DRAG_YAW,
  );
  assert.equal(
    resolvePortraitYaw(readingYaw, -Math.PI),
    -MAX_PORTRAIT_DRAG_YAW,
  );
});

/** About 与滚动提示共享模型过渡进度，并按各自节奏单调淡出。 */
test("fades the avatar introduction with the shared scroll progress", () => {
  const pageTop = 120;
  const transitionDistance = 640;
  assert.equal(
    readSpatialAvatarTransitionProgress(
      pageTop - 40,
      pageTop,
      transitionDistance,
    ),
    0,
  );
  assert.equal(
    readSpatialAvatarTransitionProgress(
      pageTop + transitionDistance / 2,
      pageTop,
      transitionDistance,
    ),
    0.5,
  );
  assert.equal(
    readSpatialAvatarTransitionProgress(
      pageTop + transitionDistance * 2,
      pageTop,
      transitionDistance,
    ),
    1,
  );

  const samples = [-1, 0, 0.1, 0.25, 0.34, 0.5, 0.75, 1, 2].map(
    readSpatialAvatarIntroPresentation,
  );
  assert.deepEqual(samples[0], { aboutOpacity: 1, cueOpacity: 1 });
  assert.deepEqual(samples.at(-1), { aboutOpacity: 0, cueOpacity: 0 });
  for (const [index, sample] of samples.entries()) {
    assert.ok(sample.aboutOpacity >= 0 && sample.aboutOpacity <= 1);
    assert.ok(sample.cueOpacity >= 0 && sample.cueOpacity <= 1);
    assert.ok(
      sample.cueOpacity <= sample.aboutOpacity,
      "滚动提示不能晚于 About 消失",
    );
    if (index === 0) continue;
    assert.ok(sample.aboutOpacity <= samples[index - 1].aboutOpacity);
    assert.ok(sample.cueOpacity <= samples[index - 1].cueOpacity);
  }
  assert.equal(samples[4].cueOpacity, 0, "滚动提示应在首段前半程完全淡出");
  assert.ok(samples[4].aboutOpacity > 0, "About 应继续随首屏剩余距离渐隐");
});

/** 目录文字只在视口中心成为重点，并以平滑透明度融回共享底色。 */
test("keeps only the centered directory chapter visually prominent", () => {
  const viewportHeight = 800;
  const viewportCenterY = 1200;
  assert.equal(
    readSpatialDirectoryFocusOpacity(
      viewportCenterY,
      viewportCenterY,
      viewportHeight,
    ),
    1,
  );
  assert.equal(
    readSpatialDirectoryFocusOpacity(
      viewportCenterY +
        viewportHeight * SPATIAL_DIRECTORY_FOCUS_INNER_RATIO,
      viewportCenterY,
      viewportHeight,
    ),
    1,
  );
  assert.equal(
    readSpatialDirectoryFocusOpacity(
      viewportCenterY +
        viewportHeight * SPATIAL_DIRECTORY_FOCUS_OUTER_RATIO,
      viewportCenterY,
      viewportHeight,
    ),
    0,
  );

  const distanceSamples = [0, 0.18, 0.24, 0.32, 0.4, 0.48, 0.6].map(
    (distance) =>
      readSpatialDirectoryFocusOpacity(
        viewportCenterY + viewportHeight * distance,
        viewportCenterY,
        viewportHeight,
      ),
  );
  for (const [index, opacity] of distanceSamples.entries()) {
    assert.ok(opacity >= 0 && opacity <= 1);
    assert.equal(
      opacity,
      readSpatialDirectoryFocusOpacity(
        viewportCenterY - viewportHeight * [0, 0.18, 0.24, 0.32, 0.4, 0.48, 0.6][
          index
        ],
        viewportCenterY,
        viewportHeight,
      ),
      "目录上下两侧必须使用对称渐隐",
    );
    if (index > 0) assert.ok(opacity <= distanceSamples[index - 1]);
  }

  // 相邻章节中心相隔一屏时，任意滚动位置最多只能有一个高强调目录。
  for (let progress = 0; progress <= 1; progress += 0.05) {
    const currentOpacity = readSpatialDirectoryFocusOpacity(
      viewportCenterY,
      viewportCenterY + viewportHeight * progress,
      viewportHeight,
    );
    const nextOpacity = readSpatialDirectoryFocusOpacity(
      viewportCenterY + viewportHeight,
      viewportCenterY + viewportHeight * progress,
      viewportHeight,
    );
    assert.ok(
      [currentOpacity, nextOpacity].filter((opacity) => opacity > 0.5).length <=
        1,
    );
  }
});

/** 目录吸附与文字渐隐只作用于桌面，窄屏和减少动态路径保持完整可读性。 */
test("anchors directory chapters over a right-side reading surface", async () => {
  const [avatarPage, bootstrap, scene, styles] = await Promise.all([
    readFile(new URL("../src/pages/avatar.astro", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/spatial-portrait.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-scene.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
  ]);

  assert.deepEqual(
    [
      ...avatarPage.matchAll(
        /data-spatial-chapter="(\d+)"\s+data-spatial-snap-anchor/g,
      ),
    ].map((match) => match[1]),
    ["1", "2", "3"],
  );
  assert.equal((avatarPage.match(/data-spatial-snap-anchor/g) ?? []).length, 3);
  assert.doesNotMatch(
    avatarPage,
    /data-spatial-chapter="0"[^>]*data-spatial-snap-anchor/,
  );
  assert.equal(
    (avatarPage.match(/data-spatial-directory-surface/g) ?? []).length,
    1,
    "三个目录章节必须共用唯一背景承载层",
  );
  const directorySurfaceMarkup = avatarPage.match(
    /<div class="spatial-directory-story" data-spatial-directory-surface>([\s\S]*?)\n\s*<\/div>\n\s*<\/div>\n\s*<\/main>/,
  )?.[1];
  assert.ok(directorySurfaceMarkup, "共享背景承载层必须完整包住目录章节");
  assert.doesNotMatch(
    directorySurfaceMarkup,
    /spatial-directory-focus-veil/,
    "目录容器不得再加入会产生横向色差的覆盖层",
  );
  assert.deepEqual(
    [...directorySurfaceMarkup.matchAll(/data-spatial-chapter="(\d+)"/g)].map(
      (match) => match[1],
    ),
    ["1", "2", "3"],
  );

  const directoryRule = styles.match(
    /\.spatial-chapter-directory\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(directoryRule, "目录章节必须保留独立样式规则");
  const directoryStoryRule = styles.match(
    /\.spatial-directory-story\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(directoryStoryRule, "目录章节必须保留共享背景容器");
  assert.match(directoryStoryRule, /position:\s*relative;/);
  assert.doesNotMatch(
    directoryStoryRule,
    /z-index:|isolation:|transform:|filter:|opacity:|overflow:/,
    "共享容器不能创建压住目录文字或破坏 sticky 的层叠与滚动环境",
  );
  const directorySurfaceRule = styles.match(
    /\.spatial-directory-story::before\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(directorySurfaceRule, "全部目录章节必须由唯一蒙版承载同一底色");
  assert.match(
    directorySurfaceRule,
    /position:\s*absolute;[\s\S]*?z-index:\s*1;[\s\S]*?inset:\s*0;[\s\S]*?content:\s*"";[\s\S]*?pointer-events:\s*none;/,
    "目录蒙版必须完整覆盖章节且保持在模型与文字下方",
  );
  assert.match(
    directorySurfaceRule,
    /background:\s*rgba\(239, 235, 225, 0\.82\)/,
  );
  assert.match(
    directorySurfaceRule,
    /(?:^|\n)\s*mask-image:[\s\S]*?linear-gradient\(\s*90deg,\s*transparent 0 43%,[\s\S]*?#000 61% 100%[\s\S]*?linear-gradient\(\s*180deg,\s*transparent 0%,[\s\S]*?rgba\(0, 0, 0, 0\.14\) 4svh,[\s\S]*?rgba\(0, 0, 0, 0\.5\) 10svh,[\s\S]*?#000 18svh calc\(100% - 18svh\),[\s\S]*?transparent 100%/,
    "桌面目录左缘与整组首尾必须柔和过渡，章节交界保持连续实色",
  );
  assert.match(directorySurfaceRule, /(?:^|\n)\s*-webkit-mask-image:/);
  assert.match(directorySurfaceRule, /mask-composite:\s*intersect;/);
  assert.match(directorySurfaceRule, /-webkit-mask-composite:\s*source-in;/);
  assert.doesNotMatch(
    directorySurfaceRule,
    /calc\(50% - 1px\)|rgba\(32, 33, 30, 0\.08\)|\bborder(?:-[a-z-]+)?:|outline|box-shadow/,
    "目录上缘与左缘不得再出现深色分割线、边框或内阴影",
  );
  assert.doesNotMatch(
    styles,
    /\.spatial-chapter-directory::before\s*\{/,
    "目录章节不得各自绘制背景，否则交界处会重复渐隐露底",
  );
  assert.doesNotMatch(
    styles,
    /\.spatial-directory-story::after\s*\{/,
    "About 与目录之间不得绘制会在首屏形成白色横带的独立覆盖层",
  );
  assert.doesNotMatch(
    styles,
    /\.spatial-directory-focus-veil/,
    "不得再用有颜色的 sticky 层覆盖目录背景",
  );
  const directoryCopyRule = styles.match(
    /\.spatial-chapter-directory \.spatial-copy\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(directoryCopyRule, "目录文字必须接入独立的中心焦点透明度");
  assert.match(
    directoryCopyRule,
    /opacity:\s*var\(--spatial-directory-copy-opacity, 1\);/,
  );
  assert.match(directoryCopyRule, /will-change:\s*opacity;/);
  assert.match(
    styles,
    /\.spatial-chapter-directory \.spatial-copy:focus-within\s*\{\s*opacity:\s*1;/,
    "键盘进入目录时必须完整显露焦点环",
  );
  assert.match(directoryRule, /scroll-snap-align:\s*center;/);
  assert.match(directoryRule, /scroll-snap-stop:\s*normal;/);
  assert.match(
    styles,
    /\.spatial-stage\s*\{[\s\S]*?z-index:\s*2;/,
    "模型舞台必须位于目录背景之上",
  );
  assert.match(
    styles,
    /\.spatial-copy\s*\{[\s\S]*?z-index:\s*3;/,
    "目录文字必须位于模型与背景之上",
  );
  assert.doesNotMatch(
    styles,
    /\.spatial-hero,\s*\.spatial-story\s*\{[^}]*z-index:/,
    "故事容器不能创建会把目录背景整体压到模型之上的层叠上下文",
  );
  assert.match(
    styles,
    /@media \(min-width: 801px\) and \(min-height: 601px\) and \(prefers-reduced-motion: no-preference\)\s*\{\s*html:has\(\.spatial-page\)\s*\{\s*scroll-snap-type:\s*y proximity;[\s\S]*?html:has\(\.spatial-page\.is-content-phase\)\s*\{\s*scroll-snap-type:\s*y mandatory;/,
    "桌面首屏必须保留渐进滚动，进入目录后再自动定位到最近章节",
  );
  assert.match(
    styles,
    /@media \(max-height: 600px\)[\s\S]*?\.spatial-chapter-directory \.spatial-copy\s*\{\s*opacity:\s*1;[\s\S]*?will-change:\s*auto;[\s\S]*?@media \(min-width: 801px\) and \(max-height: 600px\) and \(prefers-reduced-motion: no-preference\)\s*\{\s*html:has\(\.spatial-page\)\s*\{\s*scroll-snap-type:\s*none;/,
    "横屏短视口必须关闭文字渐隐与自动吸附",
  );
  assert.match(
    styles,
    /@media \(max-width: 800px\)[\s\S]*?\.spatial-directory-story::before\s*\{\s*content:\s*none;[\s\S]*?\.spatial-chapter-directory \.spatial-copy\s*\{\s*opacity:\s*1;[\s\S]*?will-change:\s*auto;/,
    "窄屏不得叠加桌面右半屏背景或滚动渐隐",
  );
  assert.match(
    styles,
    /@media \(max-width: 800px\) and \(prefers-reduced-motion: no-preference\)\s*\{\s*html:has\(\.spatial-page\)\s*\{\s*scroll-snap-type:\s*y proximity;/,
    "窄屏目录必须保留不会困住长内容的轻量吸附",
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?scroll-snap-type:\s*none;[\s\S]*?\.spatial-chapter-directory \.spatial-copy\s*\{\s*opacity:\s*1;[\s\S]*?will-change:\s*auto;[\s\S]*?\.spatial-copy-intro,[\s\S]*?\.spatial-scroll-cue\s*\{\s*opacity:\s*1;/,
    "减少动态时必须关闭吸附和全部滚动渐隐",
  );

  for (const property of [
    "--spatial-about-opacity",
    "--spatial-cue-opacity",
    "--spatial-directory-copy-opacity",
  ]) {
    assert.match(
      bootstrap,
      new RegExp(`style\\.setProperty\\(\\s*"${property}"`),
    );
    assert.match(
      bootstrap,
      new RegExp(`style\\.removeProperty\\(\\s*"${property}"\\s*\\)`),
    );
  }
  assert.match(bootstrap, /readSpatialAvatarTransitionProgress/);
  assert.match(bootstrap, /readSpatialAvatarIntroPresentation/);
  assert.match(scene, /readSpatialAvatarTransitionProgress/);
});

/** 空间肖像必须把固定浅色摄影棚延伸到文档根层，避免深色系统下露底或闪黑。 */
test("keeps the light studio background across every document layer", async () => {
  const [styles, globalStyles] = await Promise.all([
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/global.css", import.meta.url), "utf8"),
  ]);

  const spatialRootRule = styles.match(
    /:root:has\(\.spatial-page\)\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(spatialRootRule, "空间肖像必须在文档根层声明独立主题");
  assert.match(spatialRootRule, /color-scheme:\s*light;/);
  assert.match(
    spatialRootRule,
    /--spatial-stage-background:\s*#e8e5db;/,
  );
  assert.match(
    spatialRootRule,
    /--page-background:\s*var\(--spatial-stage-background\);/,
  );
  assert.match(
    styles,
    /\.spatial-page\s*\{[^}]*background:\s*var\(--spatial-stage-background\);/s,
  );
  assert.match(
    globalStyles,
    /html\s*\{[^}]*background:\s*var\(--page-background\);/s,
  );
  assert.match(
    globalStyles,
    /body\s*\{[^}]*background:\s*var\(--page-background\);/s,
  );
});

/** 肖像灯光必须显著抬亮正面，并以中性环境反射补足 PBR 材质层次。 */
test("builds a bright and balanced portrait light rig", () => {
  const lightRig = createPortraitLightRig();
  const lights = [];
  lightRig.traverse((object) => {
    if (object instanceof THREE.Light) lights.push(object);
  });
  const lightsByName = new Map(lights.map((light) => [light.name, light]));
  const hemisphere = lightsByName.get("PortraitHemisphereLight");
  const keyLight = lightsByName.get("PortraitKeyLight");
  const fillLight = lightsByName.get("PortraitFillLight");
  const rimLight = lightsByName.get("PortraitRimLight");

  assert.ok(
    PORTRAIT_TONE_MAPPING_EXPOSURE >= 0.85 &&
      PORTRAIT_TONE_MAPPING_EXPOSURE <= 1,
  );
  assert.ok(
    PORTRAIT_ENVIRONMENT_INTENSITY >= 0.3 &&
      PORTRAIT_ENVIRONMENT_INTENSITY <= 0.55,
  );
  assert.equal(lightRig.name, "PortraitLightRig");
  assert.equal(lights.length, 4);
  assert.ok(hemisphere instanceof THREE.HemisphereLight);
  assert.ok(keyLight instanceof THREE.DirectionalLight);
  assert.ok(fillLight instanceof THREE.DirectionalLight);
  assert.ok(rimLight instanceof THREE.DirectionalLight);
  assert.equal(
    lights.filter((light) => light instanceof THREE.DirectionalLight).length,
    3,
  );
  assert.ok(keyLight.intensity > hemisphere.intensity);
  assert.ok(hemisphere.intensity > fillLight.intensity);
  assert.ok(fillLight.intensity > rimLight.intensity);
  assert.equal(rimLight.color.getHex(), 0xf7f3eb);
  assert.equal(rimLight.intensity, 0.78);
  assert.ok(keyLight.position.z > 0);
  assert.ok(fillLight.position.z > 0);
  assert.ok(rimLight.position.z < 0);
  for (const light of [keyLight, fillLight, rimLight]) {
    assert.ok(light.position.toArray().every(Number.isFinite));
    assert.equal(light.castShadow, false);
  }
});

/** 生产目光函数必须保留模型本地轴、方向、限幅与初始姿态叠加。 */
test("maps the pointer onto the rig axes and projected eye center", () => {
  const base = new THREE.Quaternion(0.5, 0.5, -0.5, 0.5);
  const target = new THREE.Quaternion();
  const yaw = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, -1),
    MAX_EYE_YAW,
  );
  const pitch = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    MAX_EYE_PITCH,
  );

  assert.equal(MAX_EYE_YAW, THREE.MathUtils.degToRad(25));
  assert.equal(MAX_EYE_PITCH, THREE.MathUtils.degToRad(15));
  assert.equal(POINTER_GAZE_RADIUS_X_RATIO, 0.5);
  assert.equal(POINTER_GAZE_RADIUS_Y_RATIO, 0.52);
  assert.ok(
    MAX_EYE_YAW / POINTER_GAZE_RADIUS_X_RATIO >
      (THREE.MathUtils.degToRad(22) / 0.56) * 1.2,
    "相同水平指针位移下的目光活动必须至少增加 20%",
  );
  assert.ok(
    MAX_EYE_PITCH / POINTER_GAZE_RADIUS_Y_RATIO >
      (THREE.MathUtils.degToRad(13) / 0.56) * 1.2,
    "相同垂直指针位移下的目光活动必须至少增加 20%",
  );

  assert.equal(setEyeTargetQuaternion(base, target, 1, 0), target);
  assert.ok(target.angleTo(base.clone().multiply(yaw)) < 1e-7);
  setEyeTargetQuaternion(base, target, 0, 1);
  assert.ok(target.angleTo(base.clone().multiply(pitch)) < 1e-7);
  setEyeTargetQuaternion(base, target, 1, 1);
  const expectedCombined = base.clone().multiply(yaw.clone().multiply(pitch));
  const reversedCombined = base.clone().multiply(pitch.clone().multiply(yaw));
  assert.ok(target.angleTo(expectedCombined) < 1e-7);
  assert.ok(target.angleTo(reversedCombined) > 1e-4, "yaw 必须先于 pitch 组合");

  setEyeTargetQuaternion(base, target, -1, 0);
  assert.ok(
    target.angleTo(base.clone().multiply(yaw.clone().invert())) < 1e-7,
    "向左必须与向右保持对称极限",
  );
  setEyeTargetQuaternion(base, target, 0, -1);
  assert.ok(
    target.angleTo(base.clone().multiply(pitch.clone().invert())) < 1e-7,
    "向上必须与向下保持对称极限",
  );

  const displayRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    -Math.PI / 2,
  );
  const eyeForward = new THREE.Vector3(0, 1, 0);
  const centerDirection = eyeForward
    .clone()
    .applyQuaternion(base)
    .applyQuaternion(displayRotation);
  setEyeTargetQuaternion(base, target, 1, 0);
  const rightDirection = eyeForward
    .clone()
    .applyQuaternion(target)
    .applyQuaternion(displayRotation);
  setEyeTargetQuaternion(base, target, 0, 1);
  const downDirection = eyeForward
    .clone()
    .applyQuaternion(target)
    .applyQuaternion(displayRotation);
  assert.ok(
    rightDirection.x > centerDirection.x,
    "指针向右必须映射到画面右侧",
  );
  assert.ok(
    downDirection.y < centerDirection.y,
    "指针向下必须映射到画面下方",
  );
  assert.ok(rightDirection.z > 0.9 && downDirection.z > 0.9);

  const region = { centerX: 900, centerY: 250, radiusX: 300, radiusY: 200 };
  assert.deepEqual(mapPointerToGaze(900, 250, region), { x: 0, y: 0 });
  assert.deepEqual(mapPointerToGaze(1_050, 150, region), { x: 0.5, y: -0.5 });
  assert.deepEqual(mapPointerToGaze(100, 900, region), { x: -1, y: 1 });
  assert.deepEqual(
    mapPointerToGaze(1_050, 150, { ...region, centerX: 750 }),
    { x: 1, y: -0.5 },
    "肖像换位后必须用同一指针屏幕坐标重新映射目光",
  );
});

/** 首页只为会运行三维场景且网络允许的访问预热模型缓存。 */
test("guards spatial avatar prefetch for motion and constrained networks", () => {
  assert.equal(
    shouldPrefetchSpatialAvatar({
      effectiveType: "4g",
      reducedMotion: false,
      saveData: false,
    }),
    true,
  );
  assert.equal(
    shouldPrefetchSpatialAvatar({
      effectiveType: undefined,
      reducedMotion: false,
      saveData: false,
    }),
    true,
    "未知网况仍允许明确的 hover、focus 或 touch 意图触发",
  );
  for (const conditions of [
    { effectiveType: "4g", reducedMotion: true, saveData: false },
    { effectiveType: "4g", reducedMotion: false, saveData: true },
    { effectiveType: "slow-2g", reducedMotion: false, saveData: false },
    { effectiveType: "2g", reducedMotion: false, saveData: false },
  ]) {
    assert.equal(shouldPrefetchSpatialAvatar(conditions), false);
  }
  assert.equal(
    shouldIdlePrefetchSpatialAvatar({
      effectiveType: "4g",
      reducedMotion: false,
      saveData: false,
    }),
    true,
  );
  for (const effectiveType of [undefined, "3g", "2g", "slow-2g"]) {
    assert.equal(
      shouldIdlePrefetchSpatialAvatar({
        effectiveType,
        reducedMotion: false,
        saveData: false,
      }),
      false,
    );
  }
});

/** 空间形象页只展示三组内容链接，二级分类标题保留语义但不参与视觉层级。 */
test("adapts the shared directory component to the spatial reading column", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../src/pages/avatar.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /import DirectoryColumn from "\.\.\/components\/DirectoryColumn\.astro"/);
  assert.equal((page.match(/<DirectoryColumn/g) ?? []).length, 3);
  assert.equal((page.match(/headingLevel="h3"/g) ?? []).length, 3);
  assert.match(page, /class="spatial-directory-groups" aria-label="职业经历目录"/);
  assert.match(page, /class="spatial-directory-groups" aria-label="个人作品目录"/);
  assert.match(page, /class="spatial-directory-groups" aria-label="文稿目录"/);
  assert.match(page, /<h2 id="spatial-works-title">个人作品<\/h2>/);
  assert.match(page, /<h2 id="spatial-post-title">Post<\/h2>/);
  assert.doesNotMatch(page, /CATEGORY_DEFINITIONS\.journal|journalEntries/);
  assert.doesNotMatch(page, /spatial-copy-wide|spatial-directory-groups-multiple/);
  assert.doesNotMatch(page, /class="spatial-links"/);

  const directoryRule = styles.match(
    /\.spatial-directory-groups\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(directoryRule);
  assert.match(directoryRule, /--line:\s*var\(--spatial-line\)/);
  assert.match(directoryRule, /--text-muted:\s*var\(--spatial-muted\)/);
  const hiddenHeadingRule = styles.match(
    /\.spatial-directory-groups \.column-heading\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(hiddenHeadingRule, "头像页必须只在视觉上隐藏二级分类标题");
  for (const declaration of [
    /position:\s*absolute;/,
    /width:\s*1px;/,
    /height:\s*1px;/,
    /margin:\s*-1px;/,
    /overflow:\s*hidden;/,
    /clip:\s*rect\(0, 0, 0, 0\);/,
    /clip-path:\s*inset\(50%\);/,
    /white-space:\s*nowrap;/,
  ]) {
    assert.match(hiddenHeadingRule, declaration);
  }
  assert.doesNotMatch(hiddenHeadingRule, /display:\s*none|visibility:\s*hidden/);
  assert.doesNotMatch(styles, /\.spatial-directory-groups-multiple|\.spatial-copy-wide/);
  assert.match(styles, /\.spatial-directory-groups \.directory-links\s*\{[^}]*grid-template-rows:\s*repeat\(5, minmax\(2\.25rem, auto\)\);/s);
  assert.match(styles, /\.spatial-directory-groups \.directory-links a::after\s*\{\s*content:\s*none;/);
  assert.doesNotMatch(styles, /\.spatial-links/);
});

/** 无 WebGL2 时必须在场景包和完整模型请求之前终止动态路径。 */
test("detects WebGL2 support before loading the avatar model", () => {
  let contextReleased = false;
  assert.equal(
    supportsSpatialAvatarWebGL(() => ({
      getContext: () => ({
        getExtension: () => ({
          loseContext: () => {
            contextReleased = true;
          },
        }),
      }),
    })),
    true,
  );
  assert.equal(contextReleased, true);
  assert.equal(
    supportsSpatialAvatarWebGL(() => ({
      getContext: () => null,
    })),
    false,
  );
  assert.equal(
    supportsSpatialAvatarWebGL(() => {
      throw new Error("WebGL 被浏览器禁用");
    }),
    false,
  );
});

/** 热缓存必须直接复用同一响应，避免为了判定海报又读取一次模型。 */
test("reuses cached avatar bytes without a network request", async () => {
  const cachedBytes = Uint8Array.from([1, 2, 3, 4]).buffer;
  const calls = [];
  const request = async (url, options) => {
    calls.push({ options, url });
    return new Response(cachedBytes, { status: 200 });
  };

  const modelLoad = await prepareSpatialAvatarModelLoad(
    undefined,
    request,
    20,
  );

  assert.equal(modelLoad.source, "http-cache");
  assert.deepEqual(
    [...new Uint8Array(await modelLoad.bytes)],
    [1, 2, 3, 4],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, spatialAvatarAssets.model);
  assert.equal(calls[0].options.cache, "only-if-cached");
  assert.equal(calls[0].options.mode, "same-origin");
  assert.equal(calls[0].options.credentials, "same-origin");
});

/** 缓存 miss 必须立即启动唯一一次普通请求，并把结果交给后续解析。 */
test("falls back to one normal avatar request after a cache miss", async () => {
  const networkBytes = Uint8Array.from([5, 6, 7]).buffer;
  const calls = [];
  const request = async (url, options) => {
    calls.push({ options, url });
    if (options.cache === "only-if-cached") {
      return new Response(null, { status: 504 });
    }
    return new Response(networkBytes, { status: 200 });
  };

  const modelLoad = await prepareSpatialAvatarModelLoad(
    undefined,
    request,
    20,
  );

  assert.equal(modelLoad.source, "network");
  assert.deepEqual([...new Uint8Array(await modelLoad.bytes)], [5, 6, 7]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cache, "only-if-cached");
  assert.equal(calls[1].options.cache, undefined);
  assert.equal(calls[1].options.credentials, "same-origin");
});

/** 正在进行的预取不得让缓存探测无限等待；超时后海报必须能进入冷加载态。 */
test("bounds an in-flight avatar cache probe before normal loading", async () => {
  const networkBytes = Uint8Array.from([8, 9]).buffer;
  const calls = [];
  const request = (url, options) => {
    calls.push({ options, url });
    if (options.cache !== "only-if-cached") {
      return Promise.resolve(new Response(networkBytes, { status: 200 }));
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });
  };

  const startedAt = performance.now();
  const modelLoad = await prepareSpatialAvatarModelLoad(
    undefined,
    request,
    8,
  );

  assert.equal(modelLoad.source, "network");
  assert.ok(performance.now() - startedAt < 200);
  assert.deepEqual([...new Uint8Array(await modelLoad.bytes)], [8, 9]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
});

/** 背景光尺度只响应相机纵深，人物左右换位不得被误判为远离镜头。 */
test("measures portrait scale from camera depth instead of lateral travel", () => {
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 20);
  camera.position.set(0, 0.03, 3.8);
  camera.lookAt(0, 0.02, 0);
  camera.updateMatrixWorld(true);

  const centerScale = readPortraitDepthScale(
    camera,
    new THREE.Vector3(0, 0, 0),
  );
  const sideScale = readPortraitDepthScale(
    camera,
    new THREE.Vector3(0.68, 0, 0),
  );
  const nearScale = readPortraitDepthScale(
    camera,
    new THREE.Vector3(0, 0, 0.8),
  );

  assert.ok(Math.abs(centerScale - sideScale) < 1e-12);
  assert.ok(nearScale > centerScale);
});

/** 静态降级必须先请求并成功加载阅读态海报，失败时清理本次请求以允许后续重试。 */
test("gates the retryable static poster fallback on image readiness", async () => {
  const [bootstrap, scene, styles] = await Promise.all([
    readFile(
      new URL("../src/lib/spatial-portrait.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-scene.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
  ]);

  assert.match(scene, /onStaticPosterRequested: \(\) => void/);
  assert.match(
    scene,
    /"webglcontextlost"[\s\S]*?root\.classList\.add\("is-webgl-unavailable"\);[\s\S]*?callbacks\.onStaticPosterRequested\(\);/,
    "WebGL 上下文丢失后必须明确请求静态海报",
  );
  assert.match(
    bootstrap,
    /onStaticPosterRequested:\s*\(\): void => \{\s*void ensureStaticPoster\(\);\s*\}/,
    "场景请求必须接入统一的静态海报加载入口",
  );

  assert.match(
    bootstrap,
    /const ensureStaticPoster = \(\): Promise<boolean> =>\s*loadStaticPoster\(\)\.then\(\(loaded\) => \{\s*if \(isDisposed\) return false;\s*root\.classList\.toggle\("is-static-poster-ready", loaded\);\s*return loaded;/,
    "只有图片加载 Promise 成功结算后才允许写入就绪状态",
  );
  assert.match(
    bootstrap,
    /void ensureStaticPoster\(\)\.then\(\(loaded\) => \{\s*if \(!loaded \|\| isDisposed \|\| version !== loadVersion\) return;\s*root\.classList\.remove\(\.\.\.MODEL_LOADING_CLASSES\);\s*root\.classList\.add\(rootClass\);/,
    "失败、已释放或过期的加载结果都不得激活静态降级 class",
  );
  assert.doesNotMatch(
    bootstrap,
    /classList\.add\("is-static-poster-ready"\)/,
    "就绪 class 不得在异步加载完成前直接写入",
  );
  assert.equal(
    (
      bootstrap.match(
        /classList\.(?:add|toggle)\("is-static-poster-ready"/g,
      ) ?? []
    ).length,
    1,
    "静态海报就绪状态必须只有加载结果这一处写入口",
  );

  assert.match(
    bootstrap,
    /if \(staticPosterLoad\) return staticPosterLoad;/,
    "同一次图片加载期间必须复用请求",
  );
  assert.match(
    bootstrap,
    /if \(staticPosterImage\.complete\) \{\s*const loaded = staticPosterImage\.naturalWidth > 0;\s*if \(!loaded\) \{\s*staticPosterSource\.removeAttribute\("srcset"\);\s*staticPosterImage\.removeAttribute\("src"\);\s*\}\s*return Promise\.resolve\(loaded\);/,
    "浏览器缓存中的失败图片也必须清理资源属性",
  );
  assert.match(
    bootstrap,
    /staticPosterLoad = loadAttempt\.then\(\(loaded\) => \{\s*if \(!loaded\) \{\s*staticPosterLoad = null;\s*staticPosterSource\.removeAttribute\("srcset"\);\s*staticPosterImage\.removeAttribute\("src"\);\s*\}\s*return loaded;/,
    "异步失败必须清空 Promise 与资源属性，让后续调用重新发起加载",
  );
  assert.match(bootstrap, /const handleError = \(\): void => finish\(false\)/);
  assert.match(bootstrap, /root\.classList\.remove\("is-static-poster-ready"\)/);

  assert.match(
    styles,
    /\.spatial-portrait\.is-static \.spatial-portrait-loading-poster,\s*\.spatial-portrait\.is-webgl-unavailable \.spatial-portrait-loading-poster\s*\{\s*opacity:\s*1;/,
    "海报未就绪时必须继续展示可用的首屏近景",
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-static \.spatial-portrait-static-poster,\s*\.spatial-portrait\.is-webgl-unavailable \.spatial-portrait-static-poster\s*\{\s*opacity:\s*0;/,
    "海报未就绪时不得提前露出空白阅读态图片",
  );
  assert.match(
    styles,
    /\.spatial-page\.is-content-phase\s+\.spatial-portrait\.is-static-poster-ready:not\(\.is-webgl-ready\):not\(\s*\.is-cache-probing\s*\):not\(\.is-model-cache-warm\):not\(\.is-model-bytes-ready\)\s+\.spatial-portrait-loading-poster\s*\{\s*opacity:\s*0;/,
    "内容阶段只有冷加载或真实降级时才能隐藏首屏近景",
  );
  assert.match(
    styles,
    /\.spatial-page\.is-content-phase\s+\.spatial-portrait\.is-static-poster-ready:not\(\.is-webgl-ready\):not\(\s*\.is-cache-probing\s*\):not\(\.is-model-cache-warm\):not\(\.is-model-bytes-ready\)\s+\.spatial-portrait-static-poster\s*\{\s*opacity:\s*1;/,
    "阅读态海报不得覆盖热缓存探测或模型解析阶段",
  );
  assert.doesNotMatch(
    styles,
    /\.spatial-page\.is-content-phase\s+\.spatial-portrait-(?:loading|static)-poster\s*\{/,
    "内容阶段本身不得绕过 readiness gating 直接切图",
  );
});

/** 模型加载与 WebGL 恢复无论谁先完成，都必须经同一守卫入口呈现场景。 */
test("presents the scene once after both model and WebGL are ready", async () => {
  assert.equal(
    canPresentSpatialAvatarScene(false, false),
    false,
    "上下文先恢复而模型未完成时不得呈现场景",
  );
  assert.equal(
    canPresentSpatialAvatarScene(false, true),
    false,
    "模型未完成且上下文丢失时不得呈现场景",
  );
  assert.equal(
    canPresentSpatialAvatarScene(true, true),
    false,
    "模型先完成而上下文仍丢失时不得呈现场景",
  );
  assert.equal(
    canPresentSpatialAvatarScene(true, false),
    true,
    "只有模型完成且上下文可用时才允许呈现场景",
  );

  const [bootstrap, scene] = await Promise.all([
    readFile(
      new URL("../src/lib/spatial-portrait.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-scene.ts", import.meta.url),
      "utf8",
    ),
  ]);
  const presentationMatch = scene.match(
    /const presentSceneIfReady = \(\): boolean => \{([\s\S]*?)\n  \};/,
  );
  assert.ok(presentationMatch, "场景必须提供统一的幂等呈现入口");
  const presentationBody = presentationMatch[1];

  assert.match(
    presentationBody,
    /if \(\s*isDisposed \|\|\s*!canPresentSpatialAvatarScene\(sceneReady, isContextLost\)\s*\) \{\s*return false;\s*\}/,
    "统一呈现入口必须使用已验证的模型与上下文联合守卫",
  );
  assert.match(
    presentationBody,
    /renderer\.render\(scene, camera\);\s*if \(!isScenePresented\) \{\s*isScenePresented = true;\s*callbacks\.onReady\(\);\s*\}\s*requestRender\(\);\s*return true;/,
    "只有成功渲染后才能幂等通知场景已就绪",
  );
  assert.equal(
    (scene.match(/callbacks\.onReady\(\)/g) ?? []).length,
    1,
    "onReady 只能由统一呈现入口调用",
  );
  assert.doesNotMatch(
    scene,
    /root\.classList\.add\("is-webgl-ready"\)/,
    "场景内部不得绕过 onReady 回调直接标记画布可见",
  );
  assert.equal(
    (bootstrap.match(/root\.classList\.add\("is-webgl-ready"\)/g) ?? [])
      .length,
    1,
    "外层 ready class 也必须只有 onReady 回调这一处写入口",
  );
  assert.match(
    bootstrap,
    /onReady:\s*\(\): void => \{[\s\S]*?root\.classList\.add\("is-webgl-ready"\);/,
  );

  assert.match(
    scene,
    /"webglcontextlost",\s*\(event\) => \{\s*event\.preventDefault\(\);\s*isContextLost = true;\s*isScenePresented = false;/,
    "上下文丢失必须撤销本轮已呈现状态，恢复后才能重新通知 ready",
  );
  assert.match(
    scene,
    /"webglcontextrestored",\s*\(\) => \{[\s\S]*?isContextLost = false;[\s\S]*?scene\.environment = environmentRenderTarget\.texture;\s*resize\(\);\s*presentSceneIfReady\(\);/,
    "上下文先恢复时必须通过统一入口等待尚未完成的模型",
  );
  assert.match(
    scene,
    /sceneReady = true;\s*presentSceneIfReady\(\);/,
    "模型先完成时必须通过统一入口等待尚未恢复的上下文",
  );
  assert.equal(
    (scene.match(/presentSceneIfReady\(\);/g) ?? []).length,
    2,
    "只有模型完成和上下文恢复两条路径可以请求呈现场景",
  );
  assert.equal(
    (scene.match(/isScenePresented = false/g) ?? []).length,
    2,
    "已呈现状态只能在初始化和上下文丢失时清空",
  );
});

/** 空间肖像必须保留同模型海报、动态按需加载和完整资源释放路径。 */
test("keeps the isolated GLB portrait progressive and accessible", async () => {
  const [
    component,
    bootstrap,
    scene,
    modelLoader,
    prefetch,
    homePage,
    avatarPage,
    styles,
    globalStyles,
    heroStyles,
    loadingPoster,
    loadingMobilePoster,
    poster,
    mobilePoster,
    builtHome,
    builtAvatar,
  ] = await Promise.all([
    readFile(
      new URL("../src/components/SpatialPortrait.astro", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-portrait.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-scene.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-model.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/spatial-avatar-prefetch.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/pages/avatar.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/global.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/hero.css", import.meta.url), "utf8"),
    readFile(loadingPosterUrl),
    readFile(loadingMobilePosterUrl),
    readFile(posterUrl),
    readFile(mobilePosterUrl),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/avatar/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(
    component,
    /class="spatial-portrait-fallback spatial-portrait-loading-poster"/,
  );
  assert.match(component, /class="spatial-portrait is-cache-probing"/);
  assert.match(component, /data-spatial-loading-poster/);
  assert.match(component, /srcset=\{spatialAvatarAssets\.loadingPosterMobile\}/);
  assert.match(component, /src=\{spatialAvatarAssets\.loadingPoster\}/);
  assert.match(
    component,
    /class="spatial-portrait-fallback spatial-portrait-static-poster"/,
  );
  assert.match(component, /data-spatial-static-poster/);
  assert.match(
    component,
    /data-srcset=\{spatialAvatarAssets\.staticPosterMobile\}/,
  );
  assert.match(component, /data-src=\{spatialAvatarAssets\.staticPoster\}/);
  assert.match(component, /data-spatial-static-source/);
  assert.match(component, /data-spatial-static-image/);
  assert.match(
    component,
    /<noscript>[\s\S]*<picture class="spatial-portrait-noscript-poster">/,
  );
  assert.match(
    component,
    /<noscript>[\s\S]*srcset=\{spatialAvatarAssets\.staticPosterMobile\}/,
    "无脚本移动端必须使用独立竖版海报",
  );
  assert.match(
    component,
    /<noscript>[\s\S]*src=\{spatialAvatarAssets\.staticPoster\}/,
    "无脚本桌面端必须使用独立横版海报",
  );
  assert.equal((component.match(/loading="eager"/g) ?? []).length, 1);
  assert.match(component, /data-spatial-static-poster[\s\S]*aria-hidden="true"/);
  assert.match(component, /alt=\{`\$\{name\} 的三维人物模型/);
  assert.match(
    component,
    /<canvas[^>]*aria-hidden="true"[^>]*data-spatial-canvas/,
  );
  assert.match(component, /role="status" aria-live="polite"/);
  assert.doesNotMatch(component, /滚动叙事|移动指针控制目光/);

  assert.doesNotMatch(builtHome, /data-spatial-portrait|\/3d\/wenren-avatar-/);
  assert.match(builtHome, /data-avatar-link/);
  assert.match(builtHome, /data-astro-prefetch="hover"/);
  assert.match(builtAvatar, /data-spatial-portrait/);
  assert.equal(
    (builtAvatar.match(/<picture class="spatial-portrait-fallback/g) ?? [])
      .length,
    2,
    "构建产物必须分别保留加载海报与静态降级海报",
  );
  assert.match(
    builtAvatar,
    /<picture class="spatial-portrait-fallback spatial-portrait-loading-poster" data-spatial-loading-poster>/,
  );
  assert.match(
    builtAvatar,
    /<picture class="spatial-portrait-fallback spatial-portrait-static-poster" data-spatial-static-poster aria-hidden="true">/,
  );
  assert.match(
    builtAvatar,
    /data-src="\/3d\/wenren-avatar-poster-8a79a7b0a61d\.jpg"/,
  );
  assert.match(
    builtAvatar,
    /data-srcset="\/3d\/wenren-avatar-poster-mobile-49a408e5118b\.jpg"/,
  );
  assert.equal((builtAvatar.match(/\sloading="eager"/g) ?? []).length, 1);
  for (const assetPath of [
    spatialAvatarAssets.loadingPoster,
    spatialAvatarAssets.loadingPosterMobile,
    spatialAvatarAssets.staticPoster,
    spatialAvatarAssets.staticPosterMobile,
  ]) {
    assert.ok(builtAvatar.includes(assetPath));
  }
  assert.doesNotMatch(
    builtAvatar,
    /<link rel="preload" href="\/3d\/wenren-avatar-617f0102b1df\.glb"/,
  );
  assert.doesNotMatch(builtAvatar, /滚动叙事|移动指针控制目光/);
  assert.match(
    builtAvatar,
    /<a class="spatial-home-link" href="\/">首页<span class="spatial-home-link-arrow" aria-hidden="true">→<\/span><\/a>/,
  );
  assert.match(
    builtAvatar,
    /<script type="module" src="\/_astro\/[^"]+\.js"><\/script>/,
  );
  assert.deepEqual(
    [...builtAvatar.matchAll(/data-spatial-chapter="(\d+)"/g)].map(
      (match) => match[1],
    ),
    ["0", "1", "2", "3"],
    "默认首屏 About 与三个目录章节必须共同组成四章",
  );
  const builtHeroOpening = builtAvatar.match(
    /<section class="spatial-hero spatial-chapter spatial-chapter-intro" data-spatial-hero data-spatial-chapter="0" aria-labelledby="spatial-about-title">/,
  )?.[0];
  assert.ok(builtHeroOpening, "构建产物必须把 About 合入唯一默认首屏");
  assert.doesNotMatch(builtHeroOpening, /aria-hidden/);
  assert.match(
    builtAvatar,
    /<div class="spatial-story" aria-label="Alice 个人介绍与目录"><section class="spatial-hero spatial-chapter spatial-chapter-intro"/,
    "About 与后三章必须属于同一组连续内容",
  );
  assert.match(
    builtAvatar,
    /<h1 id="spatial-about-title">About Alice<\/h1>/,
  );
  assert.match(
    builtAvatar,
    /<p class="spatial-scroll-cue" aria-hidden="true">/,
  );
  assert.equal((builtAvatar.match(/01 \/ ABOUT/g) ?? []).length, 1);
  assert.equal((builtAvatar.match(/About Alice/g) ?? []).length, 1);
  assert.doesNotMatch(builtAvatar, /spatial-hero-marker/);
  assert.ok(
    builtAvatar.indexOf("data-spatial-hero") <
      builtAvatar.indexOf('data-spatial-chapter="1"'),
    "默认首屏之后必须直接进入 Résumé",
  );
  assert.deepEqual(
    [
      ...builtAvatar.matchAll(
        /<section class="spatial-chapter spatial-chapter-directory" data-spatial-chapter="(\d+)"/g,
      ),
    ].map((match) => match[1]),
    ["1", "2", "3"],
    "只有 Résumé、Independent 与 Notes 可以进入右栏",
  );

  assert.equal((avatarPage.match(/data-spatial-hero/g) ?? []).length, 1);
  assert.deepEqual(
    [...avatarPage.matchAll(/data-spatial-chapter="(\d+)"/g)].map(
      (match) => match[1],
    ),
    ["0", "1", "2", "3"],
  );
  assert.match(
    avatarPage,
    /class="spatial-hero spatial-chapter spatial-chapter-intro"\s+data-spatial-hero\s+data-spatial-chapter="0"\s+aria-labelledby="spatial-about-title"/,
  );
  assert.match(
    avatarPage,
    /<div class="spatial-story" aria-label=\{`\$\{siteConfig\.brand\.name\} 个人介绍与目录`\}>/,
  );
  assert.match(
    avatarPage,
    /<h1 id="spatial-about-title">About \{siteConfig\.brand\.name\}<\/h1>/,
  );
  assert.match(
    avatarPage,
    /<p class="spatial-scroll-cue" aria-hidden="true">/,
  );
  assert.equal((avatarPage.match(/01 \/ ABOUT/g) ?? []).length, 1);
  assert.equal(
    (avatarPage.match(/About \{siteConfig\.brand\.name\}/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    avatarPage,
    /spatial-hero-marker|aria-hidden="true"[^>]*data-spatial-hero/,
  );
  assert.ok(
    avatarPage.indexOf("data-spatial-hero") <
      avatarPage.indexOf('data-spatial-chapter="1"'),
  );
  assert.deepEqual(
    [
      ...avatarPage.matchAll(
        /<section\s+class="spatial-chapter spatial-chapter-directory"\s+data-spatial-chapter="(\d+)"/g,
      ),
    ].map((match) => match[1]),
    ["1", "2", "3"],
  );

  assert.match(bootstrap, /prefers-reduced-motion: reduce/);
  assert.match(bootstrap, /import\("\.\/spatial-avatar-scene"\)/);
  assert.doesNotMatch(
    bootstrap,
    /^import .*from "three"|^import .*GLTFLoader/m,
  );
  assert.match(bootstrap, /motionPreference\.addEventListener\("change"/);
  assert.match(bootstrap, /sceneCleanup\?\.\(\)/);
  assert.match(bootstrap, /page\.classList\.add\("is-spatial-static"\)/);
  assert.match(bootstrap, /page\.classList\.remove\("is-spatial-static"\)/);
  assert.match(bootstrap, /getContext\("webgl2"/);
  assert.match(bootstrap, /WEBGL_lose_context/);
  assert.match(bootstrap, /prepareSpatialAvatarModelLoad/);
  assert.match(bootstrap, /is-cache-probing/);
  assert.match(bootstrap, /is-loading-poster-visible/);
  assert.match(bootstrap, /is-model-cache-warm/);
  assert.match(bootstrap, /is-model-bytes-ready/);
  assert.match(bootstrap, /modelBytes: modelLoad\.bytes/);
  assert.match(bootstrap, /onModelBytesReady/);
  assert.match(bootstrap, /loadStaticPoster\(\)\.then/);
  assert.match(bootstrap, /staticPosterSource\.srcset/);
  assert.match(bootstrap, /staticPosterImage\.src/);
  assert.match(bootstrap, /data-spatial-hero/);
  assert.match(bootstrap, /SPATIAL_AVATAR_READING_PHASE_RATIO/);
  assert.match(
    bootstrap,
    /is-content-phase/,
    "静态与 WebGL 降级路径必须共享首屏到内容阶段的切换状态",
  );

  assert.match(homePage, /data-astro-prefetch="hover"/);
  assert.match(homePage, /initSpatialAvatarPrefetch\(avatarLink\)/);
  assert.match(prefetch, /requestIdleCallback\(trigger, \{ timeout: 1_500 \}\)/);
  assert.match(prefetch, /"pointerenter"/);
  assert.match(prefetch, /"focus"/);
  assert.match(prefetch, /"touchstart"/);
  assert.match(prefetch, /connection\?\.saveData === true/);
  assert.match(prefetch, /prefers-reduced-motion: reduce/);
  assert.match(prefetch, /hint\.rel = "prefetch"/);
  assert.match(prefetch, /hint\.as = "fetch"/);
  assert.match(prefetch, /loadSpatialAvatarModelBytes\(\)\.catch/);
  assert.match(prefetch, /shouldIdlePrefetchSpatialAvatar\(conditions\)/);
  assert.match(prefetch, /conditions\.effectiveType === "4g"/);
  assert.doesNotMatch(prefetch, /from "three"|WebGLRenderer|GLTFLoader/);

  assert.equal(
    spatialAvatarAssets.model,
    "/3d/wenren-avatar-617f0102b1df.glb",
  );
  assert.match(
    modelLoader,
    /request\(spatialAvatarAssets\.model, \{\s*credentials: "same-origin",\s*signal,?\s*\}\)/,
  );
  assert.match(modelLoader, /return response\.arrayBuffer\(\)/);
  assert.match(modelLoader, /cache: "only-if-cached"/);
  assert.match(modelLoader, /mode: "same-origin"/);
  assert.match(modelLoader, /MODEL_CACHE_PROBE_TIMEOUT_MS = 48/);
  assert.match(modelLoader, /cacheProbeController\.abort\(\)/);

  assert.match(scene, /new THREE\.WebGLRenderer/);
  assert.match(
    scene,
    /renderer\.toneMappingExposure = PORTRAIT_TONE_MAPPING_EXPOSURE/,
  );
  assert.match(
    scene,
    /scene\.add\(portraitGroup, createPortraitLightRig\(\)\)/,
  );
  assert.match(scene, /new RoomEnvironment\(\)/);
  assert.match(scene, /new THREE\.PMREMGenerator\(renderer\)/);
  assert.match(scene, /scene\.environment = environmentRenderTarget\.texture/);
  assert.match(
    scene,
    /scene\.environmentIntensity = PORTRAIT_ENVIRONMENT_INTENSITY/,
  );
  assert.match(scene, /const modelBytes = await callbacks\.modelBytes/);
  assert.match(
    scene,
    /const modelBytes = await callbacks\.modelBytes;[\s\S]*callbacks\.onModelBytesReady\(\);[\s\S]*parseAsync\(modelBytes, "\/"\)/,
  );
  assert.match(scene, /setMeshoptDecoder\(MeshoptDecoder\)/);
  assert.match(scene, /parseAsync\(modelBytes, "\/"\)/);
  for (const { meshNames, pivotName } of EYE_CONTRACTS) {
    assert.match(scene, new RegExp(pivotName));
    for (const meshName of meshNames) assert.match(scene, new RegExp(meshName));
  }
  assert.match(scene, /resolveEyePivots/);
  assert.match(scene, /pivot\.parent !== activeScene/);
  assert.match(scene, /mesh instanceof THREE\.Mesh/);
  assert.match(scene, /mesh\.parent === pivot/);
  assert.match(scene, /mapPointerToGaze/);
  assert.match(scene, /createPortraitLayoutFrames/);
  assert.match(scene, /readPortraitLayoutFrame/);
  assert.match(scene, /readPortraitLayoutProgress/);
  assert.match(scene, /SPATIAL_AVATAR_READING_PHASE_RATIO/);
  assert.match(scene, /const portraitPoseGroup = new THREE\.Group\(\)/);
  assert.match(scene, /const portraitDragGroup = new THREE\.Group\(\)/);
  assert.match(scene, /portraitGroup\.add\(portraitPoseGroup\)/);
  assert.match(scene, /portraitPoseGroup\.add\(portraitDragGroup\)/);
  assert.match(scene, /portraitDragGroup\.add\(modelFrame\)/);
  assert.match(
    scene,
    /portraitGroup\.position\.set\(currentModelX, currentModelY, 0\)/,
  );
  assert.doesNotMatch(
    scene,
    /StoryFrame|createStoryFrames|readStoryFrame|storyPoseGroup/,
    "新布局不得保留按章节旋转身体的旧故事姿态层",
  );
  assert.doesNotMatch(
    scene,
    /currentModelZ|currentCameraY|currentCameraZ|currentCameraTargetY|currentYaw|currentPitch|currentRoll/,
    "滚动不得再插值纵深、相机、俯仰或横滚",
  );
  assert.match(
    scene,
    /currentModelYaw = THREE\.MathUtils\.lerp\(\s*currentModelYaw,\s*layoutFrame\.modelYaw,\s*modelFactor,?\s*\)/,
    "一次性阅读姿态必须与位移缩放使用同一阻尼收敛",
  );
  assert.equal(
    (scene.match(/portraitPoseGroup\.rotation\.y = currentModelYaw/g) ?? [])
      .length,
    2,
    "姿态层只在逐帧渲染和模型首帧同步同一阅读角度",
  );
  assert.match(
    scene,
    /Math\.abs\(currentModelYaw - layoutFrame\.modelYaw\) > SETTLE_EPSILON/,
    "渲染循环必须等待阅读角度真正收敛",
  );
  assert.match(scene, /const portraitRaycaster = new THREE\.Raycaster\(\)/);
  assert.match(scene, /portraitRaycaster\.intersectObjects\(modelMeshes, false\)/);
  assert.match(
    scene,
    /const handlePortraitPointerDown = \(event: PointerEvent\): void => \{[\s\S]*?!event\.isPrimary[\s\S]*?event\.button !== 0[\s\S]*?!isPointerOverPortrait\(event\.clientX, event\.clientY\)[\s\S]*?portraitPointerId = event\.pointerId;/,
    "只有主指针左键真正命中人物后才能建立拖动候选",
  );
  assert.match(
    scene,
    /const handlePortraitPointerMove = \(event: PointerEvent\): void => \{[\s\S]*?event\.pointerId !== portraitPointerId[\s\S]*?event\.pointerType !== "touch" && \(event\.buttons & 1\) === 0[\s\S]*?Math\.abs\(deltaY\) > Math\.abs\(deltaX\)[\s\S]*?resetPortraitPointer\(false\)[\s\S]*?Math\.abs\(deltaX\) < PORTRAIT_DRAG_THRESHOLD[\s\S]*?canvas\.setPointerCapture\(event\.pointerId\)[\s\S]*?pointerActive = finePointer;[\s\S]*?pointerClientX = event\.clientX;[\s\S]*?pointerClientY = event\.clientY;[\s\S]*?draggedModelYaw = readPortraitDragYaw\([\s\S]*?updateProjectedEyeCenter\(\);\s*updatePointerGaze\(\);\s*updateEyeTargets\(\);/,
    "纵向意图必须交还滚动，只有同一指针的横向意图才能捕获并更新角度",
  );
  assert.match(
    scene,
    /const resetPortraitPointer = \(releaseCapture = true\): void => \{[\s\S]*?canvas\.hasPointerCapture\(pointerId\)[\s\S]*?canvas\.releasePointerCapture\(pointerId\)/,
    "结束拖动必须安全释放当前指针捕获",
  );
  assert.match(
    scene,
    /window\.addEventListener\("pointermove", handlePortraitPointerMove/,
    "拖动处理器必须实际接入全窗口指针移动事件",
  );
  assert.match(
    scene,
    /const handlePointerLeave = \(\): void => \{\s*if \(portraitPointerId !== null\) resetPortraitPointer\(\);\s*pointerActive = false;/,
    "未捕获的拖动候选离开页面时也必须清理",
  );
  for (const [eventName, target] of [
    ["pointerdown", "canvas"],
    ["pointerup", "window"],
    ["pointercancel", "window"],
    ["lostpointercapture", "canvas"],
  ]) {
    assert.match(
      scene,
      new RegExp(
        `${target}\\.addEventListener\\("${eventName}", handlePortraitPointer(?:Down|End)`,
      ),
    );
  }
  assert.match(
    scene,
    /portraitDragGroup\.rotation\.y =\s*resolvePortraitYaw\(currentModelYaw, draggedModelYaw\) - currentModelYaw/,
    "用户拖动必须通过独立姿态层叠加，并保持最终绝对角度受限",
  );
  assert.doesNotMatch(
    scene,
    /portraitGroup\.rotation\.|portraitDragGroup\.rotation\.(?:x|z)\s*=|camera\.rotation\./,
    "拖动不得改变展示层、相机、俯仰或横滚",
  );
  assert.doesNotMatch(
    scene,
    /portraitPoseGroup\.(?:rotate[XYZ]|quaternion\.)|portraitPoseGroup\.rotation\.(?:x|z)\s*=|portraitDragGroup\.(?:rotate[XYZ]|quaternion\.)/,
    "阅读与拖动姿态层都只能接收各自声明的水平转角",
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-webgl-ready \.spatial-portrait-canvas\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?touch-action:\s*pan-y pinch-zoom;/,
    "真实模型就绪后画布才可命中，并保留纵向滚动和双指缩放",
  );
  assert.match(styles, /\.is-portrait-hovered[\s\S]*?cursor:\s*grab;/);
  assert.match(styles, /\.is-dragging[\s\S]*?cursor:\s*grabbing;/);
  assert.match(
    scene,
    /const gazeX = pointerActive \? pointerX : layoutFrame\.gazeX/,
    "无指针输入时双眼必须使用阅读态的右向默认目光",
  );
  assert.match(scene, /pointerClientX = event\.clientX/);
  assert.match(scene, /pointerClientY = event\.clientY/);
  assert.match(scene, /canvas\.getBoundingClientRect\(\)/);
  assert.match(scene, /eye\.pivot\.getWorldPosition/);
  assert.match(scene, /project\(camera\)/);
  assert.match(
    scene,
    /portraitGroup\.getWorldPosition\(portraitWorldPosition\)/,
  );
  assert.match(
    scene,
    /projectedPortraitCenter\.copy\(portraitWorldPosition\)\.project\(camera\)/,
  );
  assert.match(scene, /"--spatial-light-shift"/);
  assert.match(scene, /"--spatial-light-scale"/);
  assert.match(
    scene,
    /readPortraitDepthScale\([\s\S]*?camera,[\s\S]*?portraitWorldPosition/,
  );
  assert.match(
    scene,
    /camera\.position\.set\(0, DEFAULT_CAMERA_Y, DEFAULT_CAMERA_Z\)/,
  );
  assert.match(
    scene,
    /camera\.lookAt\(0, DEFAULT_CAMERA_TARGET_Y, 0\)/,
  );
  assert.doesNotMatch(scene, /cameraUnsettled|bodyUnsettled|updateCameraPresentation/);
  assert.doesNotMatch(
    scene,
    /(?:layout|story)Frame\.(?:camera[A-Za-z]*|modelZ|pitch|roll|gazeY)\b/,
    "章节布局只可携带一次水平姿态与水平默认目光，不得恢复相机或其他身体通道",
  );
  assert.match(
    scene,
    /updateBackdropPresentation\(\);\s*updateProjectedEyeCenter\(\);\s*updatePointerGaze\(\);\s*updateEyeTargets\(\)/,
  );
  assert.doesNotMatch(
    scene,
    /clientX \/ window\.innerWidth|clientY \/ window\.innerHeight/,
  );
  assert.doesNotMatch(scene, /AvatarRoot|EyePivot_|EyeMesh_|EYE_GAZE_CTRL/);
  assert.match(scene, /new THREE\.Box3\(\)\.setFromObject\(modelFrame\)/);
  assert.doesNotMatch(
    scene,
    /THREE\.Bone|THREE\.SkinnedMesh|skeleton|EyeBone|JOINTS_0|WEIGHTS_0|COLOR_0/,
  );
  assert.match(scene, /1 - Math\.exp\(-EYE_DAMPING \* delta\)/);
  assert.match(scene, /SETTLE_EPSILON/);
  assert.match(scene, /new IntersectionObserver/);
  assert.match(scene, /visibilitychange/);
  assert.match(scene, /event\.persisted/);
  assert.match(scene, /pageshow/);
  assert.match(scene, /webglcontextlost/);
  assert.match(scene, /webglcontextrestored/);
  assert.match(scene, /disposeObjectTree/);
  assert.match(scene, /environmentRenderTarget\.dispose\(\)/);
  assert.match(scene, /renderer\.renderLists\.dispose\(\)/);
  assert.match(scene, /renderer\.dispose\(\)/);
  assert.match(scene, /resetBackdropPresentation\(\)/);
  assert.match(
    scene,
    /page\.style\.removeProperty\("--spatial-light-shift"\)/,
  );
  assert.match(
    scene,
    /page\.style\.removeProperty\("--spatial-light-scale"\)/,
  );
  assert.doesNotMatch(scene, /forceContextLoss/);

  assert.match(styles, /@media \(max-width: 800px\)/);
  assert.match(styles, /--spatial-light-shift:\s*0vw/);
  assert.match(styles, /--spatial-light-scale:\s*1/);
  assert.doesNotMatch(
    styles,
    /\.spatial-page\s*\{[^}]*min-height:/,
    "页面总高度必须由四个真实章节自然撑开，避免末尾额外空白屏",
  );
  assert.match(
    styles,
    /\.spatial-hero\s*\{[^}]*min-height:\s*100svh/,
    "承载 About 的默认首屏必须占据完整视口高度",
  );
  assert.match(
    styles,
    /\.spatial-chapter\s*\{[^}]*min-height:\s*100svh/,
    "About 与后三章必须各自保持一屏高度",
  );
  assert.match(
    styles,
    /\.spatial-chapter-directory\s*\{[^}]*justify-content:\s*flex-end/,
    "桌面端后三章内容必须统一放在右栏",
  );
  assert.match(
    styles,
    /\.spatial-chapter-intro\s*\{[^}]*align-items:\s*flex-end;[^}]*justify-content:\s*center;[^}]*text-align:\s*center/,
    "About 必须恢复底部居中的旧版布局",
  );
  assert.match(
    styles,
    /\.spatial-copy-intro\s*\{[^}]*width:\s*min\(76vw, 47rem\);[^}]*color:\s*#f7f2e7/,
    "About 必须恢复旧版居中文字宽度与前景色",
  );
  assert.match(
    styles,
    /\.spatial-copy-intro \.spatial-summary\s*\{[^}]*max-width:\s*43rem;[^}]*margin-inline:\s*auto/,
    "About 摘要必须在宽版文字区中居中",
  );
  assert.match(
    styles,
    /\.spatial-copy-intro\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*backdrop-filter:\s*none/,
    "移动端 About 必须保持透明旧样式，不得变成目录卡片",
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-webgl-ready \.spatial-portrait-canvas/,
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-cache-probing \.spatial-portrait-loading-poster/,
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-model-bytes-ready \.spatial-portrait-loading-poster/,
  );
  assert.match(
    styles,
    /\.spatial-portrait\.is-loading-poster-visible \.spatial-portrait-loading-poster/,
  );
  assert.match(styles, /@keyframes spatial-loading-poster-reveal/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(
    styles,
    /\.spatial-page\.is-content-phase[^{]*\.spatial-portrait-loading-poster/,
  );
  assert.match(
    styles,
    /\.spatial-page\.is-content-phase[^{]*\.spatial-portrait-static-poster/,
  );
  assert.match(styles, /--spatial-stage-background:\s*#e8e5db/);
  assert.match(
    styles,
    /background:\s*var\(--spatial-stage-background\)/,
  );
  assert.match(styles, /at 68% 30%/);
  assert.match(styles, /rgba\(164, 174, 178, 0\.12\)/);
  assert.match(styles, /width:\s*100vw;\s*height:\s*100svh/);
  assert.match(
    globalStyles,
    /--information-font-size:\s*clamp\(0\.75rem, 1\.111vw, 1rem\)/,
  );
  assert.match(
    heroStyles,
    /\.home-information\s*\{[^}]*font-size:\s*var\(--information-font-size\)/,
  );
  assert.match(
    heroStyles,
    /\.hero-avatar-link::before\s*\{[^}]*content:\s*"↖";/,
  );
  assert.match(
    styles,
    /\.spatial-summary,\s*\.spatial-copy > p:not\(\.spatial-eyebrow\)\s*\{[^}]*font-size:\s*var\(--information-font-size\)/,
  );
  assert.match(
    styles,
    /\.spatial-directory-groups\s*\{[^}]*font-size:\s*var\(--information-font-size\)/,
  );
  assert.match(
    styles,
    /\.spatial-home-link\s*\{[^}]*font-size:\s*var\(--information-font-size\)/,
  );
  assert.match(styles, /\.spatial-home-link-arrow\s*\{/);
  assert.doesNotMatch(styles, /font-size:\s*0\.67rem/);
  assert.match(
    styles,
    /\.spatial-portrait::before\s*\{[^}]*z-index:\s*0;[^}]*radial-gradient[^}]*pointer-events:\s*none;/,
  );
  assert.match(
    styles,
    /translate3d\(var\(--spatial-light-shift\), 0, 0\)\s*scale\(var\(--spatial-light-scale\)\)/,
  );
  assert.match(styles, /will-change:\s*transform/);
  assert.match(styles, /rgba\(103, 100, 92, 0\.095\)/);
  assert.match(styles, /\.spatial-portrait-fallback\s*\{[^}]*z-index:\s*1;/);
  assert.match(
    styles,
    /\.spatial-portrait-static-poster\s*\{[^}]*opacity:\s*0;/,
  );
  assert.match(styles, /\.spatial-portrait\.is-static/);
  assert.match(styles, /\.spatial-portrait\.is-webgl-unavailable/);
  assert.match(styles, /\.spatial-portrait-canvas\s*\{[^}]*z-index:\s*2;/);
  assert.match(
    styles,
    /\.spatial-portrait::after\s*\{[^}]*z-index:\s*3;[^}]*pointer-events:\s*none;/,
  );
  assert.match(styles, /rgba\(240, 236, 226, 0\.36\)/);
  assert.match(styles, /ellipse 92vw 62vh at 50% 33%/);
  assert.match(styles, /rgba\(164, 174, 178, 0\.075\)/);
  assert.doesNotMatch(
    styles,
    /is-spatial-static \.spatial-portrait-fallback\s*\{[^}]*translateX/,
  );
  assert.doesNotMatch(styles, /spatial-portrait-hint|spatial-pointer-hint/);

  assert.match(builtAvatar, /alt="Alice 的三维人物模型/);
  assert.equal(
    (builtAvatar.match(/data-spatial-hero/g) ?? []).length,
    1,
    "构建产物必须由唯一默认首屏直接承载 About",
  );

  assert.equal(
    createHash("sha256").update(loadingPoster).digest("hex"),
    LOADING_POSTER_SHA256,
    "桌面加载海报必须保持内容寻址一致",
  );
  assert.equal(
    createHash("sha256").update(loadingMobilePoster).digest("hex"),
    LOADING_MOBILE_POSTER_SHA256,
    "移动端加载海报必须保持内容寻址一致",
  );
  assert.equal(
    createHash("sha256").update(poster).digest("hex"),
    POSTER_SHA256,
    "桌面同模型海报必须保持内容寻址一致",
  );
  assert.equal(
    createHash("sha256").update(mobilePoster).digest("hex"),
    MOBILE_POSTER_SHA256,
    "移动端同模型海报必须保持内容寻址一致",
  );
  assert.deepEqual(imageSize(loadingPoster), {
    width: 2_560,
    height: 1_440,
    type: "jpg",
  });
  assert.deepEqual(imageSize(loadingMobilePoster), {
    width: 780,
    height: 1_688,
    type: "jpg",
  });
  assert.deepEqual(imageSize(poster), {
    width: 1_280,
    height: 720,
    type: "jpg",
  });
  assert.deepEqual(imageSize(mobilePoster), {
    width: 390,
    height: 844,
    type: "jpg",
  });

  const [
    loadingDesktopBounds,
    loadingMobileBounds,
    staticDesktopBounds,
    staticMobileBounds,
  ] = await Promise.all([
    readPortraitBounds(loadingPoster),
    readPortraitBounds(loadingMobilePoster),
    readPortraitBounds(poster),
    readPortraitBounds(mobilePoster),
  ]);
  assert.ok(Math.abs(loadingDesktopBounds.centerRatio - 0.5) < 0.01);
  assert.ok(Math.abs(loadingMobileBounds.centerRatio - 0.5) < 0.01);
  assert.ok(
    staticDesktopBounds.centerRatio < 0.35,
    "桌面静态海报需继续为右侧章节文字留出空间",
  );
  assert.ok(Math.abs(staticMobileBounds.centerRatio - 0.5) < 0.02);
  assert.equal(
    staticDesktopBounds.maximumY,
    staticDesktopBounds.height - 1,
    "桌面静态海报必须把模型下沿裁到画面外",
  );
  assert.equal(
    staticMobileBounds.maximumY,
    staticMobileBounds.height - 1,
    "移动端静态海报必须把模型下沿裁到画面外",
  );
});

/** 最终 GLB 必须完整保留新附件的双眼控制层级，并以网页安全体积交付。 */
test("keeps the optimized eye rig and textured geometry intact", async (t) => {
  const model = await readFile(modelUrl);
  assert.equal(model.length, 5_871_564);
  assert.ok(model.length < 6 * 1024 * 1024, "移动端模型传输体积不得超过 6 MiB");
  assert.equal(
    createHash("sha256").update(model).digest("hex"),
    MODEL_SHA256,
    "内容哈希文件名必须对应已验收的完整模型资产",
  );

  const asset = readGlbAsset(model);
  const { document } = asset;
  assert.match(document.asset.generator, /^glTF-Transform v4\./);
  assert.deepEqual(document.extensionsUsed?.sort(), [
    "EXT_meshopt_compression",
    "KHR_materials_clearcoat",
    "KHR_mesh_quantization",
  ]);
  assert.deepEqual(document.extensionsRequired?.sort(), [
    "EXT_meshopt_compression",
    "KHR_mesh_quantization",
  ]);
  assert.equal(
    document.bufferViews.filter(
      (view) => view.extensions?.EXT_meshopt_compression,
    ).length,
    17,
  );
  assert.equal(document.skins, undefined);
  assert.equal(document.animations, undefined);
  assert.deepEqual(document.scenes[document.scene].nodes, [7, 15, 16]);

  assert.deepEqual(
    document.nodes.map((node) => node.name),
    [
      ...EYE_CONTRACTS[0].sourceMeshNames,
      EYE_CONTRACTS[0].sourcePivotName,
      ...EYE_CONTRACTS[1].sourceMeshNames,
      EYE_CONTRACTS[1].sourcePivotName,
      BODY_NODE_NAME,
    ],
  );
  const sourcePivotTranslations = [
    [0.07188069075345993, 0.30517578125, -0.039336949586868286],
    [0.06935032457113266, 0.3031080663204193, 0.035001739859580994],
  ];
  for (const [eyeIndex, contract] of EYE_CONTRACTS.entries()) {
    const pivotIndex = document.nodes.findIndex(
      (node) => node.name === contract.sourcePivotName,
    );
    const pivot = document.nodes[pivotIndex];
    assert.ok(pivotIndex >= 0);
    assert.deepEqual(
      pivot.children.map((nodeIndex) => document.nodes[nodeIndex].name),
      contract.sourceMeshNames,
    );
    assertVectorClose(pivot.translation, sourcePivotTranslations[eyeIndex]);
    assertVectorClose(pivot.rotation, [0.5, 0.5, -0.5, 0.5]);
  }

  assert.equal(document.meshes.length, 15);
  assert.equal(document.meshes.at(-1).name, "Mesh_0");
  assert.deepEqual(
    document.materials.map((material) => material.name),
    [
      "MAT_EyeWhite",
      "MAT_EyeHighlight",
      "MAT_IrisBrown",
      "MAT_IrisAmber",
      "MAT_IrisRing",
      "MAT_Pupil",
      "tripo_material_7ab0ba04-e9ae-45f9-836c-f4b5c53c7fae",
    ],
  );
  for (const material of document.materials.slice(0, 6)) {
    assert.ok(material.extensions?.KHR_materials_clearcoat);
  }

  const primitives = document.meshes.flatMap((mesh) => mesh.primitives);
  assert.equal(primitives.length, 15);
  for (const primitive of primitives) {
    assert.deepEqual(Object.keys(primitive.attributes).sort(), [
      "NORMAL",
      "POSITION",
      "TEXCOORD_0",
    ]);
    const position = document.accessors[primitive.attributes.POSITION];
    const normal = document.accessors[primitive.attributes.NORMAL];
    const uv = document.accessors[primitive.attributes.TEXCOORD_0];
    assert.equal(normal.count, position.count);
    assert.equal(uv.count, position.count);
  }
  assert.equal(
    primitives.reduce(
      (total, primitive) =>
        total + document.accessors[primitive.indices].count / 3,
      0,
    ),
    693_458,
    "网页压缩不得改变附件的三角面数量",
  );
  assert.equal(
    document.accessors[primitives.at(-1).attributes.POSITION].count,
    374_775,
  );

  assert.deepEqual(
    document.images.map((image) => image.name),
    [
      "NormalGL_7ab0ba04-e9ae-45f9-836c-f4b5c53c7fae",
      "Color_7ab0ba04-e9ae-45f9-836c-f4b5c53c7fae",
      "ORM_7ab0ba04-e9ae-45f9-836c-f4b5c53c7fae",
    ],
  );
  for (const image of document.images) {
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.uri, undefined, "三张纹理必须继续内嵌在 GLB 中");
    assert.deepEqual(imageSize(readBufferViewBytes(asset, image.bufferView)), {
      width: 2_048,
      height: 2_048,
      type: "jpg",
    });
  }

  const hadSelf = Object.hasOwn(globalThis, "self");
  const previousSelf = globalThis.self;
  const hadCreateImageBitmap = Object.hasOwn(globalThis, "createImageBitmap");
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async () => ({
    width: 2_048,
    height: 2_048,
    close() {},
  });
  t.after(() => {
    if (hadSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
    if (hadCreateImageBitmap)
      globalThis.createImageBitmap = previousCreateImageBitmap;
    else delete globalThis.createImageBitmap;
  });

  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
  ]);
  const modelArrayBuffer = model.buffer.slice(
    model.byteOffset,
    model.byteOffset + model.byteLength,
  );
  const gltf = await new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .parseAsync(modelArrayBuffer, "/");
  const body = gltf.scene.getObjectByName(BODY_NODE_NAME);
  assert.ok(body instanceof THREE.Mesh);
  assert.ok(body.material instanceof THREE.MeshStandardMaterial);
  assert.equal(body.parent, gltf.scene);

  const eyePairs = EYE_CONTRACTS.map(
    ({ meshNames, pivotName, sourceMeshNames, sourcePivotName }) => {
      const pivot = gltf.scene.getObjectByName(pivotName);
      const meshes = meshNames.map((name) => gltf.scene.getObjectByName(name));
      assert.equal(pivot?.type, "Object3D");
      assert.equal(pivot.userData.name, sourcePivotName);
      assert.equal(pivot.parent, gltf.scene);
      assert.ok(
        meshes.every(
          (mesh, index) =>
            mesh instanceof THREE.Mesh &&
            mesh.parent === pivot &&
            mesh.userData.name === sourceMeshNames[index] &&
            mesh.material instanceof THREE.MeshPhysicalMaterial,
        ),
      );
      return { meshes, pivot };
    },
  );

  const expectedBaseQuaternion = new THREE.Quaternion(0.5, 0.5, -0.5, 0.5);
  for (const { pivot } of eyePairs) {
    assert.ok(
      pivot.quaternion.angleTo(expectedBaseQuaternion) < 1e-7,
      "双眼控制节点必须保留附件声明的非默认初始朝向",
    );
  }

  const displayFrame = new THREE.Group();
  displayFrame.rotation.y = -Math.PI / 2;
  displayFrame.add(gltf.scene);
  displayFrame.updateWorldMatrix(true, true);
  const displayBounds = new THREE.Box3().setFromObject(displayFrame);
  const displaySize = displayBounds.getSize(new THREE.Vector3());
  const displayCenter = displayBounds.getCenter(new THREE.Vector3());
  const displayScale = 1.9 / Math.max(displaySize.x, displaySize.y);
  displayFrame.scale.setScalar(displayScale);
  displayFrame.position.set(
    -displayCenter.x * displayScale,
    -displayCenter.y * displayScale + 0.01,
    -displayCenter.z * displayScale,
  );
  displayFrame.updateWorldMatrix(true, true);
  const baseQuaternions = eyePairs.map(({ pivot }) => pivot.quaternion.clone());
  for (const [eyeIndex, { meshes, pivot }] of eyePairs.entries()) {
    const pupil = meshes.at(-1);
    const center = pupil.getWorldPosition(new THREE.Vector3());
    const targetQuaternion = new THREE.Quaternion();
    setEyeTargetQuaternion(
      baseQuaternions[eyeIndex],
      targetQuaternion,
      1,
      0,
    );
    pivot.quaternion.copy(targetQuaternion);
    displayFrame.updateWorldMatrix(true, true);
    const right = pupil.getWorldPosition(new THREE.Vector3());
    assert.ok(right.x > center.x + 0.0001, "鼠标向右时瞳孔必须向画面右侧移动");

    pivot.quaternion.copy(baseQuaternions[eyeIndex]);
    setEyeTargetQuaternion(
      baseQuaternions[eyeIndex],
      targetQuaternion,
      0,
      1,
    );
    pivot.quaternion.copy(targetQuaternion);
    displayFrame.updateWorldMatrix(true, true);
    const down = pupil.getWorldPosition(new THREE.Vector3());
    assert.ok(down.y < center.y - 0.0001, "鼠标向下时瞳孔必须向画面下方移动");
    pivot.quaternion.copy(baseQuaternions[eyeIndex]);
  }

  /** 读取瞳孔相对眼球枢轴的屏幕偏移，统一验证两种布局中的局部目光。 */
  const readProjectedEyeOffset = (pupil, pivot, camera) => {
    const pupilPosition = pupil
      .getWorldPosition(new THREE.Vector3())
      .project(camera);
    const pivotPosition = pivot
      .getWorldPosition(new THREE.Vector3())
      .project(camera);
    return pupilPosition.sub(pivotPosition);
  };

  /** 投影完整模型的八个包围盒角点，验证近景裁切和阅读态全身构图。 */
  const readProjectedPortraitBounds = (object, camera) => {
    const bounds = new THREE.Box3().setFromObject(object);
    const { min, max } = bounds;
    const corners = [
      [min.x, min.y, min.z],
      [min.x, min.y, max.z],
      [min.x, max.y, min.z],
      [min.x, max.y, max.z],
      [max.x, min.y, min.z],
      [max.x, min.y, max.z],
      [max.x, max.y, min.z],
      [max.x, max.y, max.z],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z).project(camera));
    return {
      maximumX: Math.max(...corners.map((corner) => corner.x)),
      maximumY: Math.max(...corners.map((corner) => corner.y)),
      minimumX: Math.min(...corners.map((corner) => corner.x)),
      minimumY: Math.min(...corners.map((corner) => corner.y)),
    };
  };

  /** 在固定相机与真实透视投影下，布局、拖动和眼球各自只改变所属姿态层。 */
  const portraitStage = new THREE.Group();
  const portraitPoseGroup = new THREE.Group();
  const portraitDragGroup = new THREE.Group();
  portraitStage.add(portraitPoseGroup);
  portraitPoseGroup.add(portraitDragGroup);
  portraitDragGroup.add(displayFrame);
  const portraitCamera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 20);
  portraitCamera.position.set(0, 0.03, 3.8);
  portraitCamera.lookAt(0, 0.02, 0);
  const desktopLayoutFrames = createPortraitLayoutFrames(false);
  const compactLayoutFrames = createPortraitLayoutFrames(true);
  const layoutProgresses = [0, 0.5, 1];
  const layoutCases = [
    ...layoutProgresses.map((progress) => ({
      aspect: 16 / 9,
      compact: false,
      layout: readPortraitLayoutFrame(progress, desktopLayoutFrames),
      progress,
    })),
    ...layoutProgresses.map((progress) => ({
      aspect: 390 / 844,
      compact: true,
      layout: readPortraitLayoutFrame(progress, compactLayoutFrames),
      progress,
    })),
  ];
  for (const { aspect, compact, layout, progress } of layoutCases) {
    portraitCamera.aspect = aspect;
    portraitCamera.updateProjectionMatrix();
    portraitCamera.updateWorldMatrix(true, false);
    portraitStage.position.set(layout.modelX, layout.modelY, 0);
    portraitStage.scale.setScalar(layout.scale);
    portraitPoseGroup.rotation.y = layout.modelYaw;
    portraitDragGroup.rotation.y = 0;
    eyePairs.forEach(({ pivot }, index) =>
      pivot.quaternion.copy(baseQuaternions[index]),
    );
    portraitStage.updateWorldMatrix(true, true);
    const projectedBounds = readProjectedPortraitBounds(
      portraitStage,
      portraitCamera,
    );
    if (progress === 0) {
      assert.ok(
        projectedBounds.maximumY - projectedBounds.minimumY > 2,
        "首屏近景必须放大到裁切模型下半身",
      );
    }
    if (progress === 1) {
      assert.ok(
        projectedBounds.maximumY < 1,
        "阅读态必须完整保留头顶，不得从视口上沿裁切",
      );
      const projectedCenterX =
        (projectedBounds.minimumX + projectedBounds.maximumX) / 2;
      if (compact) {
        assert.ok(
          projectedBounds.minimumY < -1.01,
          "移动端阅读态必须把模型自身的截断下沿藏到视口外",
        );
        assert.ok(Math.abs(projectedCenterX) < 0.08, "移动端阅读态必须保持居中");
      } else {
        assert.ok(
          projectedBounds.minimumY < -1.08,
          "桌面阅读态必须把模型自身的截断下沿充分藏到视口外",
        );
        assert.ok(projectedCenterX < -0.2, "桌面阅读态必须固定在左半边");
        assert.ok(projectedBounds.maximumX < 0.1, "模型不得侵入右侧目录区域");
      }
    }
    for (const [eyeIndex, { meshes, pivot }] of eyePairs.entries()) {
      eyePairs.forEach(({ pivot: candidate }, index) =>
        candidate.quaternion.copy(baseQuaternions[index]),
      );
      portraitStage.updateWorldMatrix(true, true);
      const pupil = meshes.at(-1);
      const portraitStageBefore = portraitStage.matrixWorld.clone();
      const portraitPoseBefore = portraitPoseGroup.matrixWorld.clone();
      const portraitDragBefore = portraitDragGroup.matrixWorld.clone();
      const modelFrameBefore = displayFrame.matrixWorld.clone();
      const center = pupil
        .getWorldPosition(new THREE.Vector3())
        .project(portraitCamera);
      const centerOffset = readProjectedEyeOffset(
        pupil,
        pivot,
        portraitCamera,
      );
      assert.ok(
        Math.abs(center.x) < 1 &&
          Math.abs(center.y) < 1 &&
          Math.abs(center.z) < 1,
        `首屏与阅读态中的双眼必须保持在可见画面内：${JSON.stringify({
          aspect,
          center: center.toArray(),
          layout,
        })}`,
      );
      const targetQuaternion = new THREE.Quaternion();

      setEyeTargetQuaternion(
        baseQuaternions[eyeIndex],
        targetQuaternion,
        1,
        0,
      );
      pivot.quaternion.copy(targetQuaternion);
      portraitStage.updateWorldMatrix(true, true);
      const right = pupil
        .getWorldPosition(new THREE.Vector3())
        .project(portraitCamera);
      assert.ok(
        right.x > center.x + 0.00001,
        "两种布局中鼠标向右仍必须让瞳孔投影向右",
      );
      const rightOffset = readProjectedEyeOffset(
        pupil,
        pivot,
        portraitCamera,
      );
      assert.ok(
        rightOffset.x > centerOffset.x + 0.00001,
        "瞳孔相对眼眶必须向右",
      );
      assertVectorClose(
        portraitStage.matrixWorld.elements,
        portraitStageBefore.elements,
        1e-12,
      );
      assertVectorClose(
        portraitPoseGroup.matrixWorld.elements,
        portraitPoseBefore.elements,
        1e-12,
      );
      assertVectorClose(
        portraitDragGroup.matrixWorld.elements,
        portraitDragBefore.elements,
        1e-12,
      );
      assertVectorClose(
        displayFrame.matrixWorld.elements,
        modelFrameBefore.elements,
        1e-12,
      );

      pivot.quaternion.copy(baseQuaternions[eyeIndex]);
      setEyeTargetQuaternion(
        baseQuaternions[eyeIndex],
        targetQuaternion,
        0,
        1,
      );
      pivot.quaternion.copy(targetQuaternion);
      portraitStage.updateWorldMatrix(true, true);
      const down = pupil
        .getWorldPosition(new THREE.Vector3())
        .project(portraitCamera);
      assert.ok(
        down.y < center.y - 0.00001,
        "两种布局中鼠标向下仍必须让瞳孔投影向下",
      );
      const downOffset = readProjectedEyeOffset(
        pupil,
        pivot,
        portraitCamera,
      );
      assert.ok(
        downOffset.y < centerOffset.y - 0.00001,
        "瞳孔相对眼眶必须向下",
      );
      assertVectorClose(
        portraitStage.matrixWorld.elements,
        portraitStageBefore.elements,
        1e-12,
      );
      assertVectorClose(
        portraitPoseGroup.matrixWorld.elements,
        portraitPoseBefore.elements,
        1e-12,
      );
      assertVectorClose(
        portraitDragGroup.matrixWorld.elements,
        portraitDragBefore.elements,
        1e-12,
      );
      assertVectorClose(
        displayFrame.matrixWorld.elements,
        modelFrameBefore.elements,
        1e-12,
      );
    }
  }

  /** 真实身体网格必须围绕居中后的父级原点旋转，舞台位置与比例保持不变。 */
  const readingLayout = desktopLayoutFrames[1];
  const dragBodyVertex = readObservableMeshVertex(body);
  portraitStage.position.set(readingLayout.modelX, readingLayout.modelY, 0);
  portraitStage.scale.setScalar(readingLayout.scale);
  portraitPoseGroup.rotation.y = readingLayout.modelYaw;
  const stagePositionBeforeDrag = portraitStage.position.clone();
  const stageScaleBeforeDrag = portraitStage.scale.clone();
  const draggedBodyPositions = [
    -MAX_PORTRAIT_DRAG_YAW,
    0,
    MAX_PORTRAIT_DRAG_YAW,
  ].map((draggedYaw) => {
    portraitDragGroup.rotation.y =
      resolvePortraitYaw(readingLayout.modelYaw, draggedYaw) -
      readingLayout.modelYaw;
    portraitStage.updateWorldMatrix(true, true);
    assertVectorClose(
      portraitStage.position.toArray(),
      stagePositionBeforeDrag.toArray(),
      1e-12,
    );
    assertVectorClose(
      portraitStage.scale.toArray(),
      stageScaleBeforeDrag.toArray(),
      1e-12,
    );
    assert.equal(portraitStage.rotation.x, 0);
    assert.equal(portraitStage.rotation.y, 0);
    assert.equal(portraitStage.rotation.z, 0);
    assert.equal(portraitPoseGroup.rotation.y, readingLayout.modelYaw);
    assert.equal(portraitDragGroup.rotation.x, 0);
    assert.equal(portraitDragGroup.rotation.z, 0);
    return readWorldVertex(body, dragBodyVertex);
  });
  assert.ok(draggedBodyPositions[0].distanceTo(draggedBodyPositions[1]) > 0.01);
  assert.ok(draggedBodyPositions[1].distanceTo(draggedBodyPositions[2]) > 0.01);
  assert.ok(draggedBodyPositions[0].distanceTo(draggedBodyPositions[2]) > 0.01);

  eyePairs.forEach(({ pivot }, index) =>
    pivot.quaternion.copy(baseQuaternions[index]),
  );
  portraitStage.position.set(0, 0, 0);
  portraitStage.scale.setScalar(1);
  portraitPoseGroup.rotation.y = 0;
  portraitDragGroup.rotation.y = 0;
  portraitStage.updateWorldMatrix(true, true);

  const localVertices = eyePairs.map(({ meshes }) =>
    meshes.map((mesh) => readObservableMeshVertex(mesh)),
  );
  const bodyVertex = readObservableMeshVertex(body);
  for (const activeIndex of [0, 1]) {
    eyePairs.forEach(({ pivot }, index) =>
      pivot.quaternion.copy(baseQuaternions[index]),
    );
    displayFrame.updateWorldMatrix(true, true);
    const before = eyePairs.map(({ meshes }, index) =>
      captureWorldVertices(meshes, localVertices[index]),
    );
    const bodyBefore = readWorldVertex(body, bodyVertex);

    const active = eyePairs[activeIndex];
    const targetQuaternion = new THREE.Quaternion();
    setEyeTargetQuaternion(
      baseQuaternions[activeIndex],
      targetQuaternion,
      activeIndex === 0 ? 1 : -1,
      0.5,
    );
    active.pivot.quaternion.copy(targetQuaternion);
    displayFrame.updateWorldMatrix(true, true);

    const after = eyePairs.map(({ meshes }, index) =>
      captureWorldVertices(meshes, localVertices[index]),
    );
    const activeDistances = readVertexDistances(
      before[activeIndex],
      after[activeIndex],
    );
    const passiveIndex = 1 - activeIndex;
    const passiveDistances = readVertexDistances(
      before[passiveIndex],
      after[passiveIndex],
    );
    assert.ok(activeDistances.every((distance) => distance > 0.0001));
    assert.ok(passiveDistances.every((distance) => distance < 1e-8));
    assert.ok(readWorldVertex(body, bodyVertex).distanceTo(bodyBefore) < 1e-8);
  }
});
