/*******************************************************************************

    Static check of the MV3 service worker module graph.

    Walks the static import graph starting at the service worker entry of a
    built extension directory and reports constructs which are incompatible
    with an extension service worker:

    - top-level `await` (ERROR): it defers evaluation of every dependent
      module, so event listeners registered at module top level would no
      longer be registered synchronously during the first turn of the event
      loop, which is required for events to be dispatched to a service worker
      woken up by that very event.
    - dynamic `import()` (ERROR): not supported in service workers.
    - top-level references to DOM-only globals (ERROR) and references inside
      functions (WARNING, informational: those code paths must be unreachable
      or guarded in the service worker).

    Usage: node check-sw-graph.mjs <build-dir> [--json]

*/

import * as espree from 'espree';
import fs from 'node:fs';
import path from 'node:path';

const DOM_ONLY = new Set([
    'window', 'document', 'XMLHttpRequest', 'Worker', 'localStorage',
    'sessionStorage', 'Image', 'DOMParser', 'requestIdleCallback',
    'cancelIdleCallback', 'requestAnimationFrame', 'HTMLDocument', 'Element',
    'CSS', 'MouseEvent',
]);

// Modules which are never evaluated in the service worker even though they
// are reachable through the import graph: scriptlet sources are serialized
// with Function.prototype.toString() and executed in web pages.
const PAGE_WORLD_SOURCES = [ 'js/resources/', 'js/scriptlet-lib.js' ];

// Dynamic imports which are only reachable from developer tools (benchmarks,
// DNR ruleset export) and are explicitly unsupported in the MV3 build.
const DEV_ONLY_DYNAMIC_IMPORTS = new Set([
    '/js/benchmarks.js',
    './static-dnr-filtering.js',
]);

const buildDir = path.resolve(process.argv[2] ?? '');
const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'));
const entry = manifest.background?.service_worker;
if ( typeof entry !== 'string' ) {
    console.error('manifest has no background.service_worker');
    process.exit(2);
}

const findings = [];
const visited = new Set();

function report(level, file, node, message) {
    findings.push({
        level,
        file: path.relative(buildDir, file),
        line: node.loc?.start.line ?? 0,
        message,
    });
}

function walk(node, visitor, ancestors = []) {
    if ( node === null || typeof node !== 'object' ) { return; }
    if ( typeof node.type === 'string' ) {
        visitor(node, ancestors);
        ancestors = [ ...ancestors, node ];
    }
    for ( const key of Object.keys(node) ) {
        if ( key === 'loc' || key === 'range' ) { continue; }
        const child = node[key];
        if ( Array.isArray(child) ) {
            for ( const c of child ) { walk(c, visitor, ancestors); }
        } else if ( child && typeof child === 'object' && typeof child.type === 'string' ) {
            walk(child, visitor, ancestors);
        }
    }
}

const isFunctionNode = n =>
    n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression' ||
    n.type === 'MethodDefinition' ||
    n.type === 'PropertyDefinition' ||
    n.type === 'StaticBlock';

function scopeDeclares(ancestors, name) {
    // Coarse: consider a name shadowed if any enclosing function declares a
    // parameter with that name. Good enough for the identifiers we track.
    for ( const a of ancestors ) {
        if ( Array.isArray(a.params) ) {
            for ( const p of a.params ) {
                if ( p.type === 'Identifier' && p.name === name ) { return true; }
            }
        }
    }
    return false;
}

function collectDeclaredNames(ast) {
    const names = new Set();
    const addPattern = p => {
        if ( p === null || p === undefined ) { return; }
        switch ( p.type ) {
        case 'Identifier': names.add(p.name); break;
        case 'ObjectPattern':
            for ( const prop of p.properties ) {
                addPattern(prop.type === 'RestElement' ? prop.argument : prop.value);
            }
            break;
        case 'ArrayPattern': for ( const e of p.elements ) { addPattern(e); } break;
        case 'AssignmentPattern': addPattern(p.left); break;
        case 'RestElement': addPattern(p.argument); break;
        default: break;
        }
    };
    walk(ast, node => {
        switch ( node.type ) {
        case 'VariableDeclarator': addPattern(node.id); break;
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
            if ( node.id ) { names.add(node.id.name); }
            break;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
            names.add(node.local.name);
            break;
        default: break;
        }
    });
    return names;
}

