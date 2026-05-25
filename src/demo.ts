import { parse } from './parser/commands.ts';
import { resolveRoute } from './routing/table.ts';

const input = process.argv.slice(2).join(' ');
if (!input) {
  console.log('usage: npm run demo -- "<whatsapp message>"');
  console.log('example: npm run demo -- "!movie bollywood laapataa ladies"');
  process.exit(1);
}

console.log('Input  :', JSON.stringify(input));
const parsed = parse(input);
console.log('Parsed :', parsed);

if (parsed.kind === 'request') {
  if (parsed.mediaTypeHint === 'ambiguous') {
    console.log('Route  : AMBIGUOUS - bot would DM "Movie or TV?" to clarify');
  } else {
    const r = resolveRoute(parsed.mediaTypeHint, parsed.category);
    console.log('Route  :', r);
  }
}
