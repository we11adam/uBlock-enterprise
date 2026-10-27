/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* global LZ4BlockJS, chrome */

// Service worker environment for the Chromium MV3 enterprise build.
//
// This module is imported first by the service worker entry (sw.js). It
// provides what uBO's background code expects from the MV2 background page
// and which is not available in a service worker, without changing uBO's
// filtering code:
//
// - `browser`/`vAPI` globals (normally set by vapi.js in background.html)
// - requestIdleCallback (not exposed to service workers)
// - lz4 codec (normally loaded through a <script> element)
// - XMLHttpRequest, implemented on top of fetch() (used by assets.js)
// - Worker, implemented through an offscreen document (WORKERS reason):
//   dedicated workers can't be created from a service worker.
// - Event "bridges": listeners which uBO registers once its engine is ready
//   are pre-registered here, synchronously at the top level of the service
//   worker, with the exact same filters/options, so that the browser
//   dispatches these events to a service worker which was woken up by them,
//   and so that the registration order of webRequest listeners is the same
//   across service worker lifetimes.

import '/lib/lz4/lz4-block-codec-js.js';

/******************************************************************************/

if ( self.browser instanceof Object === false ) {
    self.browser = self.chrome;
}

self.vAPI = { uBO: true };

/******************************************************************************/

// requestIdleCallback is not available in service workers.

if ( typeof self.requestIdleCallback !== 'function' ) {
    self.requestIdleCallback = (callback, options = {}) => {
        const t0 = Date.now();
        return self.setTimeout(( ) => {
            callback({
                didTimeout: false,
                timeRemaining: ( ) => Math.max(0, 16 - (Date.now() - t0)),
            });
        }, Math.min(options.timeout || 1, 1));
    };
    self.cancelIdleCallback = id => { self.clearTimeout(id); };
}

/******************************************************************************/

// lz4: the JS codec only, the WASM codec loader requires a document.

self.lz4BlockCodec = {
    createInstance() {
        if ( typeof LZ4BlockJS !== 'function' ) { return Promise.resolve(null); }
        const instance = new LZ4BlockJS();
        return instance.init().then(ok => ok ? instance : null);
    },
    reset() {
    },
};

/******************************************************************************/

// XMLHttpRequest on top of fetch(). Only what uBO uses is implemented:
// asynchronous requests, `responseType` text/json/arraybuffer/blob, `load`,
// `error`, `abort`, `progress` and `loadend` events.

