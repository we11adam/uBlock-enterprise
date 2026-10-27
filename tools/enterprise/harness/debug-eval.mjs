// Debug helper: evaluate EXPR in the extension worker (and print targets)
import { CDP, sleep } from './cdp.mjs';
const cdp = await CDP.connect();
await cdp.waitForExtensionWorker(process.env.EXT_ID, 90000);
await sleep(Number(process.env.DELAY || 2000));
console.log(JSON.stringify((await cdp.targets()).map(t => [t.type, t.url]), null, 1));
for ( const expr of (process.env.EXPR || '1').split(';;') ) {
    try { console.log(expr, '=>', JSON.stringify(await cdp.evalInWorker(process.env.EXT_ID, expr), null, 1)); }
    catch (e) { console.log(expr, '=> ERR', e.message); }
}
process.exit(0);
