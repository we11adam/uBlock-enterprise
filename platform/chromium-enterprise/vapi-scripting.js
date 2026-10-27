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

// Chromium MV3 enterprise build: injection of scriptlets.
//
// Same as platform/chromium/vapi-scripting.js, i.e. scriptlets are injected
// when a document is committed, except that MV3 does not allow to execute
// code strings: the scriptlet code is a static function generated at build
// time (js/scriptlet-lib.js, see tools/enterprise/make-scriptlet-lib.mjs),
// and the per-site data computed by uBO's scriptlet compiler is passed as
// argument. The function is executed directly in the MAIN world, hence not
// subject to the page's Content Security Policy.
//
// Scriptlets which are not part of the generated library, i.e. those from
// user-provided resources (`userResourcesLocation`), are injected the
// MV2 way, through a script element, which is subject to the page's CSP.

import * as makeScriptlets from './make-scriptlets.js';

import {
    DATA_FIELDS,
    ISOLATED_FUNCTIONS,
    MAIN_FUNCTIONS,
    uBO_scriptlets_ISOLATED,
    uBO_scriptlets_MAIN,
} from './scriptlet-lib.js';

import { hostnameFromURI } from './uri-utils.js';
import { redirectEngine } from './redirect-engine.js';
import webext from './webext.js';

/******************************************************************************/

const TEMPLATES = {
    core: DATA_FIELDS.map(a => `self.$${a}$`).join('\n'),
    begin: 'self.$scriptletFunctionRefs$',
};

const LIBRARY_FUNCTIONS = {
    MAIN: MAIN_FUNCTIONS,
    ISOLATED: ISOLATED_FUNCTIONS,
};

const CONTENTSCRIPT_DICT_MAX_LOW = 128;
const CONTENTSCRIPT_DICT_MAX_HIGH = CONTENTSCRIPT_DICT_MAX_LOW +
    (CONTENTSCRIPT_DICT_MAX_LOW >>> 3);
const QUEUE_MAX_AGE_MS = 10000;
const INJECTED_MAX = 2048;

const tabDict = new Map();
const contentScriptDict = new Map();
const injectedDocuments = new Set();
const pendingEvents = [];
let getContentScripts;
let engine;
let zetaToResource = new Map();

/******************************************************************************/

// Functions executed in web pages

// Fallback for scriptlets not in the library: same as uBO_isolatedCode() in
// platform/chromium/vapi-scripting.js.
function uBO_injectMainCode(mainCode) {
    let script;
    try {
        const doc = document;
        script = doc.createElement('script');
        script.appendChild(doc.createTextNode(mainCode));
        (doc.head || doc.documentElement).appendChild(script);
    } catch {
    }
    if ( script ) {
        script.remove();
        script.textContent = '';
    }
}

// Prevents injecting twice in the same document, i.e. into documents which
// were already loaded when uBO was launched.
function uBO_markScriptletsInjected() {
    if ( self.uBO_scriptletsInjected ) { return false; }
    self.uBO_scriptletsInjected = true;
    return true;
}

/******************************************************************************/

function parseData(code) {
    const lines = code.split('\n');
    if ( lines.length !== DATA_FIELDS.length ) { return; }
    const data = {};
    for ( let i = 0; i < lines.length; i++ ) {
        data[DATA_FIELDS[i]] = JSON.parse(lines[i].replace(/^\/\* \d+ \*\/ /, ''));
    }
    return data;
}

function parseFunctionRefs(code) {
    const match = /\[([^\]]*)\]/.exec(code);
    if ( match === null ) { return []; }
    return match[1].split(',').filter(a => a !== '');
}

