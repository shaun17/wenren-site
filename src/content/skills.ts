import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 单个 skill 文件的安装与下载信息。 */
export interface SkillFile {
  /** 相对 skill 目录的路径，统一使用正斜杠，例如 `references/worker.md`。 */
  path: string;
  /** agent 安装时的保存位置，例如 `~/.claude/skills/<name>/references/worker.md`。 */
  installPath: string;
  /** 站内路径，例如 `/skills/<name>/references/worker.md`。 */
  publicPath: string;
  /** 带站点域名的完整下载地址。 */
  url: string;
  /** 文件字节数。 */
  bytes: number;
}

/** 从 `public/skills/<name>/` 读出的一个完整 skill。 */
export interface Skill {
  /** frontmatter 中的 name，与目录名一致。 */
  name: string;
  /** frontmatter 中 description 的全文。 */
  description: string;
  /** description 的第一句（含句号），用于索引与卡片摘要。 */
  summary: string;
  /** SKILL.md 去掉 frontmatter 与末尾 end 标记后的 markdown 正文。 */
  body: string;
  /** frontmatter 全部键值，便于页面读取将来新增的简单字段。 */
  frontmatter: Readonly<Record<string, string>>;
  /** 文件清单，顺序与 MANIFEST.txt 一致：SKILL.md 在前，其余按 SKILL.md 首次链接顺序，未链接的按路径排序。 */
  files: SkillFile[];
  /** 站内 MANIFEST 路径，例如 `/skills/<name>/MANIFEST.txt`。 */
  manifestPath: string;
  /** 带站点域名的 MANIFEST 地址。 */
  manifestUrl: string;
  /** 源码仓库中该 skill 的目录地址。 */
  sourceUrl: string;
}

/** 读取 skill 的可选参数；根目录可注入以便测试。 */
export interface LoadSkillsOptions {
  /** skill 根目录，默认是构建工作目录下的 `public/skills`。 */
  root?: string;
  /** 生成完整地址所用的站点域名，默认是正式站域名。 */
  origin?: string;
}

/** skill 文件或元数据不符合约定时抛出，构建与同步脚本据此失败。 */
export class SkillValidationError extends Error {
  /** 汇总全部违规项，一次报出，避免逐个修复逐个重跑。 */
  constructor(readonly problems: readonly string[]) {
    super(`skill 校验失败：\n- ${problems.join("\n- ")}`);
    this.name = "SkillValidationError";
  }
}

/** 正式站域名；页面和端点应传入构建期站点配置中的 origin。 */
export const DEFAULT_SKILLS_ORIGIN = "https://wenren.cc";
/** 源码仓库地址，所有 skill 都维护在这个仓库的顶层目录。 */
export const SKILLS_SOURCE_REPOSITORY = "https://github.com/shaun17/wenren-skills";
/** 公开目录内的 skill 根路径（相对构建工作目录）。 */
export const SKILLS_PUBLIC_DIR = path.join("public", "skills");
/** MANIFEST 由构建生成，skill 目录内不允许存在同名文件，否则会与生成结果冲突。 */
const MANIFEST_FILE_NAME = "MANIFEST.txt";
/** skill 目录名同时出现在 URL 与安装路径中，只允许安全字符。 */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 生成某个文件必需的最后一行，用来让 agent 确认下载完整。 */
export const createEndMarker = (skillName: string, filePath: string): string =>
  `<!-- end: ${skillName}/${filePath} -->`;

/** 判断是否为点文件或点目录（.git、.DS_Store 等），这类条目既不发布也不同步。 */
export const isHiddenEntry = (name: string): boolean => name.startsWith(".");

/** 递归列出目录内全部非隐藏普通文件，返回正斜杠分隔的相对路径。 */
export const listSkillDirectoryFiles = (directory: string): string[] => {
  const files: string[] = [];
  /** 深度优先遍历，跳过隐藏条目，保证结果与平台路径分隔符无关。 */
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (isHiddenEntry(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) files.push(relative);
    }
  };
  walk(directory, "");
  return files.sort(compareCodePoints);
};

