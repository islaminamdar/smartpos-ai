import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const templateUrl = new URL('./pos-sw.template.js', import.meta.url);
const outputUrl = new URL('../public/pos-sw.js', import.meta.url);
const version = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
const template = await readFile(templateUrl, 'utf8');
if (!template.includes('__POS_BUILD_VERSION__')) throw new Error('POS worker template has no version placeholder.');
const worker = template.replaceAll('__POS_BUILD_VERSION__', version);
await writeFile(outputUrl, worker, 'utf8');
console.log(`Prepared offline worker ${version} (${Buffer.byteLength(worker)} bytes): ${fileURLToPath(outputUrl)}`);
