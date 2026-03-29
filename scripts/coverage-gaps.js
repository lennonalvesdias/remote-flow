import { readFileSync } from 'fs';
const cov = JSON.parse(readFileSync('coverage/coverage-final.json', 'utf8'));
let totalStmts = 0, coveredStmts = 0;
for (const [file, data] of Object.entries(cov)) {
  const fname = file.replace(/\\/g, '/').split('/src/')[1] ?? file;
  const stmts = Object.values(data.s);
  const total = stmts.length;
  const covered = stmts.filter(v => v > 0).length;
  const uncovered = total - covered;
  totalStmts += total;
  coveredStmts += covered;
  if (uncovered > 3) {
    console.log(fname.padEnd(30), 'uncovered:', uncovered, '/', total, '=', Math.round(covered / total * 100) + '%');
  }
}
console.log('');
console.log('TOTAL:', coveredStmts, '/', totalStmts, '=', (coveredStmts / totalStmts * 100).toFixed(2) + '%');
console.log('Need for 90%:', Math.ceil(totalStmts * 0.9), 'covered');
console.log('Still need:', Math.ceil(totalStmts * 0.9) - coveredStmts, 'more statements');
