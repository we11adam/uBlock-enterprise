/*******************************************************************************

    Generates `js/scriptlet-lib.js` for the Chromium MV3 enterprise build.

    Under MV3, an extension can't execute code strings in web pages: code is
    injected through `chrome.scripting.executeScript({ func, args })`, where
    `func` is serialized with Function.prototype.toString(). uBO assembles
    scriptlet code at runtime from templates and code strings, so instead this
    generates, at build time, one self-contained function per world (MAIN,
    ISOLATED) which contains:

    - uBO's scriptlet framework, i.e. the scriptlet templates from
      src/js/scriptlet*.template.js, with the placeholders bound to the
      function's argument instead of being replaced by code strings;
    - all builtin scriptlets of that world, with their dependencies;
    - for the MAIN world, all scriptlets which are imported at runtime from
      the text resources in /web_accessible_resources/ (i.e. noeval.js,
      nobab2.js, etc.), transformed exactly as in make-scriptlets.js'
      importScriptlet(), and keyed as `war:<resource name>`.

    At runtime, the extension provides the data computed by the very same
    scriptlet compiler as on other platforms (make-scriptlets.js): the
    hostname/arglist tables, and the list of scriptlet functions referenced by
    the arglists.

    Usage: node make-scriptlet-lib.mjs <build-dir>

*/

import * as espree from 'espree';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/******************************************************************************/

const buildDir = path.resolve(process.argv[2] ?? '');
if ( fs.existsSync(path.join(buildDir, 'manifest.json')) === false ) {
    console.error('Usage: node make-scriptlet-lib.mjs <build-dir>');
    process.exit(1);
}

const readText = rel => fs.readFileSync(path.join(buildDir, rel), 'utf8');

const fail = msg => {
    console.error(`make-scriptlet-lib: ${msg}`);
    process.exit(1);
};

const replaceOnce = (text, needle, replacement) => {
    const pos = text.indexOf(needle);
    if ( pos === -1 ) { fail(`placeholder not found: ${needle}`); }
    if ( text.indexOf(needle, pos + needle.length) !== -1 ) {
        fail(`placeholder found more than once: ${needle}`);
    }
    return text.slice(0, pos) + replacement + text.slice(pos + needle.length);
};

const replaceAll = (text, needle, replacement, expectedMin = 1) => {
    const count = text.split(needle).length - 1;
    if ( count < expectedMin ) { fail(`placeholder not found: ${needle}`); }
    return text.split(needle).join(replacement);
};

// Same as removeTopCommentBlock() in redirect-engine.js
const removeTopCommentBlock = text =>
    text.replace(/^\/\*[\S\s]+?\*\/\s*/g, '');

/******************************************************************************/

// Data template: what the extension passes as the `templates.core` argument
// of ScriptletFilteringEngineEx.getScriptletData(): one placeholder per line,
// in this order. Must match platform/chromium-enterprise/vapi-scripting.js.
const DATA_FIELDS = [
    'hasHostnames',
    'hasEntities',
    'hasAncestors',
    'hasRegexes',
    'scriptletHostnames',
    'scriptletArglistRefs',
    'scriptletFromRegexes',
    'scriptletArglists',
    'scriptletArgs',
];

/******************************************************************************/

// Scriptlet framework templates

const templateOf = name => {
    const text = removeTopCommentBlock(readText(`js/${name}`));
    // The framework passes its state between templates through a global
    // property whose name is a secret: since all templates are executed
    // within the same function call, use a local object instead, so that
    // nothing is exposed to the page.
    return replaceAll(text, 'self[$SECRET_ID$]', '$scriptletScope$[$SECRET_ID$]');
};

let templateBegin = templateOf('scriptlet-begin.template.js');
let templateCore = templateOf('scriptlet.template.js');
let templateEnd = templateOf('scriptlet-end.template.js');

