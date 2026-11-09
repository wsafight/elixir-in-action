interface SearchChapter {
  title: string;
  number: number;
  description: string;
  topics: string[];
  url: string;
  content: string;
}

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
const storage = {
  get(key: string) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} },
};

const themeToggle = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
function syncThemeLabel() {
  themeToggle?.setAttribute('aria-label', document.documentElement.dataset.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
}
syncThemeLabel();
themeToggle?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  storage.set('elixir-theme', theme);
  syncThemeLabel();
});

// 每次打开章节都回到顶部；带 #anchor 的导航保留锚点跳转
if (!window.location.hash) window.scrollTo(0, 0);

// 目录栏滚动位置恢复由 Sidebar 的内联脚本在首帧前完成，这里只负责持续记录
const bookNav = document.querySelector<HTMLElement>('.book-nav');
function saveBookNavScroll() {
  if (!bookNav) return;
  try { sessionStorage.setItem('elixir-nav-scroll', String(bookNav.scrollTop)); } catch {}
}
bookNav?.addEventListener('scroll', saveBookNavScroll, { passive: true });
bookNav?.addEventListener('click', saveBookNavScroll, { capture: true });
window.addEventListener('pagehide', saveBookNavScroll);

const menuToggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
function closeMenu() {
  document.body.classList.remove('menu-open');
  menuToggle?.setAttribute('aria-expanded', 'false');
}
menuToggle?.addEventListener('click', () => {
  const isOpen = document.body.classList.toggle('menu-open');
  menuToggle.setAttribute('aria-expanded', String(isOpen));
});
document.querySelector('[data-menu-close]')?.addEventListener('click', closeMenu);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
document.querySelectorAll('.book-nav a').forEach(link => link.addEventListener('click', closeMenu));

// 鼠标点侧边栏链接时阻止聚焦，否则浏览器会把被截住的链接滚进视野、改变目录位置；
// 触屏不拦截，避免抑制合成 click
let pointerIsMouse = true;
document.addEventListener('pointerdown', event => { pointerIsMouse = event.pointerType === 'mouse'; }, true);
document.querySelectorAll<HTMLAnchorElement>('.book-nav a').forEach(link =>
  link.addEventListener('mousedown', event => { if (pointerIsMouse) event.preventDefault(); }));

const validSlugs = new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-chapter-link]')).map(link => link.dataset.chapterLink!));
let completed: string[] = [];
try {
  const saved: unknown = JSON.parse(storage.get('elixir-completed') || '[]');
  if (Array.isArray(saved)) completed = [...new Set(saved.filter((slug): slug is string => typeof slug === 'string' && validSlugs.has(slug)))];
} catch { completed = []; }

function updateProgress() {
  const count = validSlugs.size;
  const label = document.querySelector('[data-progress-label]');
  const progress = document.querySelector<HTMLElement>('[data-progress-bar]');
  if (label) label.textContent = `${completed.length} / ${count}`;
  if (progress) progress.style.width = `${count ? (completed.length / count) * 100 : 0}%`;
  document.querySelectorAll<HTMLElement>('[data-chapter-link]').forEach(link => link.classList.toggle('is-complete', completed.includes(link.dataset.chapterLink!)));
  const completeButton = document.querySelector<HTMLButtonElement>('[data-mark-complete]');
  if (completeButton) {
    const isComplete = completed.includes(completeButton.dataset.markComplete!);
    completeButton.setAttribute('aria-pressed', String(isComplete));
    completeButton.querySelector('span')!.textContent = isComplete ? '已读 · 点击撤销' : '标记为已读';
    const message = document.querySelector('[data-completion-message]');
    if (message) message.textContent = isComplete ? '又读懂了一点，继续保持好奇。' : '读完了？给自己的学习留个记号。';
  }
}
updateProgress();
document.querySelector<HTMLElement>('[data-mark-complete]')?.addEventListener('click', event => {
  const slug = (event.currentTarget as HTMLElement).dataset.markComplete!;
  completed = completed.includes(slug) ? completed.filter(value => value !== slug) : [...completed, slug];
  storage.set('elixir-completed', JSON.stringify(completed));
  updateProgress();
});

const currentChapter = document.querySelector<HTMLElement>('[data-current-chapter]')?.dataset.currentChapter;
if (currentChapter) storage.set('elixir-last-chapter', currentChapter);
const lastChapter = storage.get('elixir-last-chapter');
const startLink = document.querySelector<HTMLAnchorElement>('[data-start-reading]');
if (startLink && lastChapter && validSlugs.has(lastChapter)) {
  startLink.href = `${base}chapters/${lastChapter}/`;
  startLink.childNodes[0].textContent = '继续阅读';
}

