import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  clampStickerTranslation,
  clampStickerTranslationAfterViewportResize,
  decayStickerAngularVelocity,
  HOME_STICKER_DEFINITIONS,
  isStickerClickGesture,
  mapStickerPressure,
  normalizeStickerRotation,
  parseStickerDefaultTranslation,
  readOppositeStickerRotationDirection,
  selectStickerClickRotationSpeed,
  selectStickerInitialRotation,
  STICKER_CLICK_ROTATION_SPEEDS,
} from "../src/lib/home-sticker.ts";

/** 位移边界同时覆盖四个方向，并能容忍意外颠倒的边界输入。 */
test("keeps sticker translation inside the visible viewport bounds", () => {
  assert.deepEqual(
    clampStickerTranslation(
      { x: 180, y: -120 },
      { minimumX: -40, maximumX: 90, minimumY: -60, maximumY: 80 },
    ),
    { x: 90, y: -60 },
  );
  assert.deepEqual(
    clampStickerTranslation(
      { x: 5, y: 10 },
      { minimumX: 20, maximumX: -20, minimumY: 30, maximumY: -30 },
    ),
    { x: 5, y: 10 },
  );
});

/** 手机地址栏造成高度变化时保留文档纵向落点，只修正横向越界。 */
test("keeps the document position stable across a scrolled viewport resize", () => {
  assert.deepEqual(
    clampStickerTranslationAfterViewportResize(
      { x: -441, y: 101 },
      {
        minimumX: -260.85,
        maximumX: 0,
        minimumY: 366.75,
        maximumY: 1_025,
      },
    ),
    { x: -260.85, y: 101 },
  );
});

/** 鼠标所在边远离变小、对侧靠近变大，旋转后仍按屏幕落点正确换算。 */
test("maps the pointer position to a stable pressed sticker pose", () => {
  const bounds = { left: 100, top: 50, width: 120, height: 120 };
  assert.deepEqual(mapStickerPressure({ x: 160, y: 110 }, bounds), {
    tiltX: 0,
    tiltY: 0,
  });
  assert.deepEqual(mapStickerPressure({ x: 220, y: 110 }, bounds), {
    tiltX: 0,
    tiltY: 6,
  });
  assert.deepEqual(mapStickerPressure({ x: 100, y: 110 }, bounds), {
    tiltX: 0,
    tiltY: -6,
  });
  assert.deepEqual(mapStickerPressure({ x: 160, y: 50 }, bounds), {
    tiltX: 6,
    tiltY: 0,
  });
  assert.deepEqual(mapStickerPressure({ x: 160, y: 170 }, bounds), {
    tiltX: -6,
    tiltY: 0,
  });

  const cornerPose = mapStickerPressure({ x: 220, y: 50 }, bounds);
  assert.ok(Math.abs(cornerPose.tiltX - Math.SQRT2 * 3) < 0.000_001);
  assert.ok(Math.abs(cornerPose.tiltY - Math.SQRT2 * 3) < 0.000_001);
  assert.ok(Math.hypot(cornerPose.tiltX, cornerPose.tiltY) <= 6);

  const rotatedPose = mapStickerPressure({ x: 220, y: 110 }, bounds, 90);
  assert.ok(Math.abs(rotatedPose.tiltX - 6) < 0.000_001);
  assert.ok(Math.abs(rotatedPose.tiltY) < 0.000_001);
});

/** 六像素内视为点击，超过阈值后拖拽只移动，不再触发旋转。 */
test("separates click rotation from drag movement", () => {
  assert.equal(isStickerClickGesture(0), true);
  assert.equal(isStickerClickGesture(6), true);
  assert.equal(isStickerClickGesture(6.01), false);
  assert.equal(isStickerClickGesture(120), false);
});

/** 点击转速来自随机速度池，并保证相邻两次绝不会选中同一档。 */
test("selects varied random rotation speeds for consecutive clicks", () => {
  assert.equal(selectStickerClickRotationSpeed(0, null), 720);
  assert.equal(selectStickerClickRotationSpeed(1, null), 1_200);

  const first = selectStickerClickRotationSpeed(0.5, null);
  const repeatedRandom = selectStickerClickRotationSpeed(0.5, first);
  assert.equal(first, 960);
  assert.notEqual(repeatedRandom, first);
  assert.ok(STICKER_CLICK_ROTATION_SPEEDS.includes(repeatedRandom));
  assert.equal(selectStickerClickRotationSpeed(1, 1_200), 1_080);
});