// Guards: `typeof X === 'undefined' || <uses X>`, `typeof X !== 'undefined' &&
// <uses X>`, `if ( typeof X !== 'undefined' ) { <uses X> }`, and the same
// through a constant, i.e. `const noDOM = typeof document === 'undefined' ||
// ...; if ( noDOM !== true ) { <uses document> }`.

function typeofTest(node, operators) {
    if ( node?.type !== 'BinaryExpression' ) { return; }
    if ( operators.includes(node.operator) === false ) { return; }
    const [ a, b ] = node.left.type === 'UnaryExpression'
        ? [ node.left, node.right ]
        : [ node.right, node.left ];
    if ( a.type !== 'UnaryExpression' || a.operator !== 'typeof' ) { return; }
    if ( a.argument.type !== 'Identifier' ) { return; }
    if ( b.type !== 'Literal' || b.value !== 'undefined' ) { return; }
    return a.argument.name;
}

// Names N for which `node` is true whenever N is undefined
function namesUndefinedImpliesTrue(node, out = new Set()) {
    if ( node?.type === 'LogicalExpression' && node.operator === '||' ) {
        namesUndefinedImpliesTrue(node.left, out);
        namesUndefinedImpliesTrue(node.right, out);
        return out;
    }
    const name = typeofTest(node, [ '===', '==' ]);
    if ( name ) { out.add(name); }
    return out;
}

// Names N for which `node` is false whenever N is undefined
function namesUndefinedImpliesFalse(node, flags, out = new Set()) {
    if ( node?.type === 'LogicalExpression' && node.operator === '&&' ) {
        namesUndefinedImpliesFalse(node.left, flags, out);
        namesUndefinedImpliesFalse(node.right, flags, out);
        return out;
    }
    const name = typeofTest(node, [ '!==', '!=' ]);
    if ( name ) { out.add(name); return out; }
    // `!flag`, `flag !== true`, `flag === false`
    let flag;
    if ( node?.type === 'UnaryExpression' && node.operator === '!' ) {
        flag = node.argument;
    } else if ( node?.type === 'BinaryExpression' && node.right.type === 'Literal' ) {
        if ( (node.operator === '!==' && node.right.value === true) ||
             (node.operator === '===' && node.right.value === false) ) {
            flag = node.left;
        }
    }
    if ( flag?.type === 'Identifier' && flags.has(flag.name) ) {
        for ( const n of flags.get(flag.name) ) { out.add(n); }
    }
    return out;
}

function isGuarded(name, ancestors, node, flags) {
    const chain = [ ...ancestors, node ];
    for ( let i = 0; i < chain.length - 1; i++ ) {
        const a = chain[i], child = chain[i+1];
        let names;
        if ( a.type === 'LogicalExpression' && child === a.right ) {
            names = a.operator === '||'
                ? namesUndefinedImpliesTrue(a.left)
                : namesUndefinedImpliesFalse(a.left, flags);
        } else if ( (a.type === 'IfStatement' || a.type === 'ConditionalExpression') ) {
            if ( child === a.consequent ) {
                names = namesUndefinedImpliesFalse(a.test, flags);
            } else if ( child === a.alternate ) {
                names = namesUndefinedImpliesTrue(a.test);
            }
        }
        if ( names?.has(name) ) { return true; }
    }
    return false;
}

