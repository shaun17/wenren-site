import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isHiddenEntry,
  listSkillDirectoryFiles,
  loadSkills,
} from "../src/content/skills.ts";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DEFAULT_TARGET_DIR = path.join(projectRoot, "public", "skills");
const USAGE = [
  "用法：npm run sync:skills -- <skill 源码仓库目录>",
  "  或：SKILLS_SOURCE_DIR=<skill 源码仓库目录> npm run sync:skills",
  "源目录下每个包含 SKILL.md 的顶层目录都会镜像到 public/skills/<名称>/。",
].join("\n");

/** 列出源目录中所有含 SKILL.md 的顶层非隐藏目录名，按码点排序。 */
const listSourceSkills = async (sourceDir) => {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !isHiddenEntry(entry.name) &&
        existsSync(path.join(sourceDir, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .sort();
};

/** 判断两个文件内容是否逐字节相同；目标不存在时视为不同。 */
const hasSameContent = async (sourceFile, targetFile) => {
  if (!existsSync(targetFile)) return false;
  const [source, target] = await Promise.all([readFile(sourceFile), readFile(targetFile)]);
  return source.equals(target);
};

/** 自底向上删除已经变空的子目录，保留 skill 根目录本身。 */
const removeEmptyDirectories = async (directory, keepRoot = true) => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await removeEmptyDirectories(path.join(directory, entry.name), false);
    }
  }
  if (!keepRoot && (await readdir(directory)).length === 0) await rmdir(directory);
};

/**
 * 把源目录中的 skill 镜像到目标目录：新增、更新内容有变化的文件，
 * 删除源中已不存在的文件与整个 skill 目录；点文件和 .git 不参与同步。
 * 完成后运行与构建相同的校验，违规时抛出 SkillValidationError。
 */
export const syncSkills = async ({ sourceDir, targetDir = DEFAULT_TARGET_DIR }) => {
  const changes = { added: [], updated: [], removed: [] };
  const sourceSkills = await listSourceSkills(sourceDir);
  if (sourceSkills.length === 0) {
    throw new Error(`源目录中没有任何包含 SKILL.md 的顶层目录：${sourceDir}`);
  }
  await mkdir(targetDir, { recursive: true });

  for (const skill of sourceSkills) {
    const sourceSkillDir = path.join(sourceDir, skill);
    const targetSkillDir = path.join(targetDir, skill);
    const sourceFiles = listSkillDirectoryFiles(sourceSkillDir);
    const targetFiles = existsSync(targetSkillDir)
      ? listSkillDirectoryFiles(targetSkillDir)
      : [];

    // 只在内容变化时写入，保持未变文件的时间戳，便于确认“无差异”。
    for (const file of sourceFiles) {
      const sourceFile = path.join(sourceSkillDir, file);
      const targetFile = path.join(targetSkillDir, file);
      if (await hasSameContent(sourceFile, targetFile)) continue;
      (existsSync(targetFile) ? changes.updated : changes.added).push(`${skill}/${file}`);
      await mkdir(path.dirname(targetFile), { recursive: true });
      await copyFile(sourceFile, targetFile);
    }

    // 源里已删除的文件同步删除，并清理随之变空的子目录。
    const sourceFileSet = new Set(sourceFiles);
    for (const file of targetFiles.filter((file) => !sourceFileSet.has(file))) {
      await rm(path.join(targetSkillDir, file));
      changes.removed.push(`${skill}/${file}`);
    }
    await removeEmptyDirectories(targetSkillDir);
  }

  // 目标里有、源里已没有的 skill 目录整体移除；根目录的点文件保持原样。
  const sourceSkillSet = new Set(sourceSkills);
  for (const entry of await readdir(targetDir, { withFileTypes: true })) {
    if (isHiddenEntry(entry.name) || sourceSkillSet.has(entry.name)) continue;
    await rm(path.join(targetDir, entry.name), { recursive: true });
    changes.removed.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }

  const skills = loadSkills({ root: targetDir });
  return { ...changes, skills: skills.map((skill) => skill.name) };
};

/** 读取命令行参数或环境变量中的源目录，缺失时返回 null。 */
export const resolveSourceDir = (argv = process.argv.slice(2), env = process.env) => {
  const value = argv.find((argument) => argument !== "--") ?? env.SKILLS_SOURCE_DIR ?? "";
  return value.trim() ? path.resolve(value.trim()) : null;
};

const isDirectExecution = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isDirectExecution) {
  const sourceDir = resolveSourceDir();
  if (!sourceDir) {
    console.error(`未指定 skill 源目录。\n${USAGE}`);
    process.exit(1);
  }
  try {
    const { added, updated, removed, skills } = await syncSkills({ sourceDir });
    const total = added.length + updated.length + removed.length;
    for (const [label, files] of [["新增", added], ["更新", updated], ["删除", removed]]) {
      for (const file of files) console.log(`${label}：public/skills/${file}`);
    }
    console.log(
      total === 0
        ? `skill 已是最新，无差异（${skills.join("、")}）。`
        : `同步完成：新增 ${added.length}，更新 ${updated.length}，删除 ${removed.length}；校验通过（${skills.join("、")}）。`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