/** 点击方向严格逐次翻转，不受随机转速影响。 */
test("alternates click rotation direction every time", () => {
  assert.equal(readOppositeStickerRotationDirection(1), -1);
  assert.equal(readOppositeStickerRotationDirection(-1), 1);
});

/** 惯性阻尼与帧率无关，并始终保持原旋转方向直到停止。 */
test("decays angular velocity consistently across frame rates", () => {
  const oneStep = decayStickerAngularVelocity(900, 1);
  const expectedOneStep = 900 * Math.exp(-2.2);
  let sixtySteps = 900;
  for (let frame = 0; frame < 60; frame += 1) {
    sixtySteps = decayStickerAngularVelocity(sixtySteps, 1 / 60);
  }

  assert.ok(oneStep > 0);
  assert.ok(oneStep < 900);
  assert.ok(Math.abs(oneStep - expectedOneStep) < 0.000_001);
  assert.ok(Math.abs(oneStep - sixtySteps) < 0.000_001);
  assert.ok(decayStickerAngularVelocity(-900, 0.5) < 0);
  assert.equal(normalizeStickerRotation(725), 5);
  assert.equal(normalizeStickerRotation(-725), -5);
  assert.equal(normalizeStickerRotation(360), 0);
});

/** 随机初始角度被限制在克制范围内，并允许测试注入确定结果。 */
test("maps random values to bounded initial sticker rotations", () => {
  assert.equal(selectStickerInitialRotation(-1), -10);
  assert.equal(selectStickerInitialRotation(0), -10);
  assert.equal(selectStickerInitialRotation(0.25), -5);
  assert.equal(selectStickerInitialRotation(0.5), 0);
  assert.equal(selectStickerInitialRotation(0.75), 5);
  assert.equal(selectStickerInitialRotation(1), 10);
  assert.equal(selectStickerInitialRotation(2), 10);
});

/** 严格 CSP 会禁用服务端内联样式，因此默认槽位必须能从数据属性独立恢复。 */
test("parses CSP-safe default sticker positions", () => {
  assert.deepEqual(parseStickerDefaultTranslation("-360", "18"), {
    x: -360,
    y: 18,
  });
  assert.deepEqual(parseStickerDefaultTranslation(undefined, "invalid"), {
    x: 0,
    y: 0,
  });
});

/** 七张贴纸按视觉顺序共享连续槽位与层级，新增素材不会把队列额外撑宽。 */
test("keeps the seven-sticker queue ordered and compact", () => {
  assert.deepEqual(
    HOME_STICKER_DEFINITIONS.map((sticker) => ({
      id: sticker.id,
      x: sticker.initialXPercent,
      y: sticker.initialYPercent,
      layer: sticker.initialLayer,
    })),
    [
      { id: "memo-logo", x: -360, y: 0, layer: 1 },
      { id: "petly", x: -300, y: -6, layer: 2 },
      { id: "owl-reader", x: -240, y: 4, layer: 3 },
      { id: "green-orbit", x: -180, y: 12, layer: 4 },
      { id: "blonde-avatar", x: -120, y: 8, layer: 5 },
      { id: "pagecomet", x: -60, y: -2, layer: 6 },
      { id: "mcdonald", x: 0, y: 18, layer: 7 },
    ],
  );
});

/** 计算单位贴纸在另一张贴纸下方时的轴对齐覆盖率。 */
const calculatePlacementOverlap = (lowerSticker, upperSticker) => {
  const overlapWidth = Math.max(
    0,
    100 -
      Math.abs(
        lowerSticker.initialXPercent - upperSticker.initialXPercent,
      ),
  );
  const overlapHeight = Math.max(
    0,
    100 -
      Math.abs(
        lowerSticker.initialYPercent - upperSticker.initialYPercent,
      ),
  );
  return (overlapWidth * overlapHeight) / 10_000;
};

/** 默认错落队列中每张贴纸只与相邻层相交，覆盖面积稳定少于一半。 */
test("keeps every default sticker overlap below one half", () => {
  for (const lowerSticker of HOME_STICKER_DEFINITIONS) {
    const upperStickers = HOME_STICKER_DEFINITIONS.filter(
      (candidate) => candidate.initialLayer > lowerSticker.initialLayer,
    );
    const overlappingStickers = upperStickers.filter(
      (candidate) => calculatePlacementOverlap(lowerSticker, candidate) > 0,
    );

    assert.ok(
      overlappingStickers.length <= 1,
      `${lowerSticker.id} 默认状态不应同时被多张贴纸遮挡`,
    );
    const coverage = overlappingStickers.reduce(
      (total, candidate) =>
        total + calculatePlacementOverlap(lowerSticker, candidate),
      0,
    );
    assert.ok(coverage <= 0.5, `${lowerSticker.id} 默认覆盖率为 ${coverage}`);
  }
});