// Scriptlets imported from resources are named `zeta_<random>` by
// makeScriptlets.importScriptlet(): find out which resource they are from.
function resolveZetaNames(names) {
    const unknown = names.filter(a =>
        a.startsWith('zeta_') && zetaToResource.has(a) === false
    );
    if ( unknown.length === 0 ) { return; }
    zetaToResource = new Map();
    const { MAIN, ISOLATED } = makeScriptlets.commitFramework('self.$scriptletFunctions$', '', '');
    for ( const { beginCode } of [ MAIN, ISOLATED ] ) {
        const re = /^function (zeta_[0-9a-f]+)\(.*?\) \{ \/\/ (.+)$/gm;
        for (;;) {
            const match = re.exec(beginCode);
            if ( match === null ) { break; }
            zetaToResource.set(match[1], match[2]);
        }
    }
}

// Map the function names referenced by the compiled data to entries of the
// generated library. Returns undefined if one of them is not in the library.
function libraryRefsFromNames(world, names) {
    resolveZetaNames(names);
    const available = LIBRARY_FUNCTIONS[world];
    const out = [];
    for ( const name of names ) {
        let key = name;
        if ( name.startsWith('zeta_') ) {
            const resource = zetaToResource.get(name);
            if ( resource === undefined ) { return; }
            if ( redirectEngine.resources.get(resource)?.origin !== 'war' ) { return; }
            key = `war:${resource}`;
        }
        if ( available.has(key) === false ) { return; }
        out.push(key);
    }
    return out;
}

/******************************************************************************/

function compileScriptlets(url) {
    const hostname = hostnameFromURI(url);
    if ( hostname === '' ) { return; }
    let entry = contentScriptDict.get(hostname);
    if ( entry !== undefined ) { return entry; }
    entry = { worlds: {}, mainCode: undefined, t: Date.now() };
    const details = engine.getScriptletData(url, TEMPLATES);
    let needFallback = false;
    for ( const [ world, { data, functionRefs } ] of Object.entries(details.worlds) ) {
        const names = parseFunctionRefs(functionRefs);
        const refs = libraryRefsFromNames(world, names);
        if ( refs === undefined ) {
            if ( world === 'MAIN' ) {
                needFallback = true;
            } else {
                console.warn(`uBO: unsupported ISOLATED scriptlet(s) for ${hostname}`);
            }
            continue;
        }
        entry.worlds[world] = {
            data: parseData(data),
            functionRefs: refs,
        };
    }
    entry.scriptletGlobals = details.scriptletGlobals;
    if ( needFallback ) {
        entry.mainCode = getContentScripts(url)?.mainCode;
    }
    contentScriptDict.set(hostname, entry);
    if ( contentScriptDict.size > CONTENTSCRIPT_DICT_MAX_HIGH ) {
        const sortedKeys = Array.from(contentScriptDict.keys()).toSorted((a, b) =>
            contentScriptDict.get(a).t - contentScriptDict.get(b).t
        ).slice(0, -CONTENTSCRIPT_DICT_MAX_LOW);
        for ( const key of sortedKeys ) {
            contentScriptDict.delete(key);
        }
    }
    return entry;
}

/******************************************************************************/

function getEffectiveURL(tabId, frameId) {
    const tabData = tabDict.get(tabId);
    if ( tabData === undefined ) { return; }
    const { frameDict } = tabData;
    let frameData = frameDict.get(frameId);
    for (;;) {
        if ( frameData === undefined ) { return; }
        if ( /^https?:/.test(frameData.url) ) { break; }
        frameId = frameData.parentId;
        if ( frameId === -1 ) { break; }
        frameData = frameDict.get(frameId);
    }
    return frameData.url;
}

function registerFrame(details) {
    const { tabId, frameId, url } = details;
    let tabData = tabDict.get(tabId);
    if ( tabData === undefined ) {
        tabData = { frameDict: new Map(), bailout: undefined };
        tabDict.set(tabId, tabData);
    }
    if ( frameId === 0 ) {
        tabData.frameDict.clear();
        tabData.bailout = undefined;
    }
    tabData.frameDict.set(frameId, { parentId: details.parentFrameId, url });
}

// Same as the early bailout code which is prepended to the scriptlets on
// other platforms, evaluated once per top-level document.
function isBailout(tabId) {
    const tabData = tabDict.get(tabId);
    if ( tabData === undefined ) { return false; }
    if ( tabData.bailout === undefined ) {
        const topURL = tabData.frameDict.get(0)?.url;
        if ( topURL === undefined ) { return false; }
        tabData.bailout = engine.isScriptletBailout(topURL);
    }
    return tabData.bailout;
}

function injectScriptlets(details, target, entry) {
    const { scriptletGlobals } = entry;
    const isolated = entry.worlds.ISOLATED;
    if ( isolated || scriptletGlobals.bcSecret ) {
        chrome.scripting.executeScript({
            target,
            world: 'ISOLATED',
            injectImmediately: true,
            func: uBO_scriptlets_ISOLATED,
            args: [ {
                secret: self.crypto.randomUUID(),
                data: isolated?.data,
                functionRefs: isolated?.functionRefs,
                scriptletGlobals,
            } ],
        }).catch(reason => { onInjectionError(details, reason); });
    }
    const main = entry.worlds.MAIN;
    if ( main ) {
        chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            injectImmediately: true,
            func: uBO_scriptlets_MAIN,
            args: [ {
                secret: self.crypto.randomUUID(),
                data: main.data,
                functionRefs: main.functionRefs,
                scriptletGlobals,
            } ],
        }).catch(reason => { onInjectionError(details, reason); });
    }
    if ( entry.mainCode ) {
        chrome.scripting.executeScript({
            target,
            world: 'ISOLATED',
            injectImmediately: true,
            func: uBO_injectMainCode,
            args: [ entry.mainCode ],
        }).catch(reason => { onInjectionError(details, reason); });
    }
}

