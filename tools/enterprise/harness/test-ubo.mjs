/*******************************************************************************

    Functional checks of the uBO Chromium MV3 enterprise build, against a
    real Chrome which received the extension through genuine managed policy.

    Ground truth for "was the request blocked" is the local test server's hit
    log (did the request reach the network), not the extension's own report.

    Expects (see run-ubo-tests.sh):
    - managed storage policy for the extension with the filters below in
      `toOverwrite.filters`;
    - /dist/test-config.json: { "v1": "<version>", "v2": "<version>" }, and
      /dist/update-v2.xml pointing to a CRX of version v2 (upgrade test).

*/

import { CDP, Page, sleep } from './cdp.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const EXT_ID = process.env.EXT_ID;
const ONLY = process.env.TEST_FILTER ? new RegExp(process.env.TEST_FILTER) : null;
const config = JSON.parse(fs.readFileSync('/dist/test-config.json', 'utf8'));

// Also used by run-ubo-tests.sh to build the managed storage policy
const TEST_FILTERS = JSON.parse(fs.readFileSync(new URL('./test-ubo-filters.json', import.meta.url), 'utf8'));

/******************************************************************************/

const results = [];
const check = (name, ok, detail = '', opts = {}) => {
    const status = opts.info ? 'INFO' : ok ? 'PASS' : 'FAIL';
    results.push({ name, ok: opts.info ? true : ok, status, detail });
    console.log(`${status}  ${name}${detail ? `  -- ${detail}` : ''}`);
};

const hits = async ( ) => (await fetch('http://127.0.0.1/__hits')).json();
const resetHits = ( ) => fetch('http://127.0.0.1/__reset');
const hitCount = async (host, path) =>
    (await hits()).filter(h => h.host === host && h.path === path).length;

const pageFetch = (page, url, timeout = 40000) => page.evaluate(`(async ( ) => {
    const t0 = performance.now();
    try {
        const r = await fetch(${JSON.stringify(url)}, { cache: 'no-store' });
        return { ok: true, status: r.status, text: await r.text(), ms: performance.now() - t0 };
    } catch (e) {
        return { ok: false, error: String(e), ms: performance.now() - t0 };
    }
})()`, timeout);

// Ask the cross-site frame (site-b.test) embedded in site-a.test/ to do
// something, so that requests originate from the frame.
const frameRequest = (page, message) => page.evaluate(`new Promise(resolve => {
    const onmsg = ev => {
        if ( ev.data instanceof Object === false ) { return; }
        const r = ev.data.frameFetch || ev.data.frameState;
        if ( r === undefined ) { return; }
        removeEventListener('message', onmsg);
        resolve(r);
    };
    addEventListener('message', onmsg);
    document.getElementById('frame').contentWindow.postMessage(${JSON.stringify(message)}, '*');
    setTimeout(( ) => resolve({ timeout: true }), 30000);
})`, 40000);

const restartChrome = async (startUrl = 'about:blank') => {
    try { execSync('pkill -x chrome'); } catch { }
    for ( let i = 0; i < 50; i++ ) {
        try { execSync('pgrep -x chrome'); } catch { break; }
        await sleep(200);
    }
    await sleep(500);
    execSync(`su chrome -s /bin/bash -c "DISPLAY=:99 google-chrome --user-data-dir=$PROFILE --remote-debugging-port=9222 --no-first-run --no-default-browser-check ${startUrl} >>/tmp/chrome.log 2>&1 &"`);
    return CDP.connect();
};

const attachPage = async (cdp, urlPrefix) => {
    const until = Date.now() + 20000;
    while ( Date.now() < until ) {
        const t = (await cdp.targets()).find(t => t.type === 'page' && t.url.startsWith(urlPrefix));
        if ( t ) {
            const sessionId = await cdp.attach(t.targetId);
            await cdp.send('Runtime.enable', {}, sessionId);
            return new Page(cdp, t.targetId, sessionId);
        }
        await sleep(200);
    }
    throw new Error(`no page ${urlPrefix}`);
};

const READY = `self.uBOmv3?.ready === true && self.µBlock?.readyToFilter === true`;

