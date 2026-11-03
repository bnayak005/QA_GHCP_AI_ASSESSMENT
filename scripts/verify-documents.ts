import fs from 'node:fs';
import path from 'node:path';
import { Bank } from '../server/domain.js';
import {
  definitionIds,
  headingAnchors,
  markdownFindings,
  referenceFindings,
  taskGraphFindings,
  type QualityFinding,
} from './document-quality.js';

const rootIndex = process.argv.indexOf('--documents-root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : path.join(process.cwd(), 'docs');
if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(
    'Expected planning documents in docs/. Provide --documents-root with the existing folder containing requirements.md, architecture.md, design-review.md, and impl-plan.md.',
  );
  process.exit(1);
}

const project = process.cwd();
const inputs = [
  ['requirements.md', root],
  ['architecture.md', root],
  ['design-review.md', root],
  ['impl-plan.md', root],
  ['README.md', project],
  ['prototype-decisions.md', project],
] as const;
const documents = new Map<string, string>();
const findings: QualityFinding[] = [];
let checks = 0;
function check(document: string, message: string, valid: boolean) {
  checks++;
  if (!valid) findings.push({ document, message });
}
for (const [name, directory] of inputs) {
  const filename = path.join(directory, name);
  check(name, 'Required output document is missing.', fs.existsSync(filename));
  if (!fs.existsSync(filename)) continue;
  const text = fs.readFileSync(filename, 'utf8');
  documents.set(name, text);
  findings.push(...markdownFindings(name, text));
  checks += 5;
  for (const link of text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^)]+))\)/g)) {
    const target = link[1] ?? link[2] ?? '';
    if (/^[a-z]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue;
    const [file = '', anchor] = target.split('#');
    const linked = file ? path.resolve(directory, decodeURIComponent(file)) : filename;
    check(name, `Broken local link: ${target}`, fs.existsSync(linked));
    if (anchor && fs.existsSync(linked) && linked.endsWith('.md')) {
      check(
        name,
        `Broken document section link: ${target}`,
        headingAnchors(fs.readFileSync(linked, 'utf8')).has(decodeURIComponent(anchor)),
      );
    }
  }
}

