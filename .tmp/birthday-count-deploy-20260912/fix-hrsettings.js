const fs = require('fs');
const path = 'src/components/hr/HRSettings.tsx';
const lines = fs.readFileSync(path, 'utf8').split('\n');
// Keep lines 1-33 (0-32), then skip to the single return block. Find the last "return (" that is followed by "<div className=\"space-y-6\">" and keep from there to the matching "});" and "}".
const out = [];
let i = 0;
// Add lines 1-33 (indices 0-32) but remove "// x" line
while (i < 33) {
  if (lines[i].trim() === '// x') { i++; continue; }
  if (lines[i].trim() === '// load;') { i++; continue; }
  out.push(lines[i]);
  i++;
}
// Skip duplicate loadAll/useEffect blocks until we hit "  return (" before the good JSX
while (i < lines.length && !(lines[i].trim().startsWith('return (') && lines[i+1] && lines[i+1].includes('space-y-6'))) {
  if (lines[i].trim().startsWith('return (') && i > 100) break;
  i++;
}
// Now take from this return to the closing "}" of the function (before any "const loadAll" that appears after)
while (i < lines.length) {
  out.push(lines[i]);
  if (lines[i].trim() === '}' && lines[i+1] && lines[i+1].trim().startsWith('const loadAll')) break;
  i++;
}
fs.writeFileSync(path, out.join('\n'));
console.log('Fixed. Total lines:', out.length);