/** 按码点比较字符串，排序结果不受运行环境语言设置影响。 */
const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** 拆出 SKILL.md 的 frontmatter，只支持现有的单行 `key: value` 形式。 */
const parseFrontmatter = (
  source: string,
): { frontmatter: Record<string, string>; content: string } | null => {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (!line.trim() || line.trimStart().startsWith("#") || separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    // 允许值被成对引号包裹，读取时去掉引号本身。
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    frontmatter[key] = value;
  }
  return { frontmatter, content: source.slice(match[0].length) };
};

/** 取 description 的第一句：到第一个中文句号为止（含句号），没有句号时用全文。 */
export const summarizeDescription = (description: string): string => {
  const end = description.indexOf("。");
  return end < 0 ? description : description.slice(0, end + 1);
};

/** 返回文本的最后一行；文件以换行结尾时忽略这个结尾换行。 */
const readLastLine = (text: string): string => {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  // 兼容 CRLF 换行，比较前去掉行尾的回车符。
  return trimmed.slice(trimmed.lastIndexOf("\n") + 1).replace(/\r$/, "");
};

/** 按 SKILL.md 中 markdown 链接首次出现的顺序排列文件，未被链接的文件按路径排在后面。 */
const orderSkillFiles = (files: readonly string[], body: string): string[] => {
  const firstLinkIndex = new Map<string, number>();
  // 链接目标去掉锚点后与相对路径比对，例如 `references/dispatch.md#回答提问`。
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0].replace(/^\.\//, "");
    if (!firstLinkIndex.has(target)) firstLinkIndex.set(target, match.index ?? 0);
  }
  const rank = (file: string) => firstLinkIndex.get(file) ?? Number.POSITIVE_INFINITY;
  const others = files
    .filter((file) => file !== "SKILL.md")
    .sort((left, right) => rank(left) - rank(right) || compareCodePoints(left, right));
  return ["SKILL.md", ...others];
};

/** 读取并校验单个 skill 目录，违规项追加进 problems 而不是立即抛出。 */
const readSkill = (
  root: string,
  directoryName: string,
  origin: string,
  problems: string[],
): Skill | null => {
  const directory = path.join(root, directoryName);
  const label = `public/skills/${directoryName}`;
  if (!SKILL_NAME_PATTERN.test(directoryName)) {
    problems.push(`${label}：目录名只能包含小写字母、数字、点、下划线和连字符`);
    return null;
  }

  const filePaths = listSkillDirectoryFiles(directory);
  if (!filePaths.includes("SKILL.md")) {
    problems.push(`${label}：缺少 SKILL.md`);
    return null;
  }
  if (filePaths.includes(MANIFEST_FILE_NAME)) {
    problems.push(`${label}/${MANIFEST_FILE_NAME}：由构建自动生成，不应放进 skill 目录`);
  }

  // 每个文件末行必须是对应的 end 标记，agent 依赖它判断下载是否被截断。
  const contents = new Map<string, Buffer>();
  for (const filePath of filePaths) {
    const content = readFileSync(path.join(directory, filePath));
    contents.set(filePath, content);
    const expected = createEndMarker(directoryName, filePath);
    if (readLastLine(content.toString("utf8")) !== expected) {
      problems.push(`${label}/${filePath}：最后一行应为 ${expected}`);
    }
  }

  const skillSource = (contents.get("SKILL.md") ?? Buffer.alloc(0))
    .toString("utf8")
    .replace(/\r\n/g, "\n");
  const parsed = parseFrontmatter(skillSource);
  if (!parsed) {
    problems.push(`${label}/SKILL.md：开头缺少 --- 包裹的 frontmatter`);
    return null;
  }
  const { frontmatter, content } = parsed;
  const { name = "", description = "" } = frontmatter;
  if (!name) problems.push(`${label}/SKILL.md：frontmatter 缺少 name`);
  if (!description) problems.push(`${label}/SKILL.md：frontmatter 缺少 description`);
  if (name && name !== directoryName) {
    problems.push(`${label}/SKILL.md：frontmatter name「${name}」与目录名「${directoryName}」不一致`);
  }

  // 正文去掉末尾 end 标记和首尾空行，保留中间的原始 markdown。
  const endMarker = createEndMarker(directoryName, "SKILL.md");
  const trimmedContent = content.trimEnd();
  const body = (
    trimmedContent.endsWith(endMarker)
      ? trimmedContent.slice(0, -endMarker.length)
      : trimmedContent
  ).trim();

  const skillPath = `/skills/${directoryName}/`;
  const files = orderSkillFiles(filePaths, body).map((filePath) => {
    const publicPath = `${skillPath}${filePath}`;
    return {
      path: filePath,
      installPath: `~/.claude/skills/${directoryName}/${filePath}`,
      publicPath,
      url: new URL(publicPath, origin).href,
      bytes: contents.get(filePath)?.length ?? 0,
    };
  });
  const manifestPath = `${skillPath}${MANIFEST_FILE_NAME}`;

  return {
    name: directoryName,
    description,
    summary: summarizeDescription(description),
    body,
    frontmatter,
    files,
    manifestPath,
    manifestUrl: new URL(manifestPath, origin).href,
    sourceUrl: `${SKILLS_SOURCE_REPOSITORY}/tree/main/${directoryName}`,
  };
};

