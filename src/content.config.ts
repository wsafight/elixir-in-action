import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const chapters = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/chapters' }),
  schema: z.object({
    order: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string().min(1),
    part: z.number().int().min(1).max(5),
    duration: z.number().positive(),
    topics: z.array(z.string()).min(1),
    samples: z
      .array(
        z.object({
          label: z.string().min(1),
          path: z.string().startsWith('code_samples/'),
        }),
      )
      .min(1),
  }),
});

export const collections = { chapters };