const requirements = documents.get('requirements.md') ?? '';
const review = documents.get('design-review.md') ?? '';
const known = new Set<string>();
for (const [prefix, count, text] of [
  ['AC', 5, requirements],
  ['FR', 12, requirements],
  ['NFR', 11, requirements],
  ['BR', 6, requirements],
  ['AT', 10, requirements],
  ['OQ', 8, requirements],
  ['DR', 8, review],
  ['DD', 7, review],
] as const) {
  const ids = definitionIds(text, prefix);
  check(
    prefix.startsWith('D') ? 'design-review.md' : 'requirements.md',
    `Missing, duplicate, or misnumbered ${prefix} definitions.`,
    ids.length === count &&
      new Set(ids).size === count &&
      Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`).every(
        (id) => ids.includes(id),
      ),
  );
  ids.forEach((id) => known.add(id));
}
for (const [name, text] of documents) {
  findings.push(...referenceFindings(name, text, known));
  checks++;
}
const plan = documents.get('impl-plan.md') ?? '';
findings.push(...taskGraphFindings(plan));
checks += 29;
check(
  'impl-plan.md',
  'Planning baseline counts disagree with task rows.',
  (plan.match(/^\|\s*T\d{2}\s*\|\s*P[01]\s*\|\s*Ready\s*\|/gm) ?? []).length === 6 &&
    (plan.match(/^\|\s*T\d{2}\s*\|\s*P[01]\s*\|\s*Blocked\s*\|/gm) ?? []).length === 23,
);

const sections: Record<string, string[]> = {
  'requirements.md': [
    'Functional requirements',
    'Non-functional requirements',
    'Acceptance scenarios and traceability',
    'Assumptions and dependencies',
    'Open questions',
  ],
  'architecture.md': [
    'Key components and responsibilities',
    'Real-time balance updates',
    'Trust boundaries',
    'Decisions and dependencies',
    'Separately approved local prototype',
  ],
  'design-review.md': [
    'Findings and disposition',
    'Agreed design decisions',
    'Outstanding approvals',
    'Validation plan',
  ],
  'impl-plan.md': [
    'Ordered task list',
    'Blockers',
    'Traceability',
    'Separate prototype execution track',
  ],
  'README.md': ['Run on Windows', 'Verify', 'Features', 'Production prerequisites'],
  'prototype-decisions.md': [
    'Approval boundary',
    'API contract',
    'Snapshot consistency and freshness',
    'Production gap',
    'Validation scope',
  ],
};
for (const [name, labels] of Object.entries(sections)) {
  for (const label of labels)
    check(name, `Missing required content: ${label}`, (documents.get(name) ?? '').includes(label));
}
for (let i = 1; i <= 5; i++) {
  const scenario = new RegExp(`^\\|\\s*AT-0${i}\\s*\\|`);
  const row = requirements.split(/\r?\n/).find((line) => scenario.test(line)) ?? '';
  const expected =
    i === 1 ? ['AC-01', 'AC-02'] : i === 2 ? ['AC-05'] : i === 3 || i === 4 ? ['AC-03'] : ['AC-04'];
  check(
    'requirements.md',
    `AT-0${i} is missing its source acceptance-criterion mapping.`,
    expected.every((id) => row.includes(id)),
  );
}
check(
  'requirements.md',
  'Explicit/derived/proposed status or unapproved target boundaries are missing.',
  ['**Explicit:**', '**Derived:**', '**Proposed:**', 'No numeric service-level target'].every(
    (value) => requirements.includes(value),
  ),
);
check(
  'design-review.md',
  'Historical pre-implementation statements are not scoped to their original review.',
  !review.includes('because there is no implementation') && /historical/i.test(review),
);
check(
  'impl-plan.md',
  'Production task baseline must be distinguished from prototype implementation.',
  plan.includes('not a live completion ledger') && !plan.includes('**Current inventory:**'),
);

const apiSource = fs.readFileSync(path.join(project, 'server', 'app.ts'), 'utf8');
const apiDoc = documents.get('prototype-decisions.md') ?? '';
const codeRoutes = new Set(
  [...apiSource.matchAll(/app\.(get|post)\(\s*['"]([^'"]+)['"]/g)].map(
    (match) => `${match[1]!.toUpperCase()} ${match[2]}`,
  ),
);
const docRoutes = new Set(
  [...apiDoc.matchAll(/\|\s*`(GET|POST) ([^`]+)`\s*\|/g)].map((match) => `${match[1]} ${match[2]}`),
);
for (const route of codeRoutes)
  check('prototype-decisions.md', `Undocumented implemented route: ${route}`, docRoutes.has(route));
for (const route of docRoutes)
  check(
    'prototype-decisions.md',
    `Documented route not implemented: ${route}`,
    codeRoutes.has(route),
  );
const defaults = new Bank();
check(
  'README.md',
  'Documented session defaults do not match the runtime.',
  defaults.idleMs === 15 * 60_000 &&
    defaults.absoluteMs === 8 * 60 * 60_000 &&
    /15-minute inactivity and 8-hour absolute expiry/.test(documents.get('README.md') ?? ''),
);
check(
  'prototype-decisions.md',
  'API error contract omits implemented 413/500 outcomes.',
  /413/.test(apiDoc) && /500/.test(apiDoc),
);
check(
  'prototype-decisions.md',
  'Stream high-water-mark documentation incorrectly promises a hard byte cap.',
  !/at most the Node response high-water-mark buffer/.test(apiDoc),
);

const packageJson = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
for (const command of (documents.get('README.md') ?? '').matchAll(/npm\.cmd run ([\w:-]+)/g)) {
  check(
    'README.md',
    `Documented npm script is missing: ${command[1]}`,
    !!packageJson.scripts[command[1]!],
  );
}
for (const name of ['README.md', 'prototype-decisions.md', 'architecture.md', 'impl-plan.md']) {
  const text = documents.get(name) ?? '';
  check(
    name,
    'Missing prototype-vs-production limitation.',
    /prototype/i.test(text) &&
      /production/i.test(text) &&
      /(not|remain|unverified|unimplemented|blocked)/i.test(text),
  );
}

const report = {
  checkedAt: new Date().toISOString(),
  documents: inputs.map(([name]) => name),
  checks,
  findings,
  limitation:
    'Rule-based content/traceability checks complement, not replace, human semantic review. Production integration and approval gates remain open.',
};
fs.mkdirSync(path.join(project, 'test-results'), { recursive: true });
fs.writeFileSync(
  path.join(project, 'test-results', 'documents.json'),
  JSON.stringify(report, null, 2),
);
for (const finding of findings) console.error(`FAIL ${finding.document}: ${finding.message}`);
console.log(
  `Document verification: ${inputs.length} documents, ${checks} checks, ${findings.length} findings.`,
);
if (findings.length) process.exitCode = 1;
