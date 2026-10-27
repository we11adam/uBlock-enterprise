/*******************************************************************************

    uBlock Origin - a comprehensive, efficient content blocker
    Copyright (C) 2017-present Raymond Hill

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

// Chromium MV3 enterprise build: everything from the Chromium MV2 platform
// code, plus what is needed to run uBO's network filtering engine in a
// service worker which can be terminated and restarted at any time.

import './vapi-background-ext-chromium.js';

/******************************************************************************/

// Network requests: suspend instead of cancel.
//
// A service worker is (re)started whenever an event it listens to fires,
// i.e. a network request, and the filtering engine must then be loaded from
// storage before uBO can make a filtering decision. The Chromium MV2 code
// deals with requests made before the engine is ready by cancelling them
// then reloading the tab, which is acceptable once per browser session, but
// not every time the service worker is restarted.
//
// Under MV3, Chromium honors a Promise returned by a blocking webRequest
// listener of a policy-installed extension: the request is held until the
// Promise is settled. So here the behavior is the same as uBO on Firefox
// (`suspendUntilListsAreLoaded`): requests from tabs are held until the
// filtering engine is ready, then they are filtered as usual. Requests not
// associated with a tab (including uBO's own fetches of filter lists) are
// never held, so they can't deadlock initialization.
//
// A request is never held more than SUSPEND_TIMEOUT_MS: past that delay, it
// is let through (fail-open), and accounted for in self.uBOmv3.stats so that
// it can be detected. The same applies when the Promise is rejected.

const SUSPEND_TIMEOUT_MS = 30000;
const ENGINE_READY_HOOKS_TIMEOUT_MS = 5000;

vAPI.engineReadyHooks = [];

vAPI.Net = class extends vAPI.Net {
    constructor() {
        super();
        this.pendingRequests = [];
        this.gate = undefined;
    }

    suspendOneRequest(details) {
        const pending = {
            details: Object.assign({}, details),
            resolve: undefined,
            timer: undefined,
        };
        const promise = new Promise(resolve => {
            pending.resolve = resolve;
        });
        pending.timer = self.setTimeout(( ) => {
            const pos = this.pendingRequests.indexOf(pending);
            if ( pos === -1 ) { return; }
            this.pendingRequests.splice(pos, 1);
            self.uBOmv3.stats.heldRequestsFailOpen += 1;
            pending.resolve();
        }, SUSPEND_TIMEOUT_MS);
        this.pendingRequests.push(pending);
        self.uBOmv3.stats.heldRequests += 1;
        return promise;
    }

    unsuspendAllRequests(discard = false) {
        // The engine-ready hooks (i.e. restoring session state) must complete
        // before the held requests are filtered.
        if ( discard !== true && this.gate instanceof Promise ) {
            this.gate.then(( ) => {
                if ( this.suspendDepth !== 0 ) { return; }
                this.unsuspendAllRequests(false);
            });
            return;
        }
        const pendingRequests = this.pendingRequests;
        this.pendingRequests = [];
        for ( const entry of pendingRequests ) {
            self.clearTimeout(entry.timer);
            let response;
            if ( discard !== true ) {
                try {
                    response = this.onBeforeSuspendableRequest(entry.details);
                } catch (reason) {
                    console.error(reason);
                }
            }
            entry.resolve(response);
        }
    }

    // Called once, when the filtering engine is ready
    setSuspendableListener(listener) {
        super.setSuspendableListener(listener);
        if ( this.gate !== undefined ) { return; }
        const hooks = vAPI.engineReadyHooks.map(fn => {
            try { return fn(); }
            catch (reason) { console.error(reason); }
        });
        this.gate = Promise.race([
            Promise.allSettled(hooks),
            new Promise(resolve => {
                self.setTimeout(resolve, ENGINE_READY_HOOKS_TIMEOUT_MS);
            }),
        ]).then(( ) => {
            this.gate = null;
            self.uBOmv3.markReady();
        });
    }

    onBeforeSuspendableRequest(details) {
        // Requests arriving while the engine-ready hooks run are held too
        if ( this.gate instanceof Promise && details.tabId >= 0 ) {
            return this.suspendOneRequest(details);
        }
        return super.onBeforeSuspendableRequest(details);
    }

    static canSuspend() {
        return true;
    }
};

/******************************************************************************/

// Messages from content scripts and extension pages which arrive before the
// filtering engine is ready are processed once it is ready, in order. A
// message from a content script is often what wakes up the service worker,
// and uBO's handlers answer with empty results when not ready, i.e. no
// cosmetic filtering for that page.

{
    const messaging = vAPI.messaging;
    // Ports of the workers hosted by the offscreen document are not for uBO's
    // messaging (see sw-env.js)
    const onPortConnect = messaging.onPortConnect;
    messaging.onPortConnect = function(port) {
        if ( self.uBOmv3.isWorkerPort(port) ) { return; }
        return onPortConnect.call(this, port);
    };
    const onPortMessage = messaging.onPortMessage;
    const deferred = [];
    messaging.onPortMessage = function(request, port) {
        if ( self.uBOmv3.ready ) {
            return onPortMessage.call(this, request, port);
        }
        deferred.push({ request, port });
    };
    self.uBOmv3.whenReady().then(( ) => {
        for ( const { request, port } of deferred ) {
            if ( messaging.ports.has(port.name) === false ) { continue; }
            onPortMessage.call(messaging, request, port);
        }
        deferred.length = 0;
    });
}

/******************************************************************************/

vAPI.app.isFirstWakeOfSession = ( ) => self.uBOmv3.firstWake;

/******************************************************************************/
