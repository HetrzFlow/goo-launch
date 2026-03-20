import './theme.css';
import { renderNav } from './auth';
import { marked } from 'marked';

renderNav();

interface DocEntry {
  file: string;
  label: string;
  langPair?: string; // group key for EN/CN pairs
}

const DOCS: DocEntry[] = [
  { file: 'README.md', label: 'Index' },
  { file: 'ARCHITECTURE.md', label: 'Architecture (EN)', langPair: 'arch' },
  { file: 'ARCHITECTURE_CN.md', label: 'Architecture (CN)', langPair: 'arch' },
  { file: 'MODULES_SPEC.md', label: 'Modules (EN)', langPair: 'modules' },
  { file: 'MODULES_SPEC_CN.md', label: 'Modules (CN)', langPair: 'modules' },
  { file: 'SETUP_TEST.md', label: 'Setup & Test (EN)', langPair: 'setup' },
  { file: 'SETUP_TEST_CN.md', label: 'Setup & Test (CN)', langPair: 'setup' },
  { file: 'TEST_GUIDE.md', label: 'Test Guide (EN)', langPair: 'test' },
  { file: 'TEST_GUIDE_CN.md', label: 'Test Guide (CN)', langPair: 'test' },
  { file: 'DESIGN-agent-interaction.md', label: 'Agent Interaction Design' },
  { file: 'bsc-llm-router-support-by-agent-wallet.md', label: 'BSC LLM Router' },
  { file: 'FINANCE_MIGRATION_TODO.md', label: 'Finance Migration' },
  { file: 'optimals.md', label: 'Optimals' },
  { file: 'scaffolding.md', label: 'Scaffolding' },
  { file: 'TARGET-E2E.md', label: 'Target E2E' },
];

const sidebar = document.getElementById('docs-sidebar')!;
const content = document.getElementById('docs-content')!;

// Build sidebar
for (const doc of DOCS) {
  const a = document.createElement('a');
  a.href = `#${doc.file}`;
  a.textContent = doc.label;
  a.dataset.file = doc.file;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    loadDoc(doc.file);
    window.history.replaceState(null, '', `#${doc.file}`);
  });
  sidebar.appendChild(a);
}

// Load initial doc from hash or default to README
const initialFile = window.location.hash.slice(1) || 'README.md';
loadDoc(initialFile);

async function loadDoc(file: string): Promise<void> {
  // Update active sidebar link
  sidebar.querySelectorAll('a').forEach(a => {
    a.classList.toggle('active', a.dataset.file === file);
  });

  content.innerHTML = '<div class="docs-loading">Loading...</div>';

  try {
    const resp = await fetch(`/docs/${file}`);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    let md = await resp.text();

    // Fix relative links to other docs — make them navigate within this page
    md = md.replace(/\]\(\.\/([^)]+\.md)\)/g, '](#$1)');

    const html = await marked.parse(md);
    content.innerHTML = html;

    // Intercept clicks on internal doc links
    content.querySelectorAll('a[href^="#"]').forEach(a => {
      const href = a.getAttribute('href');
      if (href && href.endsWith('.md')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const target = href.slice(1);
          loadDoc(target);
          window.history.replaceState(null, '', `#${target}`);
        });
      }
    });

    // Scroll to top
    content.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch (err) {
    content.innerHTML = `<p style="color:#e05050">Failed to load ${file}: ${(err as Error).message}</p>`;
  }
}