if ( typeof self.XMLHttpRequest !== 'function' ) {
    const makeEvent = (type, props = {}) => {
        const ev = new Event(type);
        for ( const [ k, v ] of Object.entries(props) ) {
            Object.defineProperty(ev, k, { value: v });
        }
        return ev;
    };

    self.XMLHttpRequest = class extends EventTarget {
        constructor() {
            super();
            this.readyState = 0;
            this.status = 0;
            this.statusText = '';
            this.response = null;
            this.responseType = '';
            this.responseURL = '';
            this.timeout = 0;
            this.withCredentials = false;
            this.method = 'GET';
            this.url = '';
            this.requestHeaders = new Headers();
            this.responseHeaders = new Headers();
            this.controller = null;
        }
        get responseText() {
            return typeof this.response === 'string' ? this.response : '';
        }
        open(method, url) {
            this.method = `${method}`.toUpperCase();
            this.url = new URL(url, self.location.href).href;
            this.readyState = 1;
        }
        setRequestHeader(name, value) {
            this.requestHeaders.set(name, value);
        }
        getResponseHeader(name) {
            return this.responseHeaders.get(name);
        }
        getAllResponseHeaders() {
            const out = [];
            for ( const [ k, v ] of this.responseHeaders ) {
                out.push(`${k}: ${v}`);
            }
            return out.join('\r\n');
        }
        abort() {
            if ( this.controller === null ) { return; }
            this.controller.abort();
        }
        send(body = null) {
            this.controller = new AbortController();
            this.run(body);
        }
        emit(type, props) {
            const ev = makeEvent(type, props);
            this.dispatchEvent(ev);
            const fn = this[`on${type}`];
            if ( typeof fn === 'function' ) { fn.call(this, ev); }
        }
        async run(body) {
            const { signal } = this.controller;
            let outcome = 'load';
            try {
                const response = await fetch(this.url, {
                    method: this.method,
                    headers: this.requestHeaders,
                    body: this.method === 'GET' || this.method === 'HEAD' ? null : body,
                    credentials: this.withCredentials ? 'include' : 'same-origin',
                    signal,
                });
                this.status = response.status;
                this.statusText = response.statusText;
                this.responseURL = response.url;
                this.responseHeaders = response.headers;
                this.readyState = 2;
                const total = parseInt(response.headers.get('content-length'), 10) || 0;
                const chunks = [];
                let loaded = 0;
                if ( response.body ) {
                    const reader = response.body.getReader();
                    for (;;) {
                        const { done, value } = await reader.read();
                        if ( done ) { break; }
                        chunks.push(value);
                        loaded += value.byteLength;
                        this.readyState = 3;
                        this.emit('progress', {
                            loaded,
                            total,
                            lengthComputable: total !== 0,
                        });
                    }
                }
                const blob = new Blob(chunks, {
                    type: response.headers.get('content-type') || '',
                });
                switch ( this.responseType ) {
                case 'arraybuffer':
                    this.response = await blob.arrayBuffer();
                    break;
                case 'blob':
                    this.response = blob;
                    break;
                case 'json':
                    try { this.response = JSON.parse(await blob.text()); }
                    catch { this.response = null; }
                    break;
                default:
                    this.response = await blob.text();
                    break;
                }
            } catch {
                outcome = signal.aborted ? 'abort' : 'error';
                this.status = 0;
                this.response = null;
            }
            this.readyState = 4;
            this.controller = null;
            this.emit(outcome);
            this.emit('loadend');
        }
    };
    self.XMLHttpRequest.prototype.UNSENT = 0;
    self.XMLHttpRequest.prototype.OPENED = 1;
    self.XMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
    self.XMLHttpRequest.prototype.LOADING = 3;
    self.XMLHttpRequest.prototype.DONE = 4;
}

/******************************************************************************/

// Worker through an offscreen document. uBO uses workers for the filter
// reverse lookup (logger, element picker) and for differential filter list
// updates. Messages are relayed through a runtime port; uBO's workers only
// exchange JSON-serializable data.

const offscreen = (( ) => {
    const OFFSCREEN_URL = 'offscreen.html';
    let creating;
    let workerCount = 0;
    let closeTimer;

    const exists = async ( ) => {
        if ( typeof chrome.runtime.getContexts !== 'function' ) { return false; }
        const contexts = await chrome.runtime.getContexts({
            contextTypes: [ 'OFFSCREEN_DOCUMENT' ],
        });
        return contexts.length !== 0;
    };

    const ensure = async ( ) => {
        if ( await exists() ) { return; }
        if ( creating === undefined ) {
            creating = chrome.offscreen.createDocument({
                url: OFFSCREEN_URL,
                reasons: [ 'WORKERS' ],
                justification: 'uBlock Origin uses dedicated workers for filter list differential updates and filter reverse lookup',
            }).catch(reason => {
                if ( /single offscreen/i.test(`${reason}`) ) { return; }
                throw reason;
            }).finally(( ) => {
                creating = undefined;
            });
        }
        return creating;
    };

    const close = async ( ) => {
        if ( workerCount !== 0 ) { return; }
        if ( await exists() === false ) { return; }
        chrome.offscreen.closeDocument().catch(( ) => { });
    };

    const scheduleClose = (delay = 30000) => {
        self.clearTimeout(closeTimer);
        closeTimer = self.setTimeout(close, delay);
    };

    return {
        ensure,
        acquire() {
            workerCount += 1;
            self.clearTimeout(closeTimer);
        },
        release() {
            workerCount = Math.max(0, workerCount - 1);
            if ( workerCount === 0 ) { scheduleClose(); }
        },
        scheduleClose,
    };
})();

