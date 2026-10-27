#!/usr/bin/env node
/*******************************************************************************

    Generate a Chromium extension update manifest (gupdate protocol 2.0).

    Usage:
      node tools/enterprise/update-xml.mjs --id <extension-id> --version <x.y.z.w> \
          --codebase <https://host/path/file.crx> [--out update.xml]

    Two distinct URLs are involved in self-hosting:
      - the *update manifest URL* (this XML file), which goes into the
        ExtensionInstallForcelist / ExtensionSettings `update_url` policy;
      - the *CRX URL* (`codebase` attribute in this XML), which is where
        Chrome downloads the package from. Policy never references it.

*/

import * as fs from 'node:fs';

const xmlEscape = s => s.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
})[c]);

export const makeUpdateXml = ({ id, version, codebase, prodversionmin }) => {
    if ( /^[a-p]{32}$/.test(id) === false ) {
        throw new Error(`invalid extension id: ${id}`);
    }
    if ( /^\d+(\.\d+){0,3}$/.test(version) === false ) {
        throw new Error(`invalid version: ${version}`);
    }
    if ( /^https?:\/\//.test(codebase) === false ) {
        throw new Error(`invalid codebase URL: ${codebase}`);
    }
    const min = prodversionmin ? ` prodversionmin='${xmlEscape(prodversionmin)}'` : '';
    return [
        `<?xml version='1.0' encoding='UTF-8'?>`,
        `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>`,
        `  <app appid='${id}'>`,
        `    <updatecheck codebase='${xmlEscape(codebase)}' version='${version}'${min} />`,
        `  </app>`,
        `</gupdate>`,
        '',
    ].join('\n');
};

const parseArgs = argv => {
    const out = {};
    for ( let i = 0; i < argv.length; i += 2 ) {
        out[argv[i].replace(/^--/, '')] = argv[i+1];
    }
    return out;
};

if ( process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname) ) {
    try {
        const args = parseArgs(process.argv.slice(2));
        const xml = makeUpdateXml(args);
        if ( args.out ) {
            fs.writeFileSync(args.out, xml);
        } else {
            process.stdout.write(xml);
        }
    } catch (e) {
        console.error(`update-xml: ${e.message}`);
        process.exit(1);
    }
}
