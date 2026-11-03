import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import {
  SkillValidationError,
  loadSkills,
  renderSkillManifest,
  renderSkillsIndex,
} from "../src/content/skills.ts";
import { resolveSourceDir, syncSkills } from "../scripts/sync-skills.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const ORIGIN = "https://wenren.cc";
const SUBAGENT_DESCRIPTION =
  "用 Claude Code 原生 subagent 组团队：拆分派活、批次验收、圆桌协商。用户要求开 subagent、分头做、并行处理、组 team、圆桌讨论时使用。";
// 生成文本的基线：与改为构建生成之前手写的 public/skills/index.txt 和 MANIFEST.txt 逐字节相同。
const BASELINE_INDEX = [
  "# wenren 的 Claude Code skills",
  "# 源码：https://github.com/shaun17/wenren-skills",
  "# 每个 skill 的文件清单在 <名称>/MANIFEST.txt。",
  "",
  "subagent-team  用 Claude Code 原生 subagent 组团队：拆分派活、批次验收、圆桌协商。  https://wenren.cc/skills/subagent-team/MANIFEST.txt",
  "",
].join("\n");
const BASELINE_MANIFEST = [
  "# subagent-team 文件清单",
  "# 每行：<相对本目录的路径>  <保存位置>。保存位置里的 ~ 指用户主目录（Windows 为 %USERPROFILE%）。",
  "# 每个文件最后一行是 <!-- end: subagent-team/<路径> -->，用来确认下载完整。",
  "SKILL.md                  ~/.claude/skills/subagent-team/SKILL.md",
  "references/dispatch.md    ~/.claude/skills/subagent-team/references/dispatch.md",
  "references/discussion.md  ~/.claude/skills/subagent-team/references/discussion.md",
  "references/worker.md      ~/.claude/skills/subagent-team/references/worker.md",
  "",
].join("\n");

const temporaryDirectories = [];

/** 创建测试专用临时目录，测试结束统一删除。 */
const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "skills-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

/** 测试完成后清理全部临时目录。 */
after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** 写入一个带正确 end 标记的文件，content 不含末行标记。 */
const writeSkillFile = async (root, skill, file, content, { endMarker = true } = {}) => {
  const filePath = path.join(root, skill, file);
  await mkdir(path.dirname(filePath), { recursive: true });
  const marker = endMarker ? `\n<!-- end: ${skill}/${file} -->\n` : "\n";
  await writeFile(filePath, `${content}${marker}`);
};

/** 写入一个最小的合法 skill；references 按给定顺序在 SKILL.md 中被链接。 */
const writeSkill = async (
  root,
  name,
  { description = `${name} 的说明。何时使用。`, references = [], frontmatterName = name } = {},
) => {
  const links = references.map((file) => `- 读 [${file}](${file})。`).join("\n");
  const frontmatter = [
    "---",
    ...(frontmatterName ? [`name: ${frontmatterName}`] : []),
    ...(description ? [`description: ${description}`] : []),
    "---",
  ].join("\n");
  await writeSkillFile(root, name, "SKILL.md", `${frontmatter}\n\n# ${name}\n\n${links}`);
  for (const file of references) await writeSkillFile(root, name, file, `# ${file}`);
};

/** 以临时 skill 复现基线：链接顺序为 dispatch、discussion、worker，与字母序不同。 */
test("generates index and manifest byte-identical to the hand-written baseline", async () => {
  const root = await createTemporaryDirectory();
  await writeSkill(root, "subagent-team", {
    description: SUBAGENT_DESCRIPTION,
    references: ["references/dispatch.md", "references/discussion.md", "references/worker.md"],
  });

  const skills = loadSkills({ root, origin: ORIGIN });
  assert.equal(renderSkillsIndex(skills), BASELINE_INDEX);
  assert.equal(renderSkillManifest(skills[0]), BASELINE_MANIFEST);
});