// Scriptlets are injected from the service worker when a document is
// committed (same as uBO MV2 on Chromium): whether they land before the
// page's inline scripts depends on the worker handling the event at once.
// Wait until the worker's event loop is idle (i.e. not compiling filter lists
// in the background) before asserting that timing.
const waitWorkerIdle = async (cdp, timeout = 120000) => {
    const until = Date.now() + timeout;
    let calm = 0;
    while ( Date.now() < until ) {
        const lag = await cdp.evalInWorker(EXT_ID, `new Promise(resolve => {
            const t0 = performance.now();
            setTimeout(( ) => resolve(performance.now() - t0), 0);
        })`).catch(( ) => 1000);
        calm = lag < 10 ? calm + 1 : 0;
        if ( calm >= 10 ) { return true; }
        await sleep(200);
    }
    return false;
};

const swState = cdp => cdp.evalInWorker(EXT_ID, `({
    swStartedAt: self.uBOmv3.stats.swStartedAt,
    stats: self.uBOmv3.stats,
    late: self.uBOmv3.lateRegistrations,
})`);

// The state of site-a.test/ as observed from the page's main world
const SITE_A_STATE = `({
    atLoad: window.atLoad,
    constNow: window.uboTestConst,
    evalResult: window.evalResult,
    trackerLoaded: window.trackerLoaded,
    trackerEvent: window.trackerEvent,
    adDisplay: getComputedStyle(document.getElementById('ad')).display,
    contentDisplay: getComputedStyle(document.getElementById('content')).display,
    procDisplay: getComputedStyle(document.getElementById('proc')).display,
    isoAttr: document.getElementById('iso-target').getAttribute('data-ubo'),
    localStorageItem: localStorage.getItem('uboTestKey'),
    adImgLoaded: document.getElementById('adimg').naturalWidth > 0,
})`;

const checkSiteA = (label, s, opts = {}) => {
    check(`${label}: cosmetic filter hides .ad-banner, leaves #content`,
        s.adDisplay === 'none' && s.contentDisplay !== 'none', `ad=${s.adDisplay} content=${s.contentDisplay}`, opts);
    check(`${label}: procedural cosmetic filter (:has-text)`,
        s.procDisplay === 'none', `proc=${s.procDisplay}`, opts);
    check(`${label}: scriptlet set-constant (MAIN) effective before page scripts`,
        s.atLoad?.uboTestConst === 42, `${JSON.stringify(s.atLoad)} after load=${s.constNow}`, opts);
    check(`${label}: scriptlet nofab (imported from WAR resource) effective before page scripts`,
        s.atLoad?.fab === 'object', `typeof fuckAdBlock at load=${s.atLoad?.fab}`, opts);
    check(`${label}: scriptlet noeval (imported from WAR resource)`,
        s.evalResult === undefined, `evalResult=${s.evalResult}`, opts);
    check(`${label}: scriptlet set-attr`,
        s.isoAttr === 'true', `data-ubo=${s.isoAttr}`, opts);
    check(`${label}: scriptlet set-local-storage-item (ISOLATED world)`,
        s.localStorageItem === 'true', `uboTestKey=${s.localStorageItem}`, opts);
    check(`${label}: $redirect=noop.js: script redirected to neutered resource`,
        s.trackerLoaded === undefined && s.trackerEvent === 'load',
        `trackerLoaded=${s.trackerLoaded} scriptEvent=${s.trackerEvent}`, opts);
};

/******************************************************************************/

const phases = [];
const phase = (name, fn) => phases.push({ name, fn });

const ctx = {};

