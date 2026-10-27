/*******************************************************************************

    Feasibility checks for the probe extension, against a real Chrome which
    received the extension through managed policy.

*/

import { CDP, sleep } from './cdp.mjs';
import { execSync } from 'node:child_process';

const EXT_ID = process.env.EXT_ID;
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const hits = async ( ) => (await fetch('http://127.0.0.1/__hits')).json();
const resetHits = ( ) => fetch('http://127.0.0.1/__reset');
const hitCount = async path => (await hits()).filter(h => h.path === path).length;

const pageFetch = (page, url, timeout = 20000) => page.evaluate(`(async ( ) => {
    const t0 = performance.now();
    try {
        const r = await fetch(${JSON.stringify(url)}, { cache: 'no-store' });
        const headers = Object.fromEntries(r.headers.entries());
        return { ok: true, status: r.status, text: await r.text(), headers, ms: performance.now() - t0 };
    } catch (e) {
        return { ok: false, error: String(e), ms: performance.now() - t0 };
    }
})()`, timeout);

const restartChrome = async (startUrl = 'about:blank') => {
    try { execSync('pkill -x chrome'); } catch { }
    await sleep(1500);
    execSync(`su chrome -s /bin/bash -c "DISPLAY=:99 google-chrome --user-data-dir=$PROFILE --remote-debugging-port=9222 --no-first-run --no-default-browser-check ${startUrl} >>/tmp/chrome.log 2>&1 &"`);
    return CDP.connect();
};

const main = async ( ) => {
    let cdp = await CDP.connect();
    await cdp.waitForExtensionWorker(EXT_ID, 90000);
    await cdp.waitInWorker(EXT_ID, `typeof self.probeState === 'function'`);
    const state = await cdp.evalInWorker(EXT_ID, 'probeState()');
    check('policy install: extension present and installType === "admin"',
        state.installType === 'admin', `installType=${state.installType}`);

    // Wait for simulated engine to be ready
    await sleep(2000);
    const page = await cdp.newPage('http://site-a.test/');
    await resetHits();

    let r = await pageFetch(page, '/probe/block');
    check('sync {cancel:true} blocks request', r.ok === false && await hitCount('/probe/block') === 0, JSON.stringify(r));

    r = await pageFetch(page, '/probe/redirect');
    check('sync {redirectUrl} redirects request', r.ok && r.text === 'probe:/probe/redirected', JSON.stringify(r));

    r = await pageFetch(page, '/probe/hold?ms=3000');
    check('Promise response holds request then cancels',
        r.ok === false && r.ms >= 2900 && await hitCount('/probe/hold') === 0, `ms=${Math.round(r.ms)} ok=${r.ok}`);

    r = await pageFetch(page, '/probe/reject');
    check('rejected Promise => request proceeds (fail-open, informational)', r.ok === true, JSON.stringify({ ok: r.ok }));

    r = await pageFetch(page, '/probe/headers');
    check('onHeadersReceived modifies response headers',
        r.ok && r.headers['x-probe-added'] === 'yes' && r.headers['x-probe-remove'] === undefined,
        JSON.stringify(r.headers));

    r = await pageFetch(page, '/probe/pass');
    check('unrelated request passes', r.ok && r.text === 'probe:/probe/pass');

    // Service worker termination: first request after stop
    for ( let i = 0; i < 5; i++ ) {
        const before = await cdp.evalInWorker(EXT_ID, 'probeState().then(s => s.swStartedAt)');
        const stopped = await cdp.stopExtensionWorker(EXT_ID);
        await resetHits();
        r = await pageFetch(page, `/probe/cold?i=${i}`);
        const coldHits = await hitCount('/probe/cold');
        await cdp.waitInWorker(EXT_ID, `typeof self.probeState === 'function'`);
        const after = await cdp.evalInWorker(EXT_ID, 'probeState()');
        const entry = after.log.find(e => e.url.includes(`/probe/cold?i=${i}`));
        check(`[${i}] SW stopped -> first subresource request woke SW and was held until ready, then blocked`,
            stopped && r.ok === false && coldHits === 0 && after.swStartedAt !== before && entry?.engineReady === false,
            `ms=${Math.round(r.ms)} restarted=${after.swStartedAt !== before} engineReadyAtRequest=${entry?.engineReady}`);
    }

    for ( let i = 0; i < 3; i++ ) {
        await cdp.stopExtensionWorker(EXT_ID);
        await resetHits();
        const nav = await page.goto(`http://site-a.test/probe/cold-main?i=${i}`);
        check(`[${i}] SW stopped -> main_frame navigation held then blocked`,
            /BLOCKED_BY_CLIENT/.test(nav.errorText) && await hitCount('/probe/cold-main') === 0,
            nav.errorText);
    }

    // Browser cold start: startup URL must not leak
    await resetHits();
    cdp = await restartChrome('http://site-a.test/probe/cold-startup');
    await sleep(6000);
    const startupHits = await hitCount('/probe/cold-startup');
    await cdp.waitInWorker(EXT_ID, `typeof self.probeState === 'function'`);
    const st = await cdp.evalInWorker(EXT_ID, 'probeState()');
    const startupEntry = st.log.find(e => e.url.includes('/probe/cold-startup'));
    check('browser cold start: startup navigation intercepted and blocked',
        startupHits === 0 && startupEntry !== undefined,
        `serverHits=${startupHits} seenByListener=${startupEntry !== undefined} engineReadyAtRequest=${startupEntry?.engineReady}`);

    const failed = results.filter(r => r.ok === false);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length === 0 ? 0 : 1);
};

main().catch(e => { console.error(e); process.exit(2); });
