import { readFileSync } from 'fs';
const cov = JSON.parse(readFileSync('coverage/coverage-final.json', 'utf8'));

for (const [file, data] of Object.entries(cov)) {
  const fname = file.replace(/\\/g, '/').split('/src/')[1] ?? file;
  const stmts = data.s;
  const stmtMap = data.statementMap;
  const uncovered = Object.entries(stmts)
    .filter(([, count]) => count === 0)
    .map(([id]) => stmtMap[id]?.start?.line)
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (uncovered.length > 3) {
    console.log(`\n=== ${fname} (${uncovered.length} uncovered) ===`);
    console.log('Lines:', uncovered.join(', '));
  }
}