function onInjectionError(details, reason) {
    // The document went away before the scriptlets could be injected
    if ( /No (?:document|frame|tab) with id|Frame with ID .* was removed|was removed/i.test(`${reason}`) ) {
        return;
    }
    console.info(`uBO: scriptlet injection failed for ${details.url}: ${reason}`);
}

function hasScriptlets(entry) {
    return Boolean(entry.worlds.MAIN || entry.worlds.ISOLATED || entry.mainCode);
}

/******************************************************************************/

function onBeforeNavigate(details) {
    const { tabId, frameId } = details;
    if ( tabId < 0 ) { return; }
    let { url } = details;
    if ( frameId !== 0 && url.startsWith('about:') ) {
        url = getEffectiveURL(tabId, details.parentFrameId);
        if ( url === undefined ) { return; }
    }
    // Pre-compile, so that the data is ready when the document is committed
    compileScriptlets(url);
}

function onCommitted(details) {
    const { tabId, frameId, documentId } = details;
    if ( tabId < 0 ) { return; }
    registerFrame(details);
    if ( documentId === undefined ) { return; }
    if ( injectedDocuments.has(documentId) ) { return; }
    let { url } = details;
    if ( frameId !== 0 && url.startsWith('about:') ) {
        url = getEffectiveURL(tabId, frameId);
        if ( url === undefined ) { return; }
    }
    if ( /^https?:/.test(url) === false ) { return; }
    if ( isBailout(tabId) ) { return; }
    const entry = compileScriptlets(url);
    if ( entry === undefined ) { return; }
    entry.t = Date.now();
    if ( hasScriptlets(entry) === false ) { return; }
    injectedDocuments.add(documentId);
    if ( injectedDocuments.size > INJECTED_MAX ) {
        const iter = injectedDocuments.values();
        for ( let i = 0; i < INJECTED_MAX >>> 2; i++ ) {
            injectedDocuments.delete(iter.next().value);
        }
    }
    injectScriptlets(details, { tabId, documentIds: [ documentId ] }, entry);
}

function onTabRemoved(tabId) {
    tabDict.delete(tabId);
}

/******************************************************************************/

// Listeners are registered at module evaluation, as required for a service
// worker to receive the events which caused it to be started. Events which
// occur before uBO is ready are queued.

const enqueue = (handler, details) => {
    if ( getContentScripts !== undefined ) {
        return handler(details);
    }
    pendingEvents.push({ handler, details, t: Date.now() });
};

chrome.webNavigation.onBeforeNavigate.addListener(details => {
    enqueue(onBeforeNavigate, details);
});
chrome.webNavigation.onCommitted.addListener(details => {
    enqueue(onCommitted, details);
});
chrome.tabs.onRemoved.addListener(tabId => {
    enqueue(onTabRemoved, tabId);
});

