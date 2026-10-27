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

// Chromium MV3 enterprise build: host for the dedicated workers uBO uses,
// since a service worker can't create workers. See the Worker shim in
// sw-env.js. Each worker is bound to one runtime port: messages are relayed
// both ways, and the worker is terminated when the port is disconnected.
//
// The service worker asks for a worker through a one-time message, then this
// document opens the port to the service worker. This document must not
// listen to runtime.onConnect: ports opened by content scripts and extension
// pages for the service worker would be delivered here as well, and such a
// port stays open as long as one of its receivers exists, i.e. it would not
// be disconnected when the service worker is stopped, and whatever is sent
// through it would be lost instead of waking up the service worker.

const PREFIX = 'uBO-worker|';

const ALLOWED_WORKERS = new Set([
    '/js/reverselookup-worker.js',
    '/js/diff-updater.js',
]);

const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;

const startWorker = (id, path) => {
    let worker;
    try {
        worker = new Worker(path);
    } catch (reason) {
        return `${reason}`;
    }
    const port = chrome.runtime.connect({ name: `${PREFIX}${id}` });
    worker.onmessage = ev => {
        port.postMessage({ data: ev.data });
    };
    worker.onerror = ev => {
        port.postMessage({ error: ev.message || 'worker error' });
    };
    port.onMessage.addListener(msg => {
        if ( msg instanceof Object === false ) { return; }
        worker.postMessage(msg.data);
    });
    port.onDisconnect.addListener(( ) => {
        void chrome.runtime.lastError;
        worker.terminate();
        worker = null;
    });
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if ( msg instanceof Object === false ) { return; }
    const details = msg.uBOworker;
    if ( details instanceof Object === false ) { return; }
    // Only the extension's service worker may create workers
    if ( sender?.tab !== undefined ) { return; }
    if ( sender?.id !== chrome.runtime.id ) { return; }
    if ( typeof sender.url !== 'string' ) { return; }
    if ( new URL(sender.url).origin !== extensionOrigin ) { return; }
    const { id, path } = details;
    if ( typeof id !== 'string' || ALLOWED_WORKERS.has(path) === false ) {
        console.error(`offscreen: worker not allowed: ${path}`);
        sendResponse({ error: 'worker not allowed' });
        return;
    }
    const error = startWorker(id, path);
    sendResponse(error !== undefined ? { error } : { ok: true });
});
