// Debug helper: log every instance of the extension service worker from its
// start, then dump uBO state.
import { CDP, sleep } from './cdp.mjs';
const EXT_ID = process.env.EXT_ID;
const cdp = await CDP.connect();
const t0 = Date.now();
await cdp.captureWorkerConsole(EXT_ID, (n, type, text) => {
    console.log(`[${Date.now() - t0}] SW#${n} ${type} ${text.slice(0, 400)}`);
});
await cdp.waitForExtensionWorker(EXT_ID, 90000);
await sleep(Number(process.env.DELAY || 12000));
const STATE = (process.env.EXPR || `({
    ready: self.uBOmv3.ready, stats: self.uBOmv3.stats,
    userFilters: self.µBlock.availableFilterLists?.['user-filters'],
})`);
for ( const expr of STATE.split(';;') ) {
    console.log(expr.slice(0, 80), '=>', JSON.stringify(await cdp.evalInWorker(EXT_ID, expr).catch(e => e.message), null, 1));
}
process.exit(0);