// An offscreen document may have outlived a previous service worker
// instance; its workers were terminated when their ports disconnected.
offscreen.scheduleClose(10000);

if ( typeof self.Worker !== 'function' ) {
    self.Worker = class extends EventTarget {
        constructor(url) {
            super();
            const path = new URL(url, self.location.href).pathname;
            this.onmessage = null;
            this.onerror = null;
            this.port = null;
            this.queue = [];
            this.terminated = false;
            offscreen.acquire();
            this.connect(path, 0);
        }
        async connect(path, attempt) {
            try {
                await offscreen.ensure();
            } catch (reason) {
                return this.fail(`${reason}`);
            }
            if ( this.terminated ) { return; }
            const port = chrome.runtime.connect({ name: `uBO-worker|${path}` });
            let connected = false;
            port.onMessage.addListener(msg => {
                if ( msg === 'ready' ) {
                    connected = true;
                    this.port = port;
                    for ( const data of this.queue ) {
                        port.postMessage({ data });
                    }
                    this.queue = [];
                    return;
                }
                if ( msg instanceof Object === false ) { return; }
                if ( msg.error !== undefined ) {
                    return this.fail(msg.error);
                }
                const ev = new MessageEvent('message', { data: msg.data });
                this.dispatchEvent(ev);
                if ( typeof this.onmessage === 'function' ) {
                    this.onmessage.call(this, ev);
                }
            });
            port.onDisconnect.addListener(( ) => {
                void chrome.runtime.lastError;
                this.port = null;
                if ( this.terminated ) { return; }
                // The offscreen document may not be listening yet
                if ( connected === false && attempt < 20 ) {
                    self.setTimeout(( ) => { this.connect(path, attempt + 1); }, 50);
                    return;
                }
                this.fail('worker relay disconnected');
            });
        }
        fail(message) {
            if ( this.terminated ) { return; }
            const ev = new ErrorEvent('error', { message });
            this.dispatchEvent(ev);
            if ( typeof this.onerror === 'function' ) {
                this.onerror.call(this, ev);
            }
            this.terminate();
        }
        postMessage(data) {
            if ( this.terminated ) { return; }
            if ( this.port === null ) {
                this.queue.push(data);
                return;
            }
            this.port.postMessage({ data });
        }
        terminate() {
            if ( this.terminated ) { return; }
            this.terminated = true;
            this.queue = [];
            if ( this.port !== null ) {
                this.port.disconnect();
                this.port = null;
            }
            offscreen.release();
        }
    };
}

/******************************************************************************/

// Event registration tracking and bridges.

const state = {
    evaluating: true,
    ready: false,
    readyResolve: undefined,
    lateRegistrations: [],
    stats: {
        swStartedAt: Date.now(),
        heldRequests: 0,
        heldRequestsFailOpen: 0,
        queuedEvents: 0,
        droppedEvents: 0,
    },
};
state.readyPromise = new Promise(resolve => { state.readyResolve = resolve; });

// Anything registered after the first turn of the event loop won't cause the
// service worker to be woken up by the event, and won't receive the event
// which woke it up.
self.setTimeout(( ) => { state.evaluating = false; }, 0);

const extensionOrigin = chrome.runtime.getURL('/').slice(0, -1);

const canonicalJSON = v => JSON.stringify(v, (k, v) => {
    if ( v instanceof Object && Array.isArray(v) === false ) {
        const out = {};
        for ( const key of Object.keys(v).sort() ) {
            if ( v[key] === undefined ) { continue; }
            out[key] = v[key];
        }
        return out;
    }
    return v;
});

const bridges = [];

