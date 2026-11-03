import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { siteConfig } from "../src/config/site-config.mjs";
import { loadSkills } from "../src/content/skills.ts";

const buildRoot = new URL("../dist/", import.meta.url);
const skills = loadSkills({ origin: siteConfig.origin });
const subagentTeam = skills.find((skill) => skill.name === "subagent-team");

/** 读取构建后的最终 HTML，断言用户实际拿到的页面而不是 Astro 源码。 */
const readRoute = (route) => readFile(new URL(route, buildRoot), "utf8");

/** 去掉 JSON-LD 结构化数据脚本，剩下的内联脚本才违反 CSP。 */
const removeStructuredDataScripts = (html) =>
  html.replace(
    /<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );

/** 截取 SKILL.md 正文渲染容器，避免页面其他区域干扰正文断言。 */
const extractSkillBody = (html) =>
  html.match(/<div class="notion-content skill-body"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/)?.[1] ?? "";

/** 去掉标签和 HTML 注释，得到浏览器会显示的纯文本。 */
const toVisibleText = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "");

/** 把 HTML 实体还原成字符，方便直接比对命令文本。 */
const decodeEntities = (text) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** 两个页面都必须满足 CSP：无内联脚本、无 style 属性、无 style 元素。 */
const assertCspSafe = (html, label) => {
  assert.doesNotMatch(
    removeStructuredDataScripts(html),
    /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i,
    `${label} 不应包含内联脚本`,
  );
  assert.doesNotMatch(html, /\sstyle=/i, `${label} 不应包含 style 属性`);
  assert.doesNotMatch(html, /<style\b/i, `${label} 不应包含 style 元素`);
};

test("skill 数据中存在用于页面断言的 subagent-team", () => {
  assert.ok(subagentTeam, "public/skills 下应有 subagent-team");
});

test("列表页列出全部 skill，并在页尾给出机器入口", async () => {
  const html = await readRoute("skills/index.html");

  assert.match(html, /<h1>Skills<\/h1>/);
  assert.doesNotMatch(html, /noindex/);
  for (const skill of skills) {
    assert.ok(html.includes(`href="/skills/${skill.name}/"`), `应链接到 ${skill.name} 详情页`);
    assert.ok(html.includes(skill.summary), `应展示 ${skill.name} 的摘要`);
  }
  assert.ok(html.includes('href="/skills/index.txt"'), "应链接纯文本索引");
  assert.ok(html.includes('href="https://github.com/shaun17/wenren-skills"'), "应链接源码仓库");
  assertCspSafe(html, "列表页");
});

test("详情页按顺序给出三种安装方式，命令与地址正确", async () => {
  const html = await readRoute("skills/subagent-team/index.html");
  const text = decodeEntities(html);

  assert.match(html, /<h1>subagent-team<\/h1>/);
  assert.ok(text.includes(subagentTeam.description), "应展示 description 全文");
  assert.ok(html.includes(`href="${subagentTeam.sourceUrl}"`), "应链接源码目录");
  assert.ok(html.includes('href="/skills/"'), "应有返回列表的链接");

  const agentPrompt = `读取 ${siteConfig.origin}/skills/subagent-team/MANIFEST.txt，按清单把每个文件下载到对应保存位置，并用每个文件最后一行的 end 标记确认下载完整。`;
  const npxCommand = "npx skills add shaun17/wenren-skills --skill subagent-team -g -a claude-code";
  const gitCommand = "git clone https://github.com/shaun17/wenren-skills";
  const positions = [agentPrompt, npxCommand, gitCommand].map((snippet) => {
    const index = text.indexOf(snippet);
    assert.ok(index >= 0, `详情页应包含：${snippet}`);
    return index;
  });
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, "安装方式顺序应为 agent、npx、git");
  assert.ok(text.includes("~/.claude/skills/subagent-team"), "git 方式应说明放到 ~/.claude/skills/");

  // 每种方式都有复制按钮，并指向页面上可选中的 code 元素。
  const copyTargets = [...html.matchAll(/data-skill-copy="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(copyTargets.length, 3);
  for (const id of copyTargets) {
    assert.match(html, new RegExp(`<code id="${id}">`), `复制按钮目标 ${id} 应存在`);
  }
  assert.match(html, /<script type="module" src="\/_astro\/[^"]+\.js"><\/script>/);
  assertCspSafe(html, "详情页");
});

test("详情页文件清单链接到原始文件与 MANIFEST", async () => {
  const html = await readRoute("skills/subagent-team/index.html");

  assert.ok(html.includes('href="/skills/subagent-team/MANIFEST.txt"'));
  for (const file of subagentTeam.files) {
    assert.ok(
      html.includes(`<a href="/skills/subagent-team/${file.path}">${file.path}</a>`),
      `应链接原始文件：${file.path}`,
    );
    assert.ok(html.includes(file.installPath), `应展示保存位置：${file.installPath}`);
    // 链接的目标文件确实随构建发布。
    await readFile(new URL(`skills/subagent-team/${file.path}`, buildRoot));
  }
});

test("SKILL.md 正文渲染为 HTML，end 标记不可见，相对链接指向原始文件", async () => {
  const html = await readRoute("skills/subagent-team/index.html");
  const body = extractSkillBody(html);

  assert.ok(body, "应找到正文容器");
  // 正文标题整体降一级，页面只保留 skill 名称这一个 h1。
  assert.match(body, /<h2[^>]*>Subagent team<\/h2>/);
  assert.match(body, /<h3[^>]*>/);
  assert.equal(html.match(/<h1\b/g)?.length, 1);
  assert.match(body, /<pre><code>[\s\S]*\.team\/tasks\/T-01\/[\s\S]*<\/code><\/pre>/);
  assert.ok(body.includes('href="references/dispatch.md"'), "相对链接应原样保留，在详情页目录下解析到原始文件");
  assert.doesNotMatch(body, /^---|name: subagent-team/m, "frontmatter 不应进入正文");
  assert.doesNotMatch(body, /end: subagent-team/, "end 标记不应出现在正文");
  assert.doesNotMatch(toVisibleText(html), /end: subagent-team|&lt;!--/, "注释不应以可见文本出现");
});

test("sitemap 包含列表页与每个详情页", async () => {
  const sitemap = await readRoute("sitemap.xml");

  assert.ok(sitemap.includes(`<loc>${siteConfig.origin}/skills/</loc>`));
  for (const skill of skills) {
    assert.ok(sitemap.includes(`<loc>${siteConfig.origin}/skills/${skill.name}/</loc>`));
  }
});
