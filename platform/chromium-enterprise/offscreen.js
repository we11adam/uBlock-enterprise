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

const PREFIX = 'uBO-worker|';

const ALLOWED_WORKERS = new Set([
    '/js/reverselookup-worker.js',
    '/js/diff-updater.js',
]);

const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;

chrome.runtime.onConnect.addListener(port => {
    if ( port.name.startsWith(PREFIX) === false ) { return; }
    // Only the extension's service worker may create workers
    const { sender } = port;
    if ( sender?.tab !== undefined ) { return port.disconnect(); }
    if ( sender?.id !== chrome.runtime.id ) { return port.disconnect(); }
    if ( typeof sender.url !== 'string' ) { return port.disconnect(); }
    if ( new URL(sender.url).origin !== extensionOrigin ) {
        return port.disconnect();
    }
    let path;
    try {
        path = new URL(port.name.slice(PREFIX.length), `${extensionOrigin}/`).pathname;
    } catch {
    }
    if ( ALLOWED_WORKERS.has(path) === false ) {
        console.error(`offscreen: worker not allowed: ${port.name}`);
        return port.disconnect();
    }
    let worker;
    try {
        worker = new Worker(path);
    } catch (reason) {
        port.postMessage({ error: `${reason}` });
        return port.disconnect();
    }
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
        worker.terminate();
        worker = null;
    });
    port.postMessage('ready');
});