/******************************************************************************/

// Inject into documents which were loaded before uBO was launched, once per
// browser session: when the service worker is merely restarted, these
// documents already received their scriptlets and content scripts.
async function injectIntoExistingTabs() {
    const isFirstWake = await vAPI.app.isFirstWakeOfSession?.() ?? true;
    if ( isFirstWake === false ) { return; }
    const manifest = chrome.runtime.getManifest();
    const tabs = await webext.tabs.query({ url: [ 'http://*/*', 'https://*/*' ] });
    for ( const tab of tabs ) {
        if ( tab.discarded ) { continue; }
        if ( tab.status === 'unloaded' ) { continue; }
        const { id: tabId } = tab;
        injectScriptletsIntoTab(tabId);
        webext.tabs.executeScript(tabId, {
            file: 'js/scriptlets/should-inject-contentscript.js'
        }).then(result => {
            if ( result?.[0] !== true ) { return; }
            for ( const contentScript of manifest.content_scripts ) {
                for ( const file of contentScript.js ) {
                    webext.tabs.executeScript(tabId, {
                        file,
                        allFrames: contentScript.all_frames,
                        runAt: contentScript.run_at,
                    });
                }
            }
        });
    }
}

async function injectScriptletsIntoTab(tabId) {
    const frames = await webext.webNavigation.getAllFrames({ tabId }).catch(( ) => null);
    if ( Array.isArray(frames) === false ) { return; }
    frames.sort((a, b) => a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : 0);
    for ( const frame of frames ) {
        registerFrame({ tabId, ...frame });
    }
    if ( isBailout(tabId) ) { return; }
    for ( const frame of frames ) {
        const { frameId, documentId } = frame;
        if ( documentId === undefined ) { continue; }
        if ( injectedDocuments.has(documentId) ) { continue; }
        let { url } = frame;
        if ( frameId !== 0 && url.startsWith('about:') ) {
            url = getEffectiveURL(tabId, frameId);
            if ( url === undefined ) { continue; }
        }
        if ( /^https?:/.test(url) === false ) { continue; }
        const entry = compileScriptlets(url);
        if ( entry === undefined || hasScriptlets(entry) === false ) { continue; }
        const target = { tabId, documentIds: [ documentId ] };
        const results = await chrome.scripting.executeScript({
            target,
            world: 'ISOLATED',
            injectImmediately: true,
            func: uBO_markScriptletsInjected,
        }).catch(( ) => null);
        if ( results?.[0]?.result !== true ) { continue; }
        injectedDocuments.add(documentId);
        injectScriptlets({ url }, target, entry);
    }
}

/******************************************************************************/

export async function start(fn, scriptletEngine) {
    const initialized = Boolean(getContentScripts);
    getContentScripts = fn;
    engine = scriptletEngine;
    if ( initialized ) { return; }

    // The top-level document of each tab is needed to evaluate the early
    // bailout conditions for embedded frames.
    const tabs = await webext.tabs.query({});
    for ( const { id: tabId, url } of tabs ) {
        if ( tabDict.has(tabId) || typeof url !== 'string' ) { continue; }
        registerFrame({ tabId, frameId: 0, parentFrameId: -1, url });
    }

    // Process the navigation events which occurred while uBO was launching:
    // the scriptlets will be injected late, possibly after the page's own
    // scripts have started to execute.
    const now = Date.now();
    for ( const { handler, details, t } of pendingEvents ) {
        if ( (now - t) > QUEUE_MAX_AGE_MS && handler !== onTabRemoved ) { continue; }
        try { handler(details); }
        catch (reason) { console.error(reason); }
    }
    pendingEvents.length = 0;

    injectIntoExistingTabs().catch(reason => {
        console.error(reason);
    });
}

export function reset() {
    contentScriptDict.clear();
    for ( const tabData of tabDict.values() ) {
        tabData.bailout = undefined;
    }
}

/******************************************************************************/
