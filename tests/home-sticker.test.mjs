import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  clampStickerTranslation,
  decayStickerAngularVelocity,
  isStickerClickGesture,
  mapStickerPressure,
  readOppositeStickerRotationDirection,
  readStickerRestRotation,
  selectStickerClickRotationSpeed,
  STICKER_CLICK_ROTATION_SPEEDS,
} from "../src/lib/home-sticker.ts";

const stickerAssetUrl = new URL(
  "../public/stickers/mcdonald-logo-sticker-705aee4ab869.png",
  import.meta.url,
);

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

/** 鼠标所在边向下、反方向成为支点，中心落点则保持水平。 */
test("maps the pointer position to a stable pressed sticker pose", () => {
  const bounds = { left: 100, top: 50, width: 120, height: 120 };
  assert.deepEqual(mapStickerPressure({ x: 160, y: 110 }, bounds), {
    tiltX: -0,
    tiltY: 0,
    originX: 50,
    originY: 50,
  });
  assert.deepEqual(mapStickerPressure({ x: 220, y: 50 }, bounds), {
    tiltX: 6,
    tiltY: 6,
    originX: 14,
    originY: 86,
  });
  assert.deepEqual(mapStickerPressure({ x: 100, y: 170 }, bounds), {
    tiltX: -6,
    tiltY: -6,
    originX: 86,
    originY: 14,
  });
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
  let sixtySteps = 900;
  for (let frame = 0; frame < 60; frame += 1) {
    sixtySteps = decayStickerAngularVelocity(sixtySteps, 1 / 60);
  }

  assert.ok(oneStep > 0);
  assert.ok(oneStep < 900);
  assert.ok(Math.abs(oneStep - sixtySteps) < 0.000_001);
  assert.ok(decayStickerAngularVelocity(-900, 0.5) < 0);
  assert.equal(readStickerRestRotation(539), 360);
  assert.equal(readStickerRestRotation(721), 720);
  assert.equal(readStickerRestRotation(410, 1), 720);
  assert.equal(readStickerRestRotation(410, -1), 360);
  assert.equal(readStickerRestRotation(-410, -1), -720);
  assert.equal(readStickerRestRotation(-410, 1), -360);
});

/** 公开资产必须保留透明通道与稳定内容哈希，同时控制首屏下载体积。 */
test("ships a compact transparent sticker asset", async () => {
  const [body, file] = await Promise.all([
    readFile(stickerAssetUrl),
    stat(stickerAssetUrl),
  ]);
  const metadata = await sharp(body).metadata();

  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.hasAlpha, true);
  assert.ok(file.size < 50 * 1024, "贴纸首屏资源应小于 50 KiB");
  assert.equal(
    createHash("sha256").update(body).digest("hex").slice(0, 12),
    "705aee4ab869",
  );
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

  assert.match(component, /data-home-sticker/);
  assert.match(component, /home-sticker-spin/);
  assert.match(component, /home-sticker-surface/);
  assert.match(
    component,
    /拖动后松开自动归位；单击以随机速度旋转，方向逐次交替/,
  );
  assert.match(component, /draggable="false"/);
  assert.match(homepage, /<HomeSticker \/>/);
  assert.match(interaction, /selectStickerClickRotationSpeed/);
  assert.match(interaction, /Math\.random\(\)/);
  assert.match(interaction, /readOppositeStickerRotationDirection/);
  assert.match(interaction, /isStickerClickGesture\(maximumPointerTravel\)/);
  assert.match(interaction, /hasDragged = hasDragged \|\|/);
  assert.match(interaction, /requestAnimationFrame\(inertiaFrame\)/);
  assert.match(interaction, /returnTranslationHome\(\);/);
  assert.doesNotMatch(
    interaction,
    /estimateStickerPointerVelocity|calculateStickerAngularVelocity|recordPointerSamples|handleDocumentPointerDown|handleWheel/,
  );
  assert.match(styles, /\.home-sticker-spin/);
  assert.match(styles, /perspective\(26rem\)/);
  assert.match(styles, /outline:\s*none/);
  assert.match(styles, /touch-action:\s*none/);
  assert.doesNotMatch(styles, /home-sticker-seesaw|infinite/);
});

/** 最终静态产物只在首页加载贴纸，内页不会承担无关装饰与交互脚本。 */
test("renders the sticker only in the built homepage", async () => {
  const [homepage, avatarPage, headers] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/avatar/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/_headers", import.meta.url), "utf8"),
    access(
      new URL(
        "../dist/stickers/mcdonald-logo-sticker-705aee4ab869.png",
        import.meta.url,
      ),
    ),
  ]);

  assert.match(homepage, /data-home-sticker/);
  assert.match(homepage, /\/stickers\/mcdonald-logo-sticker-705aee4ab869\.png/);
  assert.doesNotMatch(avatarPage, /data-home-sticker|mcdonald-logo-sticker/);
  assert.match(
    headers,
    /\/stickers\/\*\s+Cache-Control: public, max-age=31536000, immutable/,
  );
});
