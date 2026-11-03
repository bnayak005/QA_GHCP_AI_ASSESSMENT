export interface QualityFinding {
  document: string;
  message: string;
}

export function definitionIds(text: string, prefix: string): string[] {
  return [...text.matchAll(new RegExp(`^\\|\\s*(${prefix}-\\d{2})\\s*\\|`, 'gm'))].map(
    (match) => match[1]!,
  );
}

export function markdownFindings(document: string, text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const fail = (message: string) => findings.push({ document, message });
  if (!text.trim()) fail('Document is empty.');
  if ((text.match(/^# /gm) ?? []).length !== 1) fail('Expected one document title.');
  if (text.includes('\uFFFD'))
    fail('Contains a replacement character indicating damaged encoding.');
  let fence: string | null = null;
  let columns: number | null = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      columns = null;
      continue;
    }
    if (fence) continue;
    if (line.startsWith('|')) {
      const count = line.split(/(?<!\\)\|/).length;
      if (columns !== null && columns !== count)
        fail(`Table column mismatch at line ${index + 1}.`);
      columns = count;
    } else columns = null;
    if (/^\s*(TODO|TBD|FIXME|PLACEHOLDER)\s*[:.!]?\s*$/i.test(line))
      fail(`Unresolved placeholder at line ${index + 1}.`);
  }

  if (fence) fail('Unclosed code fence.');
  return findings;
}

export function headingAnchors(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
      match[1]!
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .trim()
        .replace(/\s/g, '-'),
    ),
  );
}

export function referenceFindings(
  document: string,
  text: string,
  known: ReadonlySet<string>,
): QualityFinding[] {
  const refs = new Set(text.match(/\b(?:AC|FR|NFR|BR|AT|OQ|DR|DD)-\d{2}\b/g) ?? []);
  return [...refs]
    .filter((ref) => !known.has(ref))
    .map((ref) => ({ document, message: `Undefined traceability reference ${ref}.` }));
}

export function taskGraphFindings(text: string): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/).filter((line) => /^\|\s*T\d{2}\s*\|/.test(line))) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [id = '', priority, status, dependencies = '', description, owner] = cells;
    const fail = (message: string) =>
      findings.push({ document: 'impl-plan.md', message: `${id}: ${message}` });
    if (seen.has(id)) fail('Duplicate task ID.');
    if (!['P0', 'P1'].includes(priority ?? '')) fail('Missing supported priority.');
    if (!description || !owner) fail('Missing task description or owner.');
    if (dependencies === 'None') {
      if (status !== 'Ready')
        fail('Independent prerequisite must be marked Ready in the planning baseline.');
    } else {
      if (status !== 'Blocked')
        fail('Dependent task must be marked Blocked in the planning baseline.');
      for (const dep of dependencies.split(/,\s*/)) {
        if (!seen.has(dep))
          fail(`Missing or non-preceding dependency ${dep}; order is not topological.`);
      }
    }
    seen.add(id);
  }
  if (seen.size !== 29)
    findings.push({
      document: 'impl-plan.md',
      message: `Expected the approved 29-task baseline; found ${seen.size}.`,
    });
  return findings;
}
