import type { APIRoute } from "astro";
import { siteConfig } from "../../config/runtime-site-config";
import { loadSkills } from "../../content/skills";

/**
 * /skills/ 下的专用 404。Cloudflare Pages 会沿目录向上寻找最近的 404.html，
 * 而 _headers 对 /skills/* 统一声明 text/plain；若沿用站点 HTML 404，浏览器和 curl
 * 都会看到 HTML 源码。这里输出纯文本，并给出可用的索引与清单地址，方便 agent 自行纠正。
 */
export const GET: APIRoute = () => {
  const skills = loadSkills({ origin: siteConfig.origin });
  const lines = [
    "404 Not Found：/skills/ 下没有这个文件。",
    "",
    `全部 skill 的索引：${new URL("/skills/index.txt", siteConfig.origin).href}`,
    ...skills.map((skill) => `${skill.name} 的文件清单：${skill.manifestUrl}`),
    `展示页：${new URL("/skills/", siteConfig.origin).href}`,
  ];
  return new Response(`${lines.join("\n")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
