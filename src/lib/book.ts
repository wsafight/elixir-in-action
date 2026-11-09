import type { MarkdownInstance } from 'astro';

export interface Sample {
  label: string;
  path: string;
}

export interface ChapterMeta {
  order: number;
  title: string;
  description: string;
  part: number;
  duration: number;
  topics: string[];
  samples: Sample[];
}

const modules = import.meta.glob<MarkdownInstance<ChapterMeta>>(
  '../content/chapters/*.md',
  { eager: true },
);

export const chapters = Object.entries(modules)
  .map(([path, chapter]) => ({
    ...chapter,
    slug: path.split('/').pop()!.replace(/\.md$/, ''),
    ...chapter.frontmatter,
  }))
  .sort((first, second) => first.order - second.order);

export const parts = [
  { number: 1, title: '语言的底色', description: '表达式、不可变数据与函数。', icon: 'function', color: 'violet' },
  { number: 2, title: '让程序并发起来', description: '把状态交给进程，用消息把它们连起来。', icon: 'process', color: 'blue' },
  { number: 3, title: '让系统可靠运行', description: '接受失败，把恢复设计进系统。', icon: 'tree', color: 'green' },
  { number: 4, title: '从本地走向生产', description: '连接网络、跨越节点，交付一个应用。', icon: 'deploy', color: 'orange' },
  { number: 5, title: '回头看整个系统', description: '把十九个零件拼成一个整体。', icon: 'tree', color: 'violet' },
] as const;

export const repository = 'https://github.com/wsafight/elixir-in-action';
export const repositoryBranch = '3rd-edition';
export const chapterUrl = (slug: string) => `/chapters/${slug}/`;
// 示例源码的对外 slug：去掉 code_samples/ 前缀，路径分隔符换成短横线
export const sampleSlug = (path: string) =>
  path.replace(/^code_samples\//, '').replace(/\.(ex|exs)$/, '').replace(/\//g, '-');
export const sampleUrl = (path: string) => `/code/${sampleSlug(path)}/`;