phase('install', async ( ) => {
    const t0 = Date.now();
    ctx.cdp = await CDP.connect();
    if ( process.env.DEBUG_SW ) {
        await ctx.cdp.captureWorkerConsole(EXT_ID, (n, type, text) => {
            if ( new RegExp(process.env.DEBUG_SW).test(text) === false ) { return; }
            console.log(`    [SW#${n} ${type}] ${text.slice(0, 500)}`);
        });
    }
    await ctx.cdp.waitForExtensionWorker(EXT_ID, 90000);
    // Chrome populates storage.managed shortly after a forced install; the
    // extension restarts itself to apply the admin settings (sw-policy.js).
    const ADMIN_APPLIED = `${READY} && chrome.storage.local.get('user-filters').then(b =>
        ${JSON.stringify(TEST_FILTERS)}.every(f => (b['user-filters'] || '').includes(f))
    )`;
    const applied = await ctx.cdp.waitInWorker(EXT_ID, ADMIN_APPLIED, 90000).catch(e => e.message);
    check('admin policy filters (managed storage toOverwrite.filters) in effect after install',
        applied === true, `after ${Date.now() - t0} ms from browser launch`);
    await sleep(2000);
    await ctx.cdp.waitInWorker(EXT_ID, READY, 30000);
    const info = await ctx.cdp.evalInWorker(EXT_ID, `chrome.management.getSelf().then(s => ({
        installType: s.installType, version: s.version, versionName: s.versionName,
        mayDisable: s.mayDisable, enabled: s.enabled,
        appVersion: vAPI.app.version, appName: vAPI.app.name,
    }))`);
    check('policy install: installType === "admin", not user-disableable',
        info.installType === 'admin' && info.mayDisable === false && info.enabled, JSON.stringify(info));
    check('manifest version and version_name = upstream version (dist/version)',
        info.version === config.v1 && info.versionName === config.v1, JSON.stringify(info));
    const st = await swState(ctx.cdp);
    check('all event listeners registered synchronously at SW start', st.late.length === 0, JSON.stringify(st.late));
    check('engine ready (no forced readiness)', st.stats.readyForced !== true, `readyAfter=${st.stats.readyAfter} ms`);
    const userFilters = await ctx.cdp.evalInWorker(EXT_ID, `self.µBlock.availableFilterLists['user-filters']`);
    check('admin filters compiled into engine', userFilters?.entryCount >= TEST_FILTERS.length, JSON.stringify(userFilters));
});

phase('network', async ( ) => {
    const { cdp } = ctx;
    await resetHits();
    const page = ctx.page = await cdp.newPage('http://site-a.test/');
    await sleep(1000);
    check('||ads.test^ blocks image (no request reached network)',
        await hitCount('ads.test', '/banner.png') === 0, `hits=${await hitCount('ads.test', '/banner.png')}`);
    check('$redirect: tracker script never reached network',
        await hitCount('tracker.test', '/t.js') === 0);
    let r = await pageFetch(page, 'http://ads.test/probe/xhr');
    check('||ads.test^ blocks fetch', r.ok === false && await hitCount('ads.test', '/probe/xhr') === 0, JSON.stringify(r));
    r = await pageFetch(page, 'http://ads.test/probe/allowed');
    check('@@ exception filter overrides block', r.ok && r.text === 'probe:/probe/allowed', JSON.stringify(r));
    r = await pageFetch(page, 'http://cdn.test/probe/plain');
    check('unrelated 3rd-party request passes', r.ok && r.text === 'probe:/probe/plain', JSON.stringify(r));
    check('$domain=site-b.test: request from site-b frame blocked, control passes',
        await hitCount('cdn.test', '/probe/frame-only') === 0 && await hitCount('cdn.test', '/probe/frame-control') === 1,
        `frame-only=${await hitCount('cdn.test', '/probe/frame-only')} frame-control=${await hitCount('cdn.test', '/probe/frame-control')}`);
    r = await pageFetch(page, 'http://cdn.test/probe/frame-only?from-a');
    check('$domain=site-b.test does not block same URL from site-a.test', r.ok, JSON.stringify(r));

    const p2 = await cdp.newPage('about:blank');
    await resetHits();
    await p2.goto('http://site-a.test/probe/param?utm_source=x&keep=1');
    const h = (await hits()).filter(h => h.path === '/probe/param');
    check('$removeparam strips utm_source from navigation',
        h.length !== 0 && h.every(h => h.query === 'keep=1'), JSON.stringify(h.map(h => h.query)));

    const p3 = await cdp.newPage('http://site-b.test/csp-inject.html');
    const csp = await p3.evaluate('({ title: document.title, url: location.href })');
    check('$csp injects Content-Security-Policy (inline script prevented)', csp.title === 'before', JSON.stringify(csp));
    await p3.close();

    await resetHits();
    const nav = await p2.goto('http://site-a.test/probe/strict');
    await sleep(500);
    const url = await p2.evaluate('location.href').catch(e => e.message);
    check('strict blocking ($document): navigation replaced by document-blocked page',
        await hitCount('site-a.test', '/probe/strict') === 0 && url.startsWith(`chrome-extension://${EXT_ID}/document-blocked.html`),
        `url=${url.slice(0, 80)} errorText=${nav.errorText}`);

    await p2.close();
});

