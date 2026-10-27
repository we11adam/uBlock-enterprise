/*******************************************************************************

    Feasibility probe: blocking webRequest in an MV3 service worker.

    Listeners are registered synchronously at top level. A simulated
    "engine load" (async, from storage) runs at every SW start; requests to
    `/probe/cold*` are held with a Promise until the engine is ready.

*/

const swStartedAt = Date.now();
const log = [];
let engineReady = false;
let resolveEngine;
const engineReadyPromise = new Promise(resolve => { resolveEngine = resolve; });

// Simulated cold start: async load which takes a while
(async ( ) => {
    const bin = await chrome.storage.local.get('startCount');
    const startCount = (bin.startCount || 0) + 1;
    await new Promise(r => setTimeout(r, 1500));
    engineReady = true;
    resolveEngine();
    await chrome.storage.local.set({ startCount, lastStart: swStartedAt });
})();

const decide = url => {
    if ( url.includes('/probe/block') ) { return { cancel: true }; }
    if ( /\/probe\/redirect$/.test(url) ) {
        return { redirectUrl: url.replace(/\/probe\/redirect$/, '/probe/redirected') };
    }
};

chrome.webRequest.onBeforeRequest.addListener(details => {
    const { url } = details;
    if ( url.includes('/probe/') === false ) { return; }
    log.push({ t: Date.now(), url, type: details.type, engineReady });
    if ( url.includes('/probe/cold') ) {
        if ( engineReady ) { return { cancel: true }; }
        return engineReadyPromise.then(( ) => ({ cancel: true }));
    }
    const match = /\/probe\/hold\?ms=(\d+)/.exec(url);
    if ( match ) {
        return new Promise(resolve => {
            setTimeout(( ) => resolve({ cancel: true }), parseInt(match[1], 10));
        });
    }
    if ( url.includes('/probe/reject') ) {
        return Promise.reject(new Error('probe rejection'));
    }
    return decide(url);
}, { urls: [ 'http://*/*', 'https://*/*' ] }, [ 'blocking' ]);

chrome.webRequest.onHeadersReceived.addListener(details => {
    if ( details.url.includes('/probe/headers') === false ) { return; }
    const responseHeaders = details.responseHeaders.filter(h =>
        h.name.toLowerCase() !== 'x-probe-remove'
    );
    responseHeaders.push({ name: 'X-Probe-Added', value: 'yes' });
    return { responseHeaders };
}, { urls: [ 'http://*/*', 'https://*/*' ] }, [ 'blocking', 'responseHeaders', 'extraHeaders' ]);

chrome.runtime.onMessageExternal.addListener(( ) => {});

self.probeState = async ( ) => {
    const self_ = await chrome.management.getSelf();
    const stored = await chrome.storage.local.get(null);
    return {
        installType: self_.installType,
        id: chrome.runtime.id,
        swStartedAt,
        engineReady,
        log,
        stored,
    };
};
