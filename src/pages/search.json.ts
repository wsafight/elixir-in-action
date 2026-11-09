import { chapters, chapterUrl } from '../lib/book';

export const GET = () => new Response(JSON.stringify(chapters.map(chapter => ({
  title: chapter.title,
  number: chapter.order,
  description: chapter.description,
  topics: chapter.topics,
  url: chapterUrl(chapter.slug),
  content: chapter.rawContent().replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>\[\]]/g, ' '),
}))), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
