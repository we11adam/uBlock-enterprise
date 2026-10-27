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

// Chromium MV3 enterprise build: service worker entry point, in place of
// background.html. It is at the root of the package so that the relative
// URLs uBO uses (i.e. `./js/wasm/...`) resolve as they do from the
// background page.
//
// Order matters: sw-env.js must be evaluated first, as it provides the
// environment uBO expects (vAPI, the browser namespace, shims) and patches
// event registration before any other module registers listeners.

import './js/sw-env.js';
import './js/start.js';
import './js/sw-session.js';
import './js/sw-policy.js';
