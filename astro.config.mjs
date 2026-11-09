import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://wsafight.github.io',
  base: '/elixir-in-action',
  output: 'static',
  trailingSlash: 'always',
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: true,
    },
  },
});
