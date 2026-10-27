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

/* global chrome */

// Chromium MV3 enterprise build: apply changes to the admin policy
// (storage.managed) without waiting for extra restarts.
//
// uBO reads admin settings from a cached copy of storage.managed (see
// vAPI.adminStorage), refreshed after each read, so that a change requires
// an extension restart to take effect. Chrome populates storage.managed
// asynchronously, a few seconds after a force-installed extension is
// installed or after the policy is changed: without this, the admin settings
// would only take effect after the service worker happened to restart twice.
//
// The policy content which this instance of the service worker uses is the
// cached copy as it was when the worker started (or storage.managed itself
// when there was no cached copy yet). It is read here, at module evaluation,
// i.e. before uBO refreshes the cached copy. Whenever storage.managed differs
// from it -- at start, or when Chrome reports a change -- the cached copy is
// updated and the extension restarted, as uBO requires for admin settings.

const CACHE_KEY = 'cachedManagedStorage';
const RESTARTS_KEY = 'uBOmv3.policyRestarts';
const MAX_RESTARTS = 3;
const MAX_RESTARTS_PERIOD_MS = 60000;

const canonical = v => JSON.stringify(v, (k, v) => {
    if ( v instanceof Object && Array.isArray(v) === false ) {
        const out = {};
        for ( const key of Object.keys(v).sort() ) { out[key] = v[key]; }
        return out;
    }
    return v;
});

const managedGet = ( ) => chrome.storage.managed.get().then(
    store => store instanceof Object ? store : {},
    ( ) => undefined
);

const appliedPromise = Promise.all([
    chrome.storage.local.get(CACHE_KEY),
    managedGet(),
]).then(([ bin, managed ]) => {
    if ( bin instanceof Object && bin[CACHE_KEY] !== undefined ) {
        return bin[CACHE_KEY];
    }
    return managed;
}).catch(( ) => undefined);

// Guard against restart loops, i.e. a policy which keeps changing
const canRestart = async ( ) => {
    const now = Date.now();
    const bin = await chrome.storage.session.get(RESTARTS_KEY);
    const recent = (bin?.[RESTARTS_KEY] || []).filter(t => (now - t) < MAX_RESTARTS_PERIOD_MS);
    if ( recent.length >= MAX_RESTARTS ) { return false; }
    recent.push(now);
    await chrome.storage.session.set({ [RESTARTS_KEY]: recent });
    return true;
};

const checkPolicy = async startup => {
    try {
        const [ applied, managed ] = await Promise.all([ appliedPromise, managedGet() ]);
        if ( managed === undefined ) { return; }
        if ( canonical(managed) === canonical(applied || {}) ) { return; }
        // At browser launch, storage.managed may not be loaded yet: an empty
        // policy is acted upon only when Chrome reports the change.
        if ( startup && Object.keys(managed).length === 0 ) { return; }
        await chrome.storage.local.set({ [CACHE_KEY]: managed });
        if ( await canRestart() === false ) {
            console.error('[uBO MV3] admin policy keeps changing: not restarting');
            return;
        }
        console.info('[uBO MV3] admin policy changed: restarting');
        self.uBOmv3.stats.policyRestart = Date.now();
        chrome.runtime.reload();
    } catch (reason) {
        console.error(reason);
    }
};

let timer;

// Must be registered synchronously, so that the event wakes up the worker
chrome.storage.onChanged.addListener((changes, areaName) => {
    if ( areaName !== 'managed' ) { return; }
    // Coalesce bursts of changes
    if ( timer !== undefined ) { self.clearTimeout(timer); }
    timer = self.setTimeout(( ) => {
        timer = undefined;
        checkPolicy(false);
    }, 1000);
});

self.uBOmv3.whenReady().then(( ) => checkPolicy(true));