class Bridge {
    constructor(name, event, args, blocking) {
        this.name = name;
        this.event = event;
        this.key = canonicalJSON(args);
        this.blocking = blocking;
        this.handlers = [];
        this.queue = [];
        this.waiters = [];
        this.listener = (...args) => this.dispatch(args);
        event.addListener.original.call(event, this.listener, ...args);
        bridges.push(this);
    }
    matches(event, args) {
        return event === this.event && canonicalJSON(args) === this.key;
    }
    attach(fn) {
        if ( this.handlers.includes(fn) ) { return; }
        this.handlers.push(fn);
        this.flush();
    }
    detach(fn) {
        const pos = this.handlers.indexOf(fn);
        if ( pos === -1 ) { return false; }
        this.handlers.splice(pos, 1);
        return true;
    }
    has(fn) {
        return this.handlers.includes(fn);
    }
    callHandlers(args) {
        let out;
        for ( const fn of this.handlers.slice() ) {
            let r;
            try { r = fn(...args); }
            catch (reason) { console.error(reason); }
            if ( out === undefined && r !== undefined ) { out = r; }
        }
        return out;
    }
    dispatch(args) {
        if ( this.handlers.length !== 0 ) {
            return this.callHandlers(args);
        }
        if ( this.blocking ) {
            if ( state.ready ) { return; }
            const details = args[0];
            if ( details.tabId < 0 ) { return; }
            if ( details.initiator === extensionOrigin ) { return; }
            state.stats.heldRequests += 1;
            return new Promise(resolve => {
                const timer = self.setTimeout(( ) => {
                    state.stats.heldRequestsFailOpen += 1;
                    resolve();
                }, 20000);
                this.waiters.push(( ) => {
                    self.clearTimeout(timer);
                    resolve(this.callHandlers(args));
                });
            });
        }
        if ( this.queue.length >= 2000 ) {
            state.stats.droppedEvents += 1;
            this.queue.shift();
        }
        state.stats.queuedEvents += 1;
        this.queue.push({ args, t: Date.now() });
    }
    flush() {
        if ( this.handlers.length === 0 && state.ready === false ) { return; }
        const waiters = this.waiters;
        this.waiters = [];
        for ( const fn of waiters ) { fn(); }
        if ( this.handlers.length === 0 ) {
            // Keep queued events for a short while: a handler might be
            // attached later, i.e. context menu entries.
            const tcutoff = Date.now() - 10000;
            this.queue = this.queue.filter(e => e.t >= tcutoff);
            return;
        }
        const queue = this.queue;
        this.queue = [];
        for ( const { args } of queue ) {
            this.callHandlers(args);
        }
    }
}

const NAMESPACES = [
    'action', 'alarms', 'commands', 'contextMenus', 'permissions', 'runtime',
    'storage', 'tabs', 'webNavigation', 'webRequest', 'windows',
];

for ( const ns of NAMESPACES ) {
    const api = chrome[ns];
    if ( api instanceof Object === false ) { continue; }
    for ( const prop of Object.keys(api) ) {
        if ( prop.startsWith('on') === false ) { continue; }
        const event = api[prop];
        if ( event instanceof Object === false ) { continue; }
        if ( typeof event.addListener !== 'function' ) { continue; }
        const name = `${ns}.${prop}`;
        const { addListener, removeListener, hasListener } = event;
        const patchedAdd = function(fn, ...args) {
            for ( const bridge of bridges ) {
                if ( bridge.matches(this, args) === false ) { continue; }
                return bridge.attach(fn);
            }
            if ( state.evaluating === false ) {
                const stack = new Error().stack.split('\n').slice(2, 4).map(s => s.trim()).join(' < ');
                state.lateRegistrations.push({ event: name, t: Date.now() - state.stats.swStartedAt, stack });
                console.warn(`[uBO MV3] late listener registration: ${name} (${stack})`);
            }
            return addListener.call(this, fn, ...args);
        };
        patchedAdd.original = addListener;
        event.addListener = patchedAdd;
        event.removeListener = function(fn) {
            for ( const bridge of bridges ) {
                if ( bridge.event !== this ) { continue; }
                if ( bridge.detach(fn) ) { return; }
            }
            return removeListener.call(this, fn);
        };
        event.hasListener = function(fn) {
            for ( const bridge of bridges ) {
                if ( bridge.event === this && bridge.has(fn) ) { return true; }
            }
            return hasListener.call(this, fn);
        };
    }
}

