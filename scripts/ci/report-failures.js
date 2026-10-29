// Prints each failing mocha test as a GitHub Actions error annotation (annotations are public; raw logs are not).
const r = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const clean = (s) => String(s).replace(/\r?\n/g, ' | ').replace(/::/g, ': :').slice(0, 600);
for (const f of r.failures) console.log(`::error title=${clean(f.fullTitle).replace(/[,:]/g, ' ')}::${clean(f.err && f.err.message)}`);
console.log(`${r.stats.failures} failing / ${r.stats.passes} passing`);
