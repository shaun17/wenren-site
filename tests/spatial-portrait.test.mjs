import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { imageSize } from "image-size";
import * as THREE from "three";
import {
  createPortraitLightRig,
  mapPointerToGaze,
  PORTRAIT_ENVIRONMENT_INTENSITY,
  PORTRAIT_TONE_MAPPING_EXPOSURE,
  setEyeTargetQuaternion,
} from "../src/lib/spatial-avatar-scene.ts";

const modelUrl = new URL(
  "../public/3d/wenren-avatar-617f0102b1df.glb",
  import.meta.url,
);
const posterUrl = new URL(
  "../public/3d/wenren-avatar-poster-bb691bbe0b43.jpg",
  import.meta.url,
);
const mobilePosterUrl = new URL(
  "../public/3d/wenren-avatar-poster-mobile-6b514bf2f2f4.jpg",
  import.meta.url,
);
const MODEL_SHA256 =
  "617f0102b1df6e1fb59eac134a3ba0d97f785a3767ba0a24deb0fc65fd14cda7";
const POSTER_SHA256 =
  "bb691bbe0b43ab9d50ac21e3db0ede7e5d916bfa9897b0a05263fe62fd6b94d8";
const MOBILE_POSTER_SHA256 =
  "6b514bf2f2f416ac7cf8a826de223893f8812438fd4e6280087602f783688b8f";
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
    THREE.MathUtils.degToRad(22),
  );
  const pitch = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    THREE.MathUtils.degToRad(13),
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

/** 空间肖像必须保留同模型海报、动态按需加载和完整资源释放路径。 */
test("keeps the isolated GLB portrait progressive and accessible", async () => {
  const [
    component,
    bootstrap,
    scene,
    styles,
    globalStyles,
    heroStyles,
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
    readFile(new URL("../src/styles/avatar.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/global.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/hero.css", import.meta.url), "utf8"),
    readFile(posterUrl),
    readFile(mobilePosterUrl),
    readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
    readFile(new URL("../dist/avatar/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(component, /<picture class="spatial-portrait-fallback">/);
  assert.match(
    component,
    /srcset="\/3d\/wenren-avatar-poster-mobile-6b514bf2f2f4\.jpg"/,
  );
  assert.match(
    component,
    /src="\/3d\/wenren-avatar-poster-bb691bbe0b43\.jpg"/,
  );
  assert.match(component, /alt=\{`\$\{name\} 的三维人物模型/);
  assert.match(
    component,
    /<canvas[^>]*aria-hidden="true"[^>]*data-spatial-canvas/,
  );
  assert.match(component, /role="status" aria-live="polite"/);
  assert.doesNotMatch(component, /滚动叙事|移动指针控制目光/);

  assert.doesNotMatch(builtHome, /data-spatial-portrait|\/3d\/wenren-avatar-/);
  assert.match(builtAvatar, /data-spatial-portrait/);
  assert.match(
    builtAvatar,
    /src="\/3d\/wenren-avatar-poster-bb691bbe0b43\.jpg"/,
  );
  assert.match(
    builtAvatar,
    /srcset="\/3d\/wenren-avatar-poster-mobile-6b514bf2f2f4\.jpg"/,
  );
  assert.match(builtAvatar, /alt="Alice 的三维人物模型/);
  assert.doesNotMatch(builtAvatar, /滚动叙事|移动指针控制目光/);
  assert.match(
    builtAvatar,
    /<a class="spatial-home-link" href="\/">首页<span class="spatial-home-link-arrow" aria-hidden="true">→<\/span><\/a>/,
  );
  assert.match(
    builtAvatar,
    /<script type="module" src="\/_astro\/[^"]+\.js"><\/script>/,
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
  assert.match(
    scene,
    /fetch\(MODEL_URL, \{\s*credentials: "same-origin",\s*signal,?\s*\}\)/,
  );
  assert.match(scene, /setMeshoptDecoder\(MeshoptDecoder\)/);
  assert.match(scene, /parseAsync\(modelBytes, "\/"\)/);
  assert.match(scene, /wenren-avatar-617f0102b1df\.glb/);
  for (const { meshNames, pivotName } of EYE_CONTRACTS) {
    assert.match(scene, new RegExp(pivotName));
    for (const meshName of meshNames) assert.match(scene, new RegExp(meshName));
  }
  assert.match(scene, /resolveEyePivots/);
  assert.match(scene, /pivot\.parent !== activeScene/);
  assert.match(scene, /mesh instanceof THREE\.Mesh/);
  assert.match(scene, /mesh\.parent === pivot/);
  assert.match(scene, /mapPointerToGaze/);
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
  assert.match(scene, /clamp\(currentModelScale, 0\.96, 1\.18\)/);
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
  assert.match(
    styles,
    /\.spatial-portrait\.is-webgl-ready \.spatial-portrait-canvas/,
  );
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(
    styles,
    /\.spatial-page\.is-spatial-static \.spatial-chapter-build/,
  );
  assert.match(styles, /background:\s*#e8e5db/);
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
    /\.spatial-links\s*\{[^}]*font-size:\s*var\(--information-font-size\)/,
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