function collectGuardFlags(ast) {
    const flags = new Map();
    for ( const stmt of ast.body ) {
        if ( stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const' ) { continue; }
        for ( const d of stmt.declarations ) {
            if ( d.id.type !== 'Identifier' ) { continue; }
            const names = namesUndefinedImpliesTrue(d.init);
            if ( names.size !== 0 ) { flags.set(d.id.name, names); }
        }
    }
    return flags;
}

function checkFile(file) {
    if ( visited.has(file) ) { return; }
    visited.add(file);
    const rel = path.relative(buildDir, file);
    if ( PAGE_WORLD_SOURCES.some(p => rel.startsWith(p)) ) { return; }
    const text = fs.readFileSync(file, 'utf8');
    let ast;
    try {
        ast = espree.parse(text, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            loc: true,
        });
    } catch (e) {
        report('ERROR', file, { loc: { start: { line: e.lineNumber } } }, `parse error: ${e.message}`);
        return;
    }
    const imports = [];
    const declared = collectDeclaredNames(ast);
    const flags = collectGuardFlags(ast);
    walk(ast, (node, ancestors) => {
        switch ( node.type ) {
        case 'ImportDeclaration':
        case 'ExportAllDeclaration':
        case 'ExportNamedDeclaration':
            if ( node.source?.value ) { imports.push(node.source.value); }
            break;
        case 'ImportExpression':
            if ( DEV_ONLY_DYNAMIC_IMPORTS.has(node.source?.value) ) {
                report('WARNING', file, node, `dev-only dynamic import(${node.source.value}) unavailable in service worker`);
                break;
            }
            report('ERROR', file, node, 'dynamic import() is not supported in a service worker');
            break;
        case 'AwaitExpression':
        case 'ForOfStatement':
            if ( node.type === 'ForOfStatement' && node.await !== true ) { break; }
            if ( ancestors.some(isFunctionNode) === false ) {
                report('ERROR', file, node, 'top-level await');
            }
            break;
        case 'Identifier': {
            if ( DOM_ONLY.has(node.name) === false ) { break; }
            if ( declared.has(node.name) ) { break; }
            const parent = ancestors.at(-1);
            // Skip property keys and member properties: `x.document`, `{ window: 1 }`
            if ( parent?.type === 'MemberExpression' && parent.property === node && parent.computed === false ) { break; }
            if ( parent?.type === 'Property' && parent.key === node && parent.computed === false ) { break; }
            if ( parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition' ) { break; }
            if ( scopeDeclares(ancestors, node.name) ) { break; }
            // `typeof document` is a guard, not a use
            if ( parent?.type === 'UnaryExpression' && parent.operator === 'typeof' ) { break; }
            if ( isGuarded(node.name, ancestors, node, flags) ) { break; }
            const inFunction = ancestors.some(isFunctionNode);
            report(inFunction ? 'WARNING' : 'ERROR', file, node,
                `${inFunction ? 'reference' : 'top-level reference'} to DOM-only global \`${node.name}\``);
            break;
        }
        default:
            break;
        }
    });
    for ( const spec of imports ) {
        let target;
        if ( spec.startsWith('/') ) {
            target = path.join(buildDir, spec);
        } else if ( spec.startsWith('.') ) {
            target = path.resolve(path.dirname(file), spec);
        } else {
            report('ERROR', file, { loc: { start: { line: 0 } } }, `bare import specifier: ${spec}`);
            continue;
        }
        if ( fs.existsSync(target) === false ) {
            report('ERROR', file, { loc: { start: { line: 0 } } }, `missing import: ${spec}`);
            continue;
        }
        checkFile(target);
    }
}

checkFile(path.join(buildDir, entry));

const errors = findings.filter(f => f.level === 'ERROR');
if ( process.argv.includes('--json') ) {
    console.log(JSON.stringify({ modules: visited.size, findings }, null, 2));
} else {
    for ( const f of findings ) {
        console.log(`${f.level.padEnd(7)} ${f.file}:${f.line}  ${f.message}`);
    }
    console.log(`\n${visited.size} modules, ${errors.length} error(s), ${findings.length - errors.length} warning(s)`);
}
process.exit(errors.length === 0 ? 0 : 1);