/** 仓库内的真实 skill 必须通过校验，并输出与基线一致的格式。 */
test("loads the published skills from public/skills", () => {
  const skills = loadSkills({ root: path.join(projectRoot, "public", "skills"), origin: ORIGIN });
  const skill = skills.find((item) => item.name === "subagent-team");
  assert.ok(skill, "public/skills 应包含 subagent-team");
  assert.equal(skill.files[0].path, "SKILL.md");
  assert.equal(skill.sourceUrl, "https://github.com/shaun17/wenren-skills/tree/main/subagent-team");
  assert.equal(skill.manifestUrl, "https://wenren.cc/skills/subagent-team/MANIFEST.txt");
  assert.ok(!skill.body.startsWith("---"), "正文应去掉 frontmatter");
  assert.ok(!skill.body.includes("<!-- end:"), "正文应去掉 end 标记");
  for (const file of skill.files) {
    assert.equal(file.installPath, `~/.claude/skills/subagent-team/${file.path}`);
    assert.equal(file.url, `${ORIGIN}/skills/subagent-team/${file.path}`);
    assert.ok(file.bytes > 0);
  }
});

/** 多个 skill 按名称排序，名称列按最长名称加两个空格对齐，清单列同理。 */
test("sorts multiple skills by name and aligns columns", async () => {
  const root = await createTemporaryDirectory();
  await writeSkill(root, "zeta", { description: "最后一个。补充说明。" });
  await writeSkill(root, "a-very-long-skill", {
    description: "No Chinese full stop here",
    references: ["references/b.md", "docs/a-long-reference-name.md"],
  });
  await writeSkillFile(root, "a-very-long-skill", "references/unlinked.md", "# 未链接");

  const skills = loadSkills({ root, origin: "https://example.com" });
  assert.deepEqual(skills.map((skill) => skill.name), ["a-very-long-skill", "zeta"]);

  const lines = renderSkillsIndex(skills).split("\n");
  assert.deepEqual(lines.slice(4), [
    "a-very-long-skill  No Chinese full stop here  https://example.com/skills/a-very-long-skill/MANIFEST.txt",
    "zeta               最后一个。  https://example.com/skills/zeta/MANIFEST.txt",
    "",
  ]);

  const manifest = renderSkillManifest(skills[0]).split("\n").slice(3);
  assert.deepEqual(manifest, [
    "SKILL.md                       ~/.claude/skills/a-very-long-skill/SKILL.md",
    "references/b.md                ~/.claude/skills/a-very-long-skill/references/b.md",
    "docs/a-long-reference-name.md  ~/.claude/skills/a-very-long-skill/docs/a-long-reference-name.md",
    "references/unlinked.md         ~/.claude/skills/a-very-long-skill/references/unlinked.md",
    "",
  ]);
});

/** 断言加载会以 SkillValidationError 失败，且报错包含指定片段。 */
const assertValidationFails = (root, ...fragments) => {
  assert.throws(
    () => loadSkills({ root }),
    (error) => {
      assert.ok(error instanceof SkillValidationError);
      for (const fragment of fragments) assert.match(error.message, new RegExp(fragment));
      return true;
    },
  );
};

