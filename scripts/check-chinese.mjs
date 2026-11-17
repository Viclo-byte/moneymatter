import fs from 'node:fs';
import path from 'node:path';
import { baseCompile } from '@intlify/message-compiler';

const root = 'packages/frontend/src/i18n/locales/chunks';
const failures = [];
let total = 0;
const variables = (text) => (text.match(/\{\{?[\w]+\}?\}/g) ?? []).sort().join(',');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

function check(source, translated, key = '', frontend = true) {
  for (const [name, value] of Object.entries(source)) {
    const target = translated?.[name];
    const current = `${key}${name}`;
    if (value && typeof value === 'object') {
      check(value, target, `${current}.`, frontend);
    } else if (typeof value === 'string') {
      total++;
      if (typeof target !== 'string') {
        failures.push(`${current}: missing translation`);
        continue;
      }
      if (variables(value) !== variables(target)) failures.push(`${current}: changed variables`);
      if (frontend) {
        if (value.split('|').length !== target.split('|').length) failures.push(`${current}: changed plural branches`);
        baseCompile(target, { onError: (error) => failures.push(`${current}: ${error.message}`) });
      }
    }
  }
}

for (const file of files(`${root}/en`)) {
  const target = file.replace('/en/', '/zh-CN/');
  check(JSON.parse(fs.readFileSync(file)), fs.existsSync(target) ? JSON.parse(fs.readFileSync(target)) : {});
}
const backend = 'packages/backend/src/i18n/locales';
check(JSON.parse(fs.readFileSync(`${backend}/en.json`)), JSON.parse(fs.readFileSync(`${backend}/zh-CN.json`)), 'backend.', false);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Chinese locale: ${total} messages checked; keys, variables, plural branches and syntax OK.`);
}