/**
 * 扫描 skill 根目录下每个非隐藏子目录，校验后按名称排序返回。
 * 任一 skill 违规都会抛出 SkillValidationError，让构建或同步失败。
 */
export const loadSkills = ({
  root = path.resolve(SKILLS_PUBLIC_DIR),
  origin = DEFAULT_SKILLS_ORIGIN,
}: LoadSkillsOptions = {}): Skill[] => {
  const problems: string[] = [];
  const skills: Skill[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root).filter((entry) => !isHiddenEntry(entry));
  } catch (error) {
    throw new SkillValidationError([`无法读取 skill 根目录 ${root}：${String(error)}`]);
  }

  for (const entry of entries.sort(compareCodePoints)) {
    // 根目录只放 skill 目录；索引等文本由构建生成，手写文件会与生成结果冲突。
    if (!statSync(path.join(root, entry)).isDirectory()) {
      problems.push(`public/skills/${entry}：根目录只能包含 skill 目录`);
      continue;
    }
    const skill = readSkill(root, entry, origin, problems);
    if (skill) skills.push(skill);
  }

  if (problems.length > 0) throw new SkillValidationError(problems);
  return skills;
};

/** 按名称取单个 skill，不存在时返回 undefined，供详情页使用。 */
export const getSkill = (name: string, options: LoadSkillsOptions = {}): Skill | undefined =>
  loadSkills(options).find((skill) => skill.name === name);

/** 生成两列以上的对齐文本行：除最后一列外，每列宽度为该列最长值加两个空格。 */
const alignColumns = (rows: readonly (readonly string[])[]): string[] => {
  const widths = rows[0]?.slice(0, -1).map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)) + 2,
  ) ?? [];
  return rows.map((row) =>
    row.map((cell, column) => (column < widths.length ? cell.padEnd(widths[column]) : cell)).join(""),
  );
};

/** 生成 `/skills/index.txt`：agent 通过 curl 读取它来发现全部 skill。 */
export const renderSkillsIndex = (skills: readonly Skill[]): string => {
  const header = [
    "# wenren 的 Claude Code skills",
    `# 源码：${SKILLS_SOURCE_REPOSITORY}`,
    "# 每个 skill 的文件清单在 <名称>/MANIFEST.txt。",
    "",
  ];
  // 只对名称列补齐；摘要含中日文时等宽假设不成立，摘要与地址之间固定两个空格。
  const nameWidth = Math.max(0, ...skills.map((skill) => skill.name.length)) + 2;
  const lines = [...skills]
    .sort((left, right) => compareCodePoints(left.name, right.name))
    .map((skill) => `${skill.name.padEnd(nameWidth)}${skill.summary}  ${skill.manifestUrl}`);
  return `${[...header, ...lines].join("\n")}\n`;
};

/** 生成 `/skills/<name>/MANIFEST.txt`：每行是相对路径与安装位置。 */
export const renderSkillManifest = (skill: Skill): string => {
  const header = [
    `# ${skill.name} 文件清单`,
    "# 每行：<相对本目录的路径>  <保存位置>。保存位置里的 ~ 指用户主目录（Windows 为 %USERPROFILE%）。",
    `# 每个文件最后一行是 ${createEndMarker(skill.name, "<路径>")}，用来确认下载完整。`,
  ];
  const rows = alignColumns(skill.files.map((file) => [file.path, file.installPath]));
  return `${[...header, ...rows].join("\n")}\n`;
};