/** 把旋转后的正方形贴纸换算为保守的轴对齐包围盒。 */
const createRotatedPlacementBounds = (sticker, rotation) => {
  const radians = (rotation * Math.PI) / 180;
  const size = 100 * (Math.abs(Math.cos(radians)) + Math.abs(Math.sin(radians)));
  const centerX = sticker.initialXPercent + 50;
  const centerY = sticker.initialYPercent + 50;
  return {
    left: centerX - size / 2,
    right: centerX + size / 2,
    top: centerY - size / 2,
    bottom: centerY + size / 2,
    width: size,
    height: size,
  };
};

/** 用横向扫描计算多个矩形落在基础矩形内的联合覆盖面积，避免重复区域被多算。 */
const calculateRectangleUnionArea = (base, covers) => {
  const clipped = covers
    .map((cover) => ({
      left: Math.max(base.left, cover.left),
      right: Math.min(base.right, cover.right),
      top: Math.max(base.top, cover.top),
      bottom: Math.min(base.bottom, cover.bottom),
    }))
    .filter((cover) => cover.right > cover.left && cover.bottom > cover.top);
  const xCoordinates = [
    ...new Set(clipped.flatMap((cover) => [cover.left, cover.right])),
  ].sort((left, right) => left - right);
  let area = 0;

  for (let index = 0; index < xCoordinates.length - 1; index += 1) {
    const left = xCoordinates[index];
    const right = xCoordinates[index + 1];
    const intervals = clipped
      .filter((cover) => cover.left < right && cover.right > left)
      .map((cover) => [cover.top, cover.bottom])
      .sort((first, second) => first[0] - second[0]);
    let coveredHeight = 0;
    let intervalStart = null;
    let intervalEnd = null;

    for (const [top, bottom] of intervals) {
      if (intervalStart === null) {
        intervalStart = top;
        intervalEnd = bottom;
      } else if (top <= intervalEnd) {
        intervalEnd = Math.max(intervalEnd, bottom);
      } else {
        coveredHeight += intervalEnd - intervalStart;
        intervalStart = top;
        intervalEnd = bottom;
      }
    }
    if (intervalStart !== null) coveredHeight += intervalEnd - intervalStart;
    area += (right - left) * coveredHeight;
  }
  return area;
};

/** 随机角度达到正负十度边界时，所有更高层贴纸的联合包围盒仍不能盖住一半。 */
test("keeps rotated default sticker coverage below one half", () => {
  const representativeAngles = [-10, 0, 10];
  let maximumCoverage = 0;

  /** 穷举七张贴纸的代表角度组合，覆盖范围端点与不旋转状态。 */
  const verifyRotationCombination = (rotations) => {
    if (rotations.length < HOME_STICKER_DEFINITIONS.length) {
      for (const angle of representativeAngles) {
        verifyRotationCombination([...rotations, angle]);
      }
      return;
    }

    const bounds = HOME_STICKER_DEFINITIONS.map((sticker, index) => ({
      sticker,
      bounds: createRotatedPlacementBounds(sticker, rotations[index]),
    }));
    for (const lower of bounds) {
      const upperBounds = bounds
        .filter(
          (candidate) =>
            candidate.sticker.initialLayer > lower.sticker.initialLayer,
        )
        .map((candidate) => candidate.bounds);
      const coverage =
        calculateRectangleUnionArea(lower.bounds, upperBounds) /
        (lower.bounds.width * lower.bounds.height);
      maximumCoverage = Math.max(maximumCoverage, coverage);
    }
  };

  verifyRotationCombination([]);
  assert.ok(maximumCoverage <= 0.5, `最大联合覆盖率为 ${maximumCoverage}`);
});

/** 三张品牌方卡只透明外部画布并保留完整圆角底板，其余贴纸继续使用自由轮廓。 */
const CARD_STICKER_IDS = new Set(["petly", "green-orbit", "pagecomet"]);
/** 锁定三张方卡共享的透明蒙版，防止圆角附近的白边被局部误删。 */
const CARD_STICKER_ALPHA_HASH =
  "45fc932845c77b5b3c9cc85430a406a95e706dd7b3c4f81411148e0ab5c224b2";

