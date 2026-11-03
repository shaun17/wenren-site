import type { APIRoute, GetStaticPaths } from "astro";
import { siteConfig } from "../../../config/runtime-site-config";
import { loadSkills, renderSkillManifest, type Skill } from "../../../content/skills";

/** 为 public/skills 下的每个 skill 生成一份文件清单路由；校验失败会直接中断构建。 */
export const getStaticPaths = (() =>
  loadSkills({ origin: siteConfig.origin }).map((skill) => ({
    params: { skill: skill.name },
    props: { skill },
  }))) satisfies GetStaticPaths;

/** 输出单个 skill 的 MANIFEST.txt，列出相对路径与安装位置。 */
export const GET: APIRoute<{ skill: Skill }> = ({ props }) =>
  new Response(renderSkillManifest(props.skill), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
