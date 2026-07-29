import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  calculateStickerAngularVelocity,
  clampStickerTranslation,
  decayStickerAngularVelocity,
  estimateStickerPointerVelocity,
  estimateStickerThrowVelocity,
  mapStickerPressure,
  readStickerRestRotation,
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

/** 最近轨迹能给出释放速度，停住超过采样窗口后则不会误触发惯性。 */
test("estimates only the recent pointer release velocity", () => {
  assert.deepEqual(
    estimateStickerPointerVelocity([
      { x: 20, y: 40, time: 100 },
      { x: 70, y: 20, time: 150 },
    ]),
    { x: 1_000, y: -400 },
  );
  assert.deepEqual(
    estimateStickerPointerVelocity([
      { x: 20, y: 40, time: 100 },
      { x: 20, y: 40, time: 240 },
    ]),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    estimateStickerPointerVelocity([
      { x: 20, y: 40, time: 100 },
      { x: 24, y: 40, time: 110 },
    ]),
    { x: 0, y: 0 },
  );
});

/** 极短的合并手势仍能用整体位移计算速度，慢拖和短点按不会误触发。 */
test("falls back to the whole gesture only for a quick throw", () => {
  assert.deepEqual(
    estimateStickerThrowVelocity(
      [
        { x: 20, y: 40, time: 100 },
        { x: 120, y: 40, time: 108 },
      ],
      { x: 20, y: 40, time: 100 },
      { x: 120, y: 40, time: 108 },
      108,
    ),
    { x: 6_250, y: 0 },
  );
  assert.deepEqual(
    estimateStickerThrowVelocity(
      [
        { x: 20, y: 40, time: 100 },
        { x: 120, y: 40, time: 700 },
      ],
      { x: 20, y: 40, time: 100 },
      { x: 120, y: 40, time: 700 },
      700,
    ),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    estimateStickerThrowVelocity(
      [
        { x: 20, y: 40, time: 100 },
        { x: 28, y: 40, time: 108 },
      ],
      { x: 20, y: 40, time: 100 },
      { x: 28, y: 40, time: 108 },
      108,
    ),
    { x: 0, y: 0 },
  );
  assert.deepEqual(
    estimateStickerThrowVelocity(
      [
        { x: 20, y: 40, time: 100 },
        { x: 120, y: 40, time: 300 },
      ],
      { x: 20, y: 40, time: 100 },
      { x: 120, y: 40, time: 300 },
      120,
    ),
    { x: 0, y: 0 },
  );
});

/** 高采样率输入保留足够时间跨度，不会因单个短帧而丢失最终甩动速度。 */
test("keeps enough high-frequency samples for release velocity", () => {
  const samples = Array.from({ length: 21 }, (_, index) => ({
    x: index * 2,
    y: 0,
    time: 100 + index,
  }));
  assert.deepEqual(estimateStickerPointerVelocity(samples), {
    x: 2_000,
    y: 0,
  });
});

/** 快速甩动会按方向产生角速度，慢速无惯性，高速始终受安全上限约束。 */
test("converts a quick throw into bounded angular velocity", () => {
  const clockwise = calculateStickerAngularVelocity(
    { x: 0, y: 1_000 },
    { x: 50, y: 0 },
    60,
  );
  const counterClockwise = calculateStickerAngularVelocity(
    { x: 0, y: -1_000 },
    { x: 50, y: 0 },
    60,
  );

  assert.ok(clockwise > 600);
  assert.ok(counterClockwise < -600);
  assert.ok(
    calculateStickerAngularVelocity(
      { x: 1_500, y: -200 },
      { x: 50, y: 0 },
      60,
    ) < 0,
  );
  assert.equal(
    calculateStickerAngularVelocity(
      { x: 120, y: 0 },
      { x: 0, y: 0 },
      60,
    ),
    0,
  );
  assert.ok(
    calculateStickerAngularVelocity(
      { x: 1_000, y: 0 },
      { x: 0, y: 0 },
      60,
    ) > 300,
  );
  assert.equal(
    calculateStickerAngularVelocity(
      { x: 20_000, y: 0 },
      { x: 0, y: 0 },
      60,
    ),
    1_200,
  );
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

/** 组件拆分位移、惯性与压感三层，并明确松手归位和快速甩动语义。 */
test("wires release-to-home, inertia, and pointer-pressure layers", async () => {
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
  assert.match(component, /拖动后松开自动归位；快速甩动会惯性旋转/);
  assert.match(component, /draggable="false"/);
  assert.match(homepage, /<HomeSticker \/>/);
  assert.match(interaction, /estimateStickerPointerVelocity/);
  assert.match(interaction, /calculateStickerAngularVelocity/);
  assert.match(interaction, /requestAnimationFrame\(inertiaFrame\)/);
  assert.match(interaction, /returnTranslationHome\(\);/);
  assert.doesNotMatch(interaction, /handleDocumentPointerDown|handleWheel/);
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