/** 七张公开贴纸必须符合各自轮廓契约与内容哈希，并共同控制在轻量首屏预算内。 */
test("ships seven compact sticker assets with intentional silhouettes", async () => {
  assert.equal(HOME_STICKER_DEFINITIONS.length, 7);
  assert.equal(
    new Set(HOME_STICKER_DEFINITIONS.map((sticker) => sticker.id)).size,
    7,
  );
  assert.equal(
    new Set(HOME_STICKER_DEFINITIONS.map((sticker) => sticker.asset)).size,
    7,
  );
  const shippedStickerFiles = (await readdir(
    new URL("../public/stickers/", import.meta.url),
  ))
    .filter((file) => /\.(?:png|webp)$/.test(file))
    .sort();
  const definedStickerFiles = HOME_STICKER_DEFINITIONS.map((sticker) =>
    sticker.asset.split("/").at(-1),
  ).sort();
  assert.deepEqual(shippedStickerFiles, definedStickerFiles);

  let totalBytes = 0;
  for (const sticker of HOME_STICKER_DEFINITIONS) {
    const assetUrl = new URL(`../public${sticker.asset}`, import.meta.url);
    const [body, file] = await Promise.all([
      readFile(assetUrl),
      stat(assetUrl),
    ]);
    const metadata = await sharp(body).metadata();
    const expectedHash = sticker.asset.match(/-([a-f0-9]{12})\.(?:png|webp)$/)?.[1];
    const { data, info } = await sharp(body)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let visiblePixels = 0;
    const alphaMask = Buffer.alloc(info.width * info.height);
    let minimumVisibleX = info.width;
    let minimumVisibleY = info.height;
    let maximumVisibleX = -1;
    let maximumVisibleY = -1;
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const alphaIndex = (y * info.width + x) * info.channels + 3;
        alphaMask[y * info.width + x] = data[alphaIndex];
        if (data[alphaIndex] <= 8) continue;
        visiblePixels += 1;
        minimumVisibleX = Math.min(minimumVisibleX, x);
        minimumVisibleY = Math.min(minimumVisibleY, y);
        maximumVisibleX = Math.max(maximumVisibleX, x);
        maximumVisibleY = Math.max(maximumVisibleY, y);
      }
    }
    const visibleRatio = visiblePixels / (info.width * info.height);

    totalBytes += file.size;
    assert.equal(metadata.width, sticker.width);
    assert.equal(metadata.height, sticker.height);
    assert.ok(file.size < 50 * 1024, `${sticker.id} 应小于 50 KiB`);
    assert.equal(
      createHash("sha256").update(body).digest("hex").slice(0, 12),
      expectedHash,
    );

    if (CARD_STICKER_IDS.has(sticker.id)) {
      assert.equal(metadata.hasAlpha, true, `${sticker.id} 应使用透明外部画布`);
      assert.equal(
        createHash("sha256").update(alphaMask).digest("hex"),
        CARD_STICKER_ALPHA_HASH,
        `${sticker.id} 应使用完整一致的圆角透明蒙版`,
      );
      assert.ok(visibleRatio > 0.94, `${sticker.id} 不能被抠成零散图形`);
      assert.ok(visibleRatio < 0.98, `${sticker.id} 圆角外侧必须保持透明`);
      assert.ok(
        maximumVisibleX - minimumVisibleX + 1 >= info.width * 0.98,
        `${sticker.id} 卡片横向轮廓不能被缩小`,
      );
      assert.ok(
        maximumVisibleY - minimumVisibleY + 1 >= info.height * 0.98,
        `${sticker.id} 卡片纵向轮廓不能被缩小`,
      );

      /** 读取指定坐标的 RGBA，统一验证透明角、完整底板和白色边框。 */
      const readPixel = (x, y) => {
        const offset = (y * info.width + x) * info.channels;
        return {
          red: data[offset],
          green: data[offset + 1],
          blue: data[offset + 2],
          alpha: data[offset + 3],
        };
      };
      const cornerOrigins = [
        [0, 0],
        [info.width - 3, 0],
        [0, info.height - 3],
        [info.width - 3, info.height - 3],
      ];
      for (const [originX, originY] of cornerOrigins) {
        for (let y = originY; y < originY + 3; y += 1) {
          for (let x = originX; x < originX + 3; x += 1) {
            assert.ok(
              readPixel(x, y).alpha <= 8,
              `${sticker.id} 四角外部画布必须完全透明`,
            );
          }
        }
      }

      const insetX = Math.ceil(info.width * 0.08);
      const insetY = Math.ceil(info.height * 0.08);
      let internalTransparentPixels = 0;
      for (let y = insetY; y < info.height - insetY; y += 1) {
        for (let x = insetX; x < info.width - insetX; x += 1) {
          if (readPixel(x, y).alpha < 247) internalTransparentPixels += 1;
        }
      }
      assert.equal(
        internalTransparentPixels,
        0,
        `${sticker.id} 卡片内部不能被挖空`,
      );

      const edgeInset = Math.round(info.width * 0.01);
      const edgeMidpoints = [
        [Math.floor(info.width / 2), edgeInset],
        [info.width - 1 - edgeInset, Math.floor(info.height / 2)],
        [Math.floor(info.width / 2), info.height - 1 - edgeInset],
        [edgeInset, Math.floor(info.height / 2)],
      ];
      for (const [x, y] of edgeMidpoints) {
        const pixel = readPixel(x, y);
        assert.ok(pixel.alpha >= 247, `${sticker.id} 白色边框不能被删除`);
        assert.ok(
          Math.min(pixel.red, pixel.green, pixel.blue) > 200,
          `${sticker.id} 四边中点应保留明亮边框`,
        );
      }
    } else {
      assert.equal(metadata.hasAlpha, true, `${sticker.id} 应保留透明轮廓`);
      assert.ok(visibleRatio > 0.1, `${sticker.id} 不能小到难以辨认`);
      assert.ok(visibleRatio < 0.9, `${sticker.id} 不应退化成矩形底图`);
    }
  }
  assert.ok(totalBytes < 160 * 1024, "七张贴纸首屏总量应小于 160 KiB");
});

