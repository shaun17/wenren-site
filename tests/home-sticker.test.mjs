import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  clampStickerTranslation,
  normalizeStickerRotation,
} from "../src/lib/home-sticker.ts";

const stickerAssetUrl = new URL(
  "../public/stickers/mcdonald-logo-sticker-705aee4ab869.png",
  import.meta.url,
);

/** 旋转始终使用短角度表达，连续滚轮操作不会累积出超大 transform。 */
test("normalizes sticker rotation around a stable signed range", () => {
  assert.equal(normalizeStickerRotation(0), 0);
  assert.equal(normalizeStickerRotation(181), -179);
  assert.equal(normalizeStickerRotation(-181), 179);
  assert.equal(normalizeStickerRotation(540), -180);
});

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

/** 组件将移动、旋转与悬停摆动拆层，并提供鼠标和键盘操作说明。 */
test("wires the homepage sticker interaction and seesaw motion", async () => {
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
  assert.match(component, /draggable="false"/);
  assert.match(component, /Shift 拖动或滚轮旋转/);
  assert.match(homepage, /<HomeSticker \/>/);
  assert.match(interaction, /setPointerCapture\(event\.pointerId\)/);
  assert.match(interaction, /addEventListener\("blur", returnHome/);
  assert.match(interaction, /handleDocumentPointerDown/);
  assert.match(interaction, /sticker\.blur\(\)/);
  assert.match(interaction, /lostpointercapture/);
  assert.match(interaction, /passive: false/);
  assert.match(styles, /@keyframes home-sticker-seesaw/);
  assert.match(styles, /touch-action:\s*none/);
  assert.match(styles, /transition:\s*transform 1\.35s/);
});

/** 最终静态产物只在首页加载贴纸，内页不会承担无关装饰与交互脚本。 */
test("renders the sticker only in the built homepage", async () => {
  const [homepage, avatarPage] = await Promise.all([
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/avatar/index.html", import.meta.url), "utf8"),
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
});