/** 缺 end 标记、缺字段、名称不符、手写 MANIFEST 都必须让构建失败。 */
test("rejects skills that break the publishing contract", async () => {
  const missingMarker = await createTemporaryDirectory();
  await writeSkill(missingMarker, "demo", { references: ["references/a.md"] });
  await writeSkillFile(missingMarker, "demo", "references/a.md", "# a", { endMarker: false });
  assertValidationFails(missingMarker, "demo/references/a.md", "<!-- end: demo/references/a.md -->");

  const wrongMarker = await createTemporaryDirectory();
  await writeSkill(wrongMarker, "demo");
  await writeFile(
    path.join(wrongMarker, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: 说明。\n---\n\n正文\n<!-- end: other/SKILL.md -->\n",
  );
  assertValidationFails(wrongMarker, "demo/SKILL.md");

  const missingDescription = await createTemporaryDirectory();
  await writeSkill(missingDescription, "demo", { description: "" });
  assertValidationFails(missingDescription, "缺少 description");

  const missingName = await createTemporaryDirectory();
  await writeSkill(missingName, "demo", { frontmatterName: "" });
  assertValidationFails(missingName, "缺少 name");

  const mismatchedName = await createTemporaryDirectory();
  await writeSkill(mismatchedName, "demo", { frontmatterName: "other" });
  assertValidationFails(mismatchedName, "与目录名「demo」不一致");

  const handWrittenManifest = await createTemporaryDirectory();
  await writeSkill(handWrittenManifest, "demo");
  await writeSkillFile(handWrittenManifest, "demo", "MANIFEST.txt", "# 手写");
  assertValidationFails(handWrittenManifest, "由构建自动生成");

  const strayRootFile = await createTemporaryDirectory();
  await writeSkill(strayRootFile, "demo");
  await writeFile(path.join(strayRootFile, "index.txt"), "# 手写索引\n");
  assertValidationFails(strayRootFile, "根目录只能包含 skill 目录");
});

/** 同步脚本应新增、更新、删除文件与整个 skill，忽略点文件，重复运行无差异。 */
test("mirrors skills from the source directory", async () => {
  const source = await createTemporaryDirectory();
  const target = await createTemporaryDirectory();
  await writeSkill(source, "alpha", { references: ["references/keep.md", "references/drop.md"] });
  await writeSkill(source, "beta");
  await writeSkillFile(source, "alpha", ".DS_Store", "ignored");
  await mkdir(path.join(source, ".git"), { recursive: true });
  await writeFile(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(source, "README.md"), "# 源码仓库说明\n");

  const first = await syncSkills({ sourceDir: source, targetDir: target });
  assert.deepEqual(first.skills, ["alpha", "beta"]);
  assert.deepEqual(first.added.sort(), [
    "alpha/SKILL.md",
    "alpha/references/drop.md",
    "alpha/references/keep.md",
    "beta/SKILL.md",
  ]);
  assert.ok(!existsSync(path.join(target, "alpha", ".DS_Store")));
  assert.ok(!existsSync(path.join(target, ".git")));
  assert.ok(!existsSync(path.join(target, "README.md")));

  // 修改一个文件、删除一个文件和整个 beta，再新增 gamma。
  await writeSkillFile(source, "alpha", "references/keep.md", "# keep v2");
  await rm(path.join(source, "alpha", "references", "drop.md"));
  await writeSkill(source, "alpha", { references: ["references/keep.md"] });
  await writeSkillFile(source, "alpha", "references/keep.md", "# keep v2");
  await rm(path.join(source, "beta"), { recursive: true });
  await writeSkill(source, "gamma");

  const second = await syncSkills({ sourceDir: source, targetDir: target });
  assert.deepEqual(second.skills, ["alpha", "gamma"]);
  assert.deepEqual(second.added, ["gamma/SKILL.md"]);
  assert.deepEqual(second.updated.sort(), ["alpha/SKILL.md", "alpha/references/keep.md"]);
  assert.deepEqual(second.removed.sort(), ["alpha/references/drop.md", "beta/"]);
  assert.match(
    await readFile(path.join(target, "alpha", "references", "keep.md"), "utf8"),
    /keep v2/,
  );
  assert.ok(!existsSync(path.join(target, "beta")));

  const third = await syncSkills({ sourceDir: source, targetDir: target });
  assert.deepEqual([third.added, third.updated, third.removed], [[], [], []]);
});

/** 同步后的校验与构建一致：源里的违规 skill 会让同步失败。 */
test("validates synchronized skills and requires an explicit source directory", async () => {
  const source = await createTemporaryDirectory();
  const target = await createTemporaryDirectory();
  await writeSkill(source, "broken", { frontmatterName: "other" });
  await assert.rejects(
    syncSkills({ sourceDir: source, targetDir: target }),
    SkillValidationError,
  );

  assert.equal(resolveSourceDir([], {}), null);
  assert.equal(resolveSourceDir(["--", "/tmp/skills"], {}), path.resolve("/tmp/skills"));
  assert.equal(
    resolveSourceDir([], { SKILLS_SOURCE_DIR: "/tmp/env-skills" }),
    path.resolve("/tmp/env-skills"),
  );
});