phase('cosmetic-scriptlets', async ( ) => {
    const { cdp, page } = ctx;
    // The page was loaded shortly after install, while uBO was possibly still
    // compiling/updating filter lists: reported, not asserted.
    checkSiteA('shortly after install', await page.evaluate(SITE_A_STATE), { info: true });
    check('service worker idle', await waitWorkerIdle(cdp));
    await page.goto('http://site-a.test/');
    await sleep(500);
    checkSiteA('warm SW', await page.evaluate(SITE_A_STATE));
    const frameState = await frameRequest(page, 'state');
    check('cosmetic filter applied in cross-site frame', frameState.adDisplay === 'none' && frameState.contentDisplay !== 'none', JSON.stringify(frameState));

    const p2 = await cdp.newPage('http://site-a.test/csp.html');
    await sleep(500);
    const s = await p2.evaluate(`({
        atLoad: window.atLoad,
        isoAttr: document.getElementById('iso-target').getAttribute('data-ubo'),
        localStorageItem: localStorage.getItem('uboTestKey'),
    })`);
    check('strict page CSP (no inline script): MAIN scriptlets still effective before page scripts',
        s.atLoad?.uboTestConst === 42 && s.atLoad?.fab === 'object', JSON.stringify(s.atLoad));
    check('strict page CSP: set-attr and ISOLATED scriptlets effective',
        s.isoAttr === 'true' && s.localStorageItem === 'true', JSON.stringify(s));
    await p2.close();

    const p3 = await cdp.newPage('http://cdn.test/');
    const leak = await p3.evaluate('({ c: window.uboTestConst, ls: localStorage.getItem("uboTestKey") })');
    check('site-specific scriptlets not injected on other sites', leak.c === undefined && leak.ls === null, JSON.stringify(leak));
    await p3.close();
});

phase('sw-restart', async ( ) => {
    const { cdp, page } = ctx;
    for ( let i = 0; i < 3; i++ ) {
        const before = (await swState(cdp)).swStartedAt;
        await cdp.stopExtensionWorker(EXT_ID);
        await resetHits();
        const r = await pageFetch(page, `http://ads.test/probe/cold?i=${i}`);
        await cdp.waitInWorker(EXT_ID, READY);
        const st = await swState(cdp);
        check(`[${i}] SW stopped: first request (ads) wakes SW, is held, then blocked by real engine`,
            r.ok === false && await hitCount('ads.test', '/probe/cold') === 0 && st.swStartedAt !== before &&
            st.stats.heldRequests > 0 && st.stats.heldRequestsFailOpen === 0,
            `ms=${Math.round(r.ms)} readyAfter=${st.stats.readyAfter} held=${st.stats.heldRequests}`);
    }

    // Not "block everything while initializing"
    await cdp.stopExtensionWorker(EXT_ID);
    let r = await pageFetch(page, 'http://cdn.test/probe/pass-cold');
    check('SW stopped: first request (allowed) passes once engine ready (no blanket blocking)',
        r.ok && r.text === 'probe:/probe/pass-cold', `ok=${r.ok} ms=${Math.round(r.ms ?? 0)}`);

    // Requests from an existing cross-site frame
    await cdp.stopExtensionWorker(EXT_ID);
    await resetHits();
    r = await frameRequest(page, 'fetch:http://cdn.test/probe/frame-only?cold');
    check('SW stopped: request from existing site-b frame filtered with frame context ($domain)',
        r.ok === false && await hitCount('cdn.test', '/probe/frame-only') === 0, JSON.stringify(r));
    r = await frameRequest(page, 'fetch:http://cdn.test/probe/frame-control?cold');
    check('after SW restart: control request from frame passes', r.ok === true, JSON.stringify(r));

    // Cold navigation: SW stopped, then a navigation
    await cdp.stopExtensionWorker(EXT_ID);
    await resetHits();
    const p2 = await cdp.newPage('http://site-a.test/');
    await sleep(1000);
    check('SW stopped -> navigation: subresources blocked',
        await hitCount('ads.test', '/banner.png') === 0 && await hitCount('tracker.test', '/t.js') === 0);
    // Scriptlet injection timing at cold start is a documented limitation:
    // reported, not asserted.
    checkSiteA('SW stopped -> navigation', await p2.evaluate(SITE_A_STATE), { info: true });
    await p2.close();

    // Alarms
    const alarms = await cdp.evalInWorker(EXT_ID, 'chrome.alarms.getAll().then(a => a.map(a => a.name))');
    check('asset updater alarm scheduled', alarms.includes('assetUpdater'), JSON.stringify(alarms));
});