templateCore = replaceOnce(templateCore, '// ruleset: $rulesetId$', '// ruleset: uBlock');
for ( const field of DATA_FIELDS ) {
    templateCore = replaceOnce(templateCore, `self.$${field}$`, `$details$.data.${field}`);
}
templateBegin = replaceOnce(templateBegin, 'self.$scriptletSecret$', '$details$.secret');
templateCore = replaceOnce(templateCore, 'self.$scriptletSecret$', '$details$.secret');
templateEnd = replaceOnce(templateEnd, 'self.$scriptletSecret$', '$details$.secret');
templateBegin = replaceOnce(templateBegin,
    'self.$scriptletFunctionRefs$',
    '$details$.functionRefs.map(a => $scriptletFunctionTable$[a])'
);

for ( const [ name, text ] of Object.entries({ templateBegin, templateCore, templateEnd }) ) {
    const unbound = (text.match(/self\.\$\w+\$|\$rulesetId\$/g) ?? []).filter(a =>
        a !== 'self.$SCRIPTLET_GLOBALS$' && a !== 'self.$scriptletFunctions$'
    );
    if ( unbound.length !== 0 ) {
        fail(`${name}: unbound placeholders: ${unbound.join(', ')}`);
    }
}

/******************************************************************************/

// Builtin scriptlets

const { builtinScriptlets } = await import(
    pathToFileURL(path.join(buildDir, 'js/resources/scriptlets.js')).href
);

const scriptletsByName = new Map();
for ( const scriptlet of builtinScriptlets ) {
    scriptletsByName.set(scriptlet.name, scriptlet);
}

const worlds = {
    MAIN: { functions: new Map(), table: new Map() },
    ISOLATED: { functions: new Map(), table: new Map() },
};

const addFunction = (world, fnName, code) => {
    const { functions } = worlds[world];
    const existing = functions.get(fnName);
    if ( existing !== undefined && existing !== code ) {
        fail(`${world}: duplicate function name with distinct code: ${fnName}`);
    }
    functions.set(fnName, code);
};

for ( const scriptlet of builtinScriptlets ) {
    // Dependencies are only included as dependencies
    if ( scriptlet.name.endsWith('.js') === false ) { continue; }
    const world = scriptlet.world || 'MAIN';
    const fnName = scriptlet.fn.name;
    if ( /^[A-Za-z_$][\w$]*$/.test(fnName) === false ) {
        fail(`invalid scriptlet function name: ${scriptlet.name}`);
    }
    addFunction(world, fnName, scriptlet.fn.toString());
    worlds[world].table.set(fnName, fnName);
    const dependencies = (scriptlet.dependencies ?? []).slice();
    while ( dependencies.length !== 0 ) {
        const token = dependencies.shift();
        const details = scriptletsByName.get(token);
        if ( details === undefined ) {
            fail(`${scriptlet.name}: unknown dependency ${token}`);
        }
        if ( worlds[world].functions.has(details.fn.name) ) { continue; }
        addFunction(world, details.fn.name, details.fn.toString());
        dependencies.push(...(details.dependencies ?? []));
    }
}

/******************************************************************************/

// Scriptlets imported from text resources in /web_accessible_resources/

const { default: redirectableResources } = await import(
    pathToFileURL(path.join(buildDir, 'js/redirect-resources.js')).href
);