// The order and the exact arguments matter: they must match the calls in
// src/js/traffic.js, platform/chromium/vapi-background-ext.js,
// platform/common/vapi-background.js and src/js/start.js. A mismatch is not
// fatal, the listener is then registered directly, and reported in
// `self.uBOmv3.lateRegistrations`, which the test harness checks.
{
    const wr = chrome.webRequest;
    const httpURLs = [ 'http://*/*', 'https://*/*' ];
    // traffic.js: onHeadersReceived through vAPI.net.addListener(), with
    // websocket URLs added by vAPI.Net.denormalizeFilters()
    new Bridge('webRequest.onHeadersReceived', wr.onHeadersReceived, [
        { urls: [ ...httpURLs, 'ws://*/*', 'wss://*/*' ] },
        [ 'blocking', 'responseHeaders' ],
    ], true);
    // vapi-background-ext.js: vAPI.prefetching()
    new Bridge('webRequest.onHeadersReceived#prefetching', wr.onHeadersReceived, [
        { urls: httpURLs, types: [ 'main_frame', 'sub_frame' ] },
        [ 'blocking', 'responseHeaders' ],
    ], true);
    new Bridge('webRequest.onResponseStarted', wr.onResponseStarted, [
        { types: [ 'main_frame', 'sub_frame' ], urls: httpURLs },
    ], false);
    new Bridge('webRequest.onSendHeaders', wr.onSendHeaders, [
        { urls: httpURLs },
        [ 'requestHeaders', 'extraHeaders' ],
    ], false);
    new Bridge('webRequest.onBeforeRedirect', wr.onBeforeRedirect, [
        { urls: httpURLs },
    ], false);
    new Bridge('webRequest.onCompleted', wr.onCompleted, [
        { urls: httpURLs },
    ], false);
    new Bridge('webRequest.onErrorOccurred', wr.onErrorOccurred, [
        { urls: httpURLs },
    ], false);
    new Bridge('contextMenus.onClicked', chrome.contextMenus.onClicked, [], false);
    new Bridge('runtime.onUpdateAvailable', chrome.runtime.onUpdateAvailable, [], false);
}

/******************************************************************************/

// Safety net: should uBO's initialization fail, don't leave events and
// messages queued forever. Held network requests have their own fail-open
// timeout.
self.setTimeout(( ) => {
    if ( state.ready ) { return; }
    console.error('[uBO MV3] filtering engine not ready after 60 s');
    state.stats.readyForced = true;
    self.uBOmv3.markReady();
}, 60000);

self.uBOmv3 = {
    lateRegistrations: state.lateRegistrations,
    stats: state.stats,
    get ready() {
        return state.ready;
    },
    whenReady() {
        return state.readyPromise;
    },
    markReady() {
        if ( state.ready ) { return; }
        state.ready = true;
        state.stats.readyAfter = Date.now() - state.stats.swStartedAt;
        for ( const bridge of bridges ) { bridge.flush(); }
        state.readyResolve();
    },
    bridges: ( ) => bridges.map(b => ({
        name: b.name,
        handlers: b.handlers.length,
        queued: b.queue.length,
        waiting: b.waiters.length,
    })),
    // Whether this is the first service worker instance since the browser
    // was launched or since the extension was installed/updated/reloaded,
    // all of which clear storage.session.
    firstWake: chrome.storage.session.get('uBOmv3.sessionStarted').then(bin =>
        bin instanceof Object === false ||
        bin['uBOmv3.sessionStarted'] === undefined
    ).catch(( ) => true),
};

/******************************************************************************/