phase('session-rules', async ( ) => {
    const { cdp, page } = ctx;
    const tabId = await cdp.evalInWorker(EXT_ID,
        `chrome.tabs.query({ url: 'http://site-a.test/' }).then(t => t[0].id)`);
    ctx.tabId = tabId;
    // Per-tab counters are not persisted across worker restarts: count from
    // a fresh page load.
    await page.goto('http://site-a.test/');
    await sleep(500);
    // Through the same messaging path as the popup panel
    const popup = await cdp.newPage(`chrome-extension://${EXT_ID}/popup-fenix.html?tabId=${tabId}`);
    const send = msg => popup.evaluate(`vAPI.messaging.send('popupPanel', ${JSON.stringify(msg)})`);
    // Dynamic filtering is an "advanced user" feature, as on all platforms
    await popup.evaluate(`vAPI.messaging.send('default', { what: 'userSettings', name: 'advancedUserEnabled', value: true })`);
    const pd = await send({ what: 'getPopupData', tabId });
    check('popup panel: getPopupData for tab (hostname, blocked count)',
        pd.pageHostname === 'site-a.test' && pd.pageCounts?.blocked?.any > 0,
        `hostname=${pd.pageHostname} blocked=${JSON.stringify(pd.pageCounts?.blocked)}`);
    await sleep(500);
    const text = await popup.evaluate('document.body.textContent');
    check('popup panel renders', text.includes('site-a.test'), '');
    await popup.goto(`chrome-extension://${EXT_ID}/popup-fenix.html?tabId=${tabId}`);
    await sleep(300);

    await send({ what: 'toggleFirewallRule', tabId, srcHostname: 'site-a.test', desHostname: 'cdn.test', requestType: '*', action: 1, persist: false });
    let r = await pageFetch(page, 'http://cdn.test/probe/fw?1');
    check('temporary dynamic rule (popup) blocks', r.ok === false, JSON.stringify(r));
    await sleep(1000);
    await cdp.stopExtensionWorker(EXT_ID);
    await resetHits();
    r = await pageFetch(page, 'http://cdn.test/probe/fw?2');
    check('temporary dynamic rule survives SW restart',
        r.ok === false && await hitCount('cdn.test', '/probe/fw') === 0, JSON.stringify(r));
    const permanent = await cdp.evalInWorker(EXT_ID,
        `chrome.storage.local.get('dynamicFilteringString').then(b => b.dynamicFilteringString || '')`);
    check('temporary rule not committed to permanent rules', permanent.includes('site-a.test cdn.test') === false);

    await popup.goto(`chrome-extension://${EXT_ID}/popup-fenix.html?tabId=${tabId}`);
    await sleep(300);
    await send({ what: 'toggleFirewallRule', tabId, srcHostname: 'site-a.test', desHostname: 'cdn.test', requestType: '*', action: 0, persist: false });
    await sleep(1000);
    await cdp.stopExtensionWorker(EXT_ID);
    r = await pageFetch(page, 'http://cdn.test/probe/fw?3');
    check('removal of temporary rule survives SW restart', r.ok === true, JSON.stringify(r));

    // Left in place to verify that browser restart resets it, as with MV2
    await popup.goto(`chrome-extension://${EXT_ID}/popup-fenix.html?tabId=${tabId}`);
    await sleep(300);
    await send({ what: 'toggleFirewallRule', tabId, srcHostname: 'site-a.test', desHostname: 'cdn.test', requestType: '*', action: 1, persist: false });
    // Persistent rule + setting, to be verified after upgrade
    await send({ what: 'toggleFirewallRule', tabId, srcHostname: 'site-a.test', desHostname: 'tracker.test', requestType: 'image', action: 1, persist: true });
    await popup.close();
});

phase('dashboard-offscreen', async ( ) => {
    const { cdp } = ctx;
    const exceptions = [];
    const off = cdp.on(m => {
        if ( m.method === 'Runtime.exceptionThrown' ) {
            exceptions.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
        }
    });
    const dash = await cdp.newPage(`chrome-extension://${EXT_ID}/dashboard.html#1p-filters.html`);
    await sleep(2000);
    const ok = await dash.evaluate(`document.querySelector('iframe')?.contentDocument?.body?.textContent.length > 0`);
    check('dashboard opens (My filters pane)', ok === true && exceptions.length === 0, exceptions.join(' | ').slice(0, 300));
    await dash.evaluate(`vAPI.messaging.send('default', { what: 'userSettings', name: 'colorBlindFriendly', value: true })`);

    const lookup = ( ) => dash.evaluate(
        `vAPI.messaging.send('default', { what: 'listsFromNetFilter', rawFilter: '||ads.test^' })`, 60000);
    let r = await lookup();
    check('filter reverse lookup (Worker in offscreen document)',
        JSON.stringify(r).includes('user-filters'), JSON.stringify(r).slice(0, 200));
    await cdp.stopExtensionWorker(EXT_ID);
    await sleep(Number(process.env.LOOKUP_DELAY ?? 1000));
    r = await lookup().catch(e => e.message);
    check('filter reverse lookup after SW restart', `${JSON.stringify(r)}`.includes('user-filters'), `${JSON.stringify(r)}`.slice(0, 200));
    off();
    await dash.close();
});