/** 组件拆分位移、旋转与压感三层，并明确拖拽和点击互斥语义。 */
test("wires drag-only movement and click-only rotation", async () => {
  const [component, interaction, styles, homepage] = await Promise.all([
    readFile(
      new URL("../src/components/HomeSticker.astro", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/lib/home-sticker.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/styles/home-sticker.css", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/pages/index.astro", import.meta.url), "utf8"),
  ]);

  assert.match(component, /HOME_STICKER_DEFINITIONS\.map/);
  assert.match(component, /data-home-sticker-deck/);
  assert.match(component, /data-sticker-id/);
  assert.match(component, /data-sticker-default-x/);
  assert.match(component, /data-sticker-default-y/);
  assert.doesNotMatch(component, /\sstyle=/);
  assert.match(component, /home-sticker-spin/);
  assert.match(component, /home-sticker-surface/);
  assert.match(
    component,
    /拖动或使用方向键后停在当前位置并可任意覆盖其他贴纸；单击以随机速度旋转，方向逐次交替/,
  );
  assert.match(component, /draggable="false"/);
  assert.match(homepage, /<HomeSticker \/>/);
  assert.match(component, /initHomeStickerDeck/);
  assert.match(interaction, /selectStickerClickRotationSpeed/);
  assert.match(interaction, /selectStickerInitialRotation\(random\(\)\)/);
  assert.match(interaction, /querySelectorAll<HTMLElement>/);
  assert.match(interaction, /bringStickerToFront/);
  assert.match(interaction, /orderedStickers\.push\(activeSticker\)/);
  assert.match(interaction, /sticker\.addEventListener\("focus"/);
  assert.match(interaction, /KEYBOARD_MOVE_STEP_LARGE/);
  assert.match(interaction, /ArrowUp/);
  assert.match(interaction, /restoreResponsiveDefaultTranslation/);
  assert.match(interaction, /sticker\.dataset\.stickerDefaultX/);
  assert.match(
    interaction,
    /sticker\.style\.setProperty\("--sticker-layer", String\(initialLayer\)\)/,
  );
  assert.match(interaction, /--sticker-layer/);
  assert.match(interaction, /readOppositeStickerRotationDirection/);
  assert.match(interaction, /isStickerClickGesture\(maximumPointerTravel\)/);
  assert.match(interaction, /hasDragged = hasDragged \|\|/);
  assert.match(interaction, /requestAnimationFrame\(inertiaFrame\)/);
  assert.match(interaction, /const ANGULAR_DAMPING = 2\.2/);
  assert.match(interaction, /const MAX_INERTIA_DURATION_MS = 2_400/);
  assert.match(
    interaction,
    /now - startTime >= MAX_INERTIA_DURATION_MS/,
  );
  assert.match(
    interaction,
    /startInertialRotation\(speed \* nextClickRotationDirection\)[\s\S]*readOppositeStickerRotationDirection/,
  );
  assert.match(interaction, /stopMotionPreservingPose/);
  assert.match(interaction, /keepPoseInsidePageWidth/);
  assert.match(interaction, /clampStickerTranslationAfterViewportResize/);
  assert.match(interaction, /stopRotationPreservingAngle/);
  assert.match(
    interaction,
    /if \(hasDragged\)[\s\S]*translationOrigin\.x \+ event\.clientX - pointerOrigin\.x[\s\S]*renderTranslation\(\);[\s\S]*finishPointerInteraction\(\);/,
  );
  assert.match(
    interaction,
    /querySelector<HTMLElement>\("\.home-sticker-spin"\)/,
  );
  assert.doesNotMatch(interaction, /translation\s*=\s*\{\s*x:\s*0,\s*y:\s*0\s*\};/);
  assert.doesNotMatch(
    interaction,
    /estimateStickerPointerVelocity|calculateStickerAngularVelocity|recordPointerSamples|handleDocumentPointerDown|handleWheel|settleRotation|readStickerRestRotation|returnTranslationHome|stopMotionAndReturnHome|keepPoseInsideViewport/,
  );
  assert.match(styles, /\.home-sticker-spin/);
  assert.match(styles, /pointer-events:\s*auto/);
  assert.match(styles, /memo-logo[\s\S]*clip-path:\s*inset\(19% 0\)/);
  assert.match(styles, /z-index:\s*var\(--sticker-layer\)/);
  assert.match(styles, /isolation:\s*isolate/);
  assert.match(styles, /perspective\(24rem\)/);
  assert.match(
    styles,
    /transition:\s*transform 240ms cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
  );
  assert.match(styles, /transform-origin:\s*center/);
  assert.match(styles, /\.home-sticker-spin::before[\s\S]*pointer-events:\s*auto/);
  assert.match(
    styles,
    /\.home-sticker\.is-spinning\.is-pointer-over \.home-sticker-surface[\s\S]*transition-duration:\s*0ms, 140ms/,
  );
  assert.match(styles, /outline:\s*none/);
  assert.match(styles, /touch-action:\s*none/);
  assert.doesNotMatch(
    styles,
    /home-sticker-seesaw|infinite|scale\(|translateZ\(\s*-/,
  );
});

/** 最终静态产物只在首页加载贴纸，内页不会承担无关装饰与交互脚本。 */
test("renders all seven stickers only in the built homepage", async () => {
  const [homepage, headers, builtFiles] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/_headers", import.meta.url), "utf8"),
    readdir(new URL("../dist/", import.meta.url), { recursive: true }),
  ]);

  const renderedStickers = homepage.match(
    /<button\b(?=[^>]*\bdata-home-sticker(?:\s|>))[^>]*>/g,
  );
  assert.equal(renderedStickers?.length, 7);
  assert.match(homepage, /data-home-sticker-deck/);
  for (const sticker of HOME_STICKER_DEFINITIONS) {
    const renderedSticker = renderedStickers?.find((tag) =>
      tag.includes(`data-sticker-id="${sticker.id}"`),
    );
    assert.ok(renderedSticker, `${sticker.id} 应完整输出为贴纸按钮`);
    assert.match(
      renderedSticker,
      new RegExp(`data-sticker-default-x="${sticker.initialXPercent}"`),
    );
    assert.match(
      renderedSticker,
      new RegExp(`data-sticker-default-y="${sticker.initialYPercent}"`),
    );
    assert.match(
      renderedSticker,
      new RegExp(`data-sticker-layer="${sticker.initialLayer}"`),
    );
    assert.doesNotMatch(renderedSticker, /\sstyle=/);
    assert.match(homepage, new RegExp(sticker.asset.replaceAll("/", "\\/")));
    await access(new URL(`../dist${sticker.asset}`, import.meta.url));
  }

  const otherHtmlFiles = builtFiles.filter(
    (file) => file.endsWith(".html") && file !== "index.html",
  );
  for (const file of otherHtmlFiles) {
    const html = await readFile(new URL(`../dist/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(html, /data-home-sticker/);
    for (const sticker of HOME_STICKER_DEFINITIONS) {
      assert.doesNotMatch(html, new RegExp(sticker.asset.replaceAll("/", "\\/")));
    }
  }
  assert.match(
    headers,
    /\/stickers\/\*\s+Cache-Control: public, max-age=31536000, immutable/,
  );
  assert.match(
    headers,
    /Content-Security-Policy:[^\n]*style-src 'self'(?:;|\n)/,
  );
});