document.querySelectorAll('pre').forEach(pre => {
  if (pre.parentElement?.querySelector('[data-copy]')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'code-wrapper';
  pre.parentNode?.insertBefore(wrapper, pre);
  wrapper.appendChild(pre);
  const button = document.createElement('button');
  button.className = 'copy-button';
  button.dataset.copy = '';
  button.textContent = '复制';
  button.setAttribute('aria-label', '复制代码');
  wrapper.appendChild(button);
});
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  const code = button.parentElement?.querySelector('pre')?.textContent || '';
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = '已复制';
  } catch { button.textContent = '复制失败，请手动复制'; }
  window.setTimeout(() => { button.textContent = '复制'; }, 2200);
}));

const tocLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-toc-link]'));
if (tocLinks.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) tocLinks.forEach(link => link.classList.toggle('active', decodeURIComponent(link.hash.slice(1)) === entry.target.id));
    }
  }, { rootMargin: '-80px 0px -65% 0px' });
  document.querySelectorAll('.prose h2').forEach(heading => observer.observe(heading));
}

const dialog = document.querySelector<HTMLDialogElement>('.search-dialog')!;
const searchInput = document.querySelector<HTMLInputElement>('#book-search')!;
const results = document.querySelector<HTMLElement>('.search-results')!;
let searchData: SearchChapter[] | null = null;
let pendingSearch: Promise<SearchChapter[]> | null = null;
let selectedResult = -1;

async function loadSearch(): Promise<SearchChapter[]> {
  if (searchData) return searchData;
  if (!pendingSearch) pendingSearch = fetch(`${base}search.json`).then(response => {
    if (!response.ok) throw new Error('Search unavailable');
    return response.json() as Promise<SearchChapter[]>;
  });
  try { searchData = await pendingSearch; return searchData; } finally { pendingSearch = null; }
}

async function renderResults() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  selectedResult = -1;
  if (!query) { results.innerHTML = '<p class="search-hint">试试「GenServer」「监督树」或「状态」</p>'; return; }
  results.innerHTML = '<p class="search-hint">正在翻阅全书…</p>';
  try {
    const data = await loadSearch();
    if (searchInput.value.trim().toLocaleLowerCase() !== query) return;
    const terms = query.split(/\s+/);
    const found = data.map(chapter => {
      const title = `${chapter.title} ${chapter.topics.join(' ')}`.toLocaleLowerCase();
      const all = `${title} ${chapter.description} ${chapter.content}`.toLocaleLowerCase();
      return { chapter, score: terms.every(term => all.includes(term)) ? terms.reduce((score, term) => score + (title.includes(term) ? 10 : 1), 0) : 0 };
    }).filter(result => result.score > 0).sort((first, second) => second.score - first.score);
    results.replaceChildren();
    if (!found.length) { results.innerHTML = '<p class="search-hint">没有找到相关内容，试试更短的关键词。</p>'; return; }
    for (const { chapter } of found) {
      const link = document.createElement('a');
      link.className = 'search-result';
      link.href = chapter.url;
      const number = document.createElement('span');
      number.className = 'search-result-number';
      number.textContent = String(chapter.number).padStart(2, '0');
      const content = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = chapter.title;
      const detail = document.createElement('p');
      const match = chapter.content.toLocaleLowerCase().indexOf(terms[0]);
      detail.textContent = match >= 0 ? `…${chapter.content.slice(Math.max(0, match - 22), match + 90).replace(/\s+/g, ' ')}…` : chapter.description;
      content.append(title, detail);
      link.append(number, content);
      results.append(link);
    }
  } catch { if (searchInput.value.trim().toLocaleLowerCase() === query) results.innerHTML = '<p class="search-hint">搜索暂时不可用，请重试或从左侧目录阅读。</p>'; }
}

function openSearch() { closeMenu(); if (!dialog.open) dialog.showModal(); searchInput.focus(); void renderResults(); }
document.querySelectorAll('[data-search-open]').forEach(button => button.addEventListener('click', openSearch));
document.querySelector('[data-search-close]')?.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
searchInput.addEventListener('input', () => { void renderResults(); });
searchInput.addEventListener('keydown', event => {
  const links = Array.from(results.querySelectorAll<HTMLAnchorElement>('a'));
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && links.length) {
    event.preventDefault();
    selectedResult = event.key === 'ArrowDown' ? (selectedResult + 1) % links.length : (selectedResult <= 0 ? links.length - 1 : selectedResult - 1);
    links.forEach((link, index) => link.classList.toggle('selected', index === selectedResult));
    links[selectedResult]?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter' && links.length) { event.preventDefault(); links[Math.max(0, selectedResult)].click(); }
});
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