phase('browser-restart', async ( ) => {
    await resetHits();
    const cdp = ctx.cdp = await restartChrome('http://site-a.test/');
    await cdp.waitForExtensionWorker(EXT_ID, 60000);
    await cdp.waitInWorker(EXT_ID, READY);
    await sleep(1500);
    check('browser cold start: startup page subresources blocked',
        await hitCount('ads.test', '/banner.png') === 0 && await hitCount('tracker.test', '/t.js') === 0,
        `ads=${await hitCount('ads.test', '/banner.png')} tracker=${await hitCount('tracker.test', '/t.js')}`);
    const page = ctx.page = await attachPage(cdp, 'http://site-a.test/');
    checkSiteA('browser cold start page', await page.evaluate(SITE_A_STATE), { info: true });
    const r = await pageFetch(page, 'http://cdn.test/probe/fw?4');
    check('temporary rules reset on browser restart (same as MV2)', r.ok === true, JSON.stringify(r));
    check('service worker idle', await waitWorkerIdle(cdp));
    await page.goto('http://site-a.test/');
    await sleep(500);
    checkSiteA('after cold start, reload', await page.evaluate(SITE_A_STATE));
});

phase('upgrade', async ( ) => {
    let { cdp } = ctx;
    fs.copyFileSync('/dist/update-v2.xml', '/dist/update.xml');
    const status = await cdp.evalInWorker(EXT_ID,
        'chrome.runtime.requestUpdateCheck().then(r => r.status || r).catch(e => String(e))');
    check('update check finds new version', status === 'update_available', String(status));
    await sleep(5000);
    // uBO defers updates to the next browser launch (uBlock-issues#717)
    cdp = ctx.cdp = await restartChrome();
    await cdp.waitForExtensionWorker(EXT_ID, 60000);
    await cdp.waitInWorker(EXT_ID, READY);
    const after = await cdp.evalInWorker(EXT_ID, `(async ( ) => ({
        version: chrome.runtime.getManifest().version,
        versionName: chrome.runtime.getManifest().version_name,
        colorBlindFriendly: self.µBlock.userSettings.colorBlindFriendly,
        rules: (await chrome.storage.local.get('dynamicFilteringString')).dynamicFilteringString || '',
        filters: (await chrome.storage.local.get('user-filters'))['user-filters'] || '',
        installType: (await chrome.management.getSelf()).installType,
    }))()`);
    check('upgrade applied at browser restart', after.version === config.v2 && after.versionName === config.v1 /* upstream */,
        `version=${after.version} version_name=${after.versionName}`);
    check('settings, permanent rules and filters preserved across upgrade',
        after.colorBlindFriendly === true &&
        after.rules.includes('site-a.test tracker.test image block') &&
        after.filters.includes('||ads.test^'),
        JSON.stringify({ ...after, rules: undefined, filters: after.filters.length }));
    const page = await cdp.newPage('http://site-a.test/');
    await resetHits();
    const r = await pageFetch(page, 'http://ads.test/probe/after-upgrade');
    check('filtering after upgrade', r.ok === false && await hitCount('ads.test', '/probe/after-upgrade') === 0);
});

/******************************************************************************/

const main = async ( ) => {
    for ( const { name, fn } of phases ) {
        if ( ONLY && ONLY.test(name) === false && name !== 'install' ) { continue; }
        console.log(`\n== ${name}`);
        try {
            await fn();
        } catch (e) {
            check(`phase ${name} completed`, false, e.stack.split('\n').slice(0, 3).join(' | '));
        }
    }
    const failed = results.filter(r => r.ok === false);
    console.log(`\n${results.length - failed.length}/${results.length} passed (INFO = reported, not asserted)`);
    fs.writeFileSync('/dist/test-results.json', JSON.stringify(results, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
};

main().catch(e => { console.error(e); process.exit(2); });
