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

// Chromium MV3 enterprise build: state which uBO keeps in memory for the
// duration of a browser session, and which must survive the termination of
// the service worker.
//
// - Temporary ("session") dynamic filtering rules, per-site switches and URL
//   rules: these are the rules changed from the popup panel and not yet
//   committed. On a fresh launch uBO initializes them from the permanent
//   rules, which is correct once per browser session, but not every time the
//   service worker restarts. They are saved to storage.session (in-memory,
//   cleared when the browser exits or the extension is updated/reloaded) and
//   restored before the filtering engine resumes processing requests.
// - Frames of already opened tabs, which are needed to filter requests from
//   embedded frames according to their context.

import {
    sessionFirewall,
    sessionSwitches,
    sessionURLFiltering,
} from './filtering-engines.js';
import { reset as resetScripting } from './vapi-scripting.js';
import webext from './webext.js';
import µb from './background.js';

/******************************************************************************/

const SNAPSHOT_KEY = 'uBOmv3.sessionRules';

const engines = {
    firewall: sessionFirewall,
    switches: sessionSwitches,
    urlFiltering: sessionURLFiltering,
};

const snapshotPromise = chrome.storage.session.get(SNAPSHOT_KEY).then(bin =>
    bin instanceof Object ? bin[SNAPSHOT_KEY] : undefined
).catch(( ) => undefined);

let armed = false;
let saveTimer;

const saveSnapshot = ( ) => {
    saveTimer = undefined;
    const snapshot = {};
    for ( const [ key, engine ] of Object.entries(engines) ) {
        snapshot[key] = engine.toString();
    }
    chrome.storage.session.set({ [SNAPSHOT_KEY]: snapshot }).catch(reason => {
        console.error(reason);
    });
};

const scheduleSave = ( ) => {
    if ( armed === false ) { return; }
    if ( saveTimer !== undefined ) { return; }
    saveTimer = self.setTimeout(saveSnapshot, 500);
};

// All mutators of the session rule engines set the `changed` property
for ( const engine of Object.values(engines) ) {
    let changed = engine.changed;
    Object.defineProperty(engine, 'changed', {
        get() { return changed; },
        set(value) {
            changed = value;
            if ( value ) { scheduleSave(); }
        },
        configurable: true,
        enumerable: true,
    });
}

/******************************************************************************/

vAPI.engineReadyHooks.push(async ( ) => {
    const snapshot = await snapshotPromise;
    if ( snapshot instanceof Object ) {
        for ( const [ key, engine ] of Object.entries(engines) ) {
            if ( typeof snapshot[key] !== 'string' ) { continue; }
            engine.reset();
            engine.fromString(snapshot[key]);
        }
        resetScripting();
    }
    armed = true;
    // Save at least once per session, so that the snapshot reflects the
    // permanent rules a fresh launch was initialized from.
    if ( snapshot === undefined ) { saveSnapshot(); }
});

/******************************************************************************/

// Restore the frame hierarchy of opened tabs: page stores are created anew
// from tabs.query() at launch, with only the top frame known. Held requests
// from embedded frames are filtered once this completes.
vAPI.engineReadyHooks.push(( ) => {
    const promises = [];
    for ( const [ tabId, pageStore ] of µb.pageStores ) {
        if ( tabId <= 0 ) { continue; }
        promises.push(
            webext.webNavigation.getAllFrames({ tabId }).then(frames => {
                if ( Array.isArray(frames) === false ) { return; }
                for ( const { frameId, parentFrameId, url } of frames ) {
                    if ( frameId === 0 ) { continue; }
                    pageStore.setFrameURL({ frameId, parentFrameId, url });
                }
            }).catch(( ) => { })
        );
    }
    return Promise.all(promises);
});

/******************************************************************************/

self.uBOmv3.whenReady().then(( ) => {
    chrome.storage.session.set({ 'uBOmv3.sessionStarted': Date.now() });
});

/******************************************************************************/