const warNames = [];
for ( const [ name, details ] of redirectableResources ) {
    if ( details.data !== 'text' ) { continue; }
    // make-scriptlets.js' compile() looks up `${token}.js`
    if ( name.endsWith('.js') === false ) { continue; }
    const text = removeTopCommentBlock(readText(`web_accessible_resources/${name}`));
    // Same as importScriptlet() in make-scriptlets.js
    const funcBody = text.replace(/\/\*.+?\*\//gs, '').trim();
    const funcName = `war_${name.replace(/[^\w]/g, '_')}`;
    const code = /^function\s+[^(]+\(.*?\)\s*\{.*\}$/s.test(funcBody)
        ? `function ${funcName}(...args) { // ${name}\n(${funcBody})(...args)\n}`
        : `function ${funcName}() { // ${name}\n${funcBody}\n}`;
    addFunction('MAIN', funcName, code);
    worlds.MAIN.table.set(`war:${name}`, funcName);
    warNames.push(name);
}

/******************************************************************************/

// initCommChannel() from scriptlet-filtering.js: relays log messages from
// MAIN world scriptlets to the logger, through the content script messaging.

const initCommChannelCode = (( ) => {
    const text = readText('js/scriptlet-filtering.js');
    const match = /^export function initCommChannel\(name\) \{\n[\S\s]+?\n\}\n/m.exec(text);
    if ( match === null ) { fail('initCommChannel() not found'); }
    return match[0].replace(/^export /, '').trim();
})();

/******************************************************************************/

const sortedFunctions = world =>
    Array.from(worlds[world].functions).sort((a, b) =>
        a[0].localeCompare(b[0])
    ).map(a => a[1]).join('\n\n');

const functionTable = world => {
    const lines = Array.from(worlds[world].table).sort((a, b) =>
        a[0].localeCompare(b[0])
    ).map(([ key, fnName ]) => `    ${JSON.stringify(key)}: ${fnName},`);
    return `const $scriptletFunctionTable$ = {\n${lines.join('\n')}\n};`;
};

// Not indented: code may contain multi-line template literals.
const assembleWorld = world => {
    const begin = replaceOnce(templateBegin,
        'self.$scriptletFunctions$',
        `${sortedFunctions(world)}\n\n${functionTable(world)}`
    );
    const parts = [
        `export function uBO_scriptlets_${world}($details$) {`,
    ];
    if ( world === 'ISOLATED' ) {
        parts.push(
            initCommChannelCode,
            '    if ( $details$.scriptletGlobals.bcSecret ) {',
            '        initCommChannel($details$.scriptletGlobals.bcSecret);',
            '    }',
            '    if ( $details$.data === undefined ) { return; }',
        );
    }
    parts.push(
        '    const $SCRIPTLET_GLOBALS$ = $details$.scriptletGlobals;',
        '    const $scriptletScope$ = {};',
        begin.trim(),
        templateCore.trim(),
        templateEnd.trim(),
        '}',
    );
    return parts.join('\n');
};

const out = [
    '// Generated by tools/enterprise/make-scriptlet-lib.mjs -- do not edit.',
    '//',
    '// The functions below are never called in the extension context: they are',
    '// serialized and executed in web pages by chrome.scripting.executeScript().',
    '',
    '/* eslint-disable */',
    '',
    `export const DATA_FIELDS = ${JSON.stringify(DATA_FIELDS)};`,
    '',
    `export const MAIN_FUNCTIONS = new Set(${JSON.stringify(Array.from(worlds.MAIN.table.keys()).sort())});`,
    '',
    `export const ISOLATED_FUNCTIONS = new Set(${JSON.stringify(Array.from(worlds.ISOLATED.table.keys()).sort())});`,
    '',
    assembleWorld('MAIN'),
    '',
    assembleWorld('ISOLATED'),
    '',
].join('\n');

// The generated module must parse as a module (service worker), and each
// function must parse as a classic script (web page).
try {
    espree.parse(out, { ecmaVersion: 'latest', sourceType: 'module' });
} catch (reason) {
    fail(`generated module does not parse: ${reason.message} at line ${reason.lineNumber}`);
}
for ( const world of Object.keys(worlds) ) {
    const fn = assembleWorld(world).replace(/^export /, '');
    try {
        espree.parse(`(${fn})`, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch (reason) {
        fail(`${world}: function does not parse as script: ${reason.message}`);
    }
}

const outFile = path.join(buildDir, 'js/scriptlet-lib.js');
fs.writeFileSync(outFile, out);

console.log([
    `make-scriptlet-lib: ${path.relative(process.cwd(), outFile)}`,
    `MAIN: ${worlds.MAIN.table.size} scriptlets (${warNames.length} from text resources),`,
    `${worlds.MAIN.functions.size} functions;`,
    `ISOLATED: ${worlds.ISOLATED.table.size} scriptlets, ${worlds.ISOLATED.functions.size} functions;`,
    `${(out.length / 1024).toFixed(0)} KB`,
].join(' '));
