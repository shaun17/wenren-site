import type { APIRoute } from "astro";
import { siteConfig } from "../../config/runtime-site-config";
import { loadSkills, renderSkillsIndex } from "../../content/skills";

/** 构建时扫描 public/skills 生成 skill 总索引，agent 用 curl 读取它发现全部 skill。 */
export const GET: APIRoute = () =>
  new Response(renderSkillsIndex(loadSkills({ origin: siteConfig.origin })), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
