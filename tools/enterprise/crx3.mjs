#!/usr/bin/env node
/*******************************************************************************

    CRX3 packer for the enterprise MV3 build -- no third-party dependencies.

    Usage:
      node tools/enterprise/crx3.mjs pack --dir <unpacked> --key <private.pem> --out <file.crx>
      node tools/enterprise/crx3.mjs id   --key <private.pem>
      node tools/enterprise/crx3.mjs id   --pubkey <public.pem>
      node tools/enterprise/crx3.mjs pubkey --key <private.pem>   (base64 SPKI, for manifest "key")
      node tools/enterprise/crx3.mjs verify --crx <file.crx>

    The private key must live outside the repository. This tool refuses a key
    path located inside the repository, never prints the private key, and never
    copies it into the archive.

    CRX3 format (components/crx_file/crx3.proto):
      "Cr24" | uint32le 3 | uint32le headerSize | CrxFileHeader | zip
      CrxFileHeader {
        repeated AsymmetricKeyProof sha256_with_rsa = 2;
        optional bytes signed_header_data = 10000;  // SignedData { bytes crx_id = 1; }
      }
      AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
      signature = RSA-PKCS1v1.5-SHA256(
          "CRX3 SignedData\x00" | uint32le len(signed_header_data) |
          signed_header_data | zip
      )
      crx_id = sha256(SPKI DER)[0:16]

*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

/******************************************************************************/

const repoRoot = (( ) => {
    try {
        return execFileSync('git', [ 'rev-parse', '--show-toplevel' ], {
            cwd: path.dirname(new URL(import.meta.url).pathname),
            stdio: [ 'ignore', 'pipe', 'ignore' ],
        }).toString().trim();
    } catch {
        return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    }
})();

const isInside = (child, parent) => {
    const rel = path.relative(fs.realpathSync(parent), child);
    return rel === '' || (rel.startsWith('..') === false && path.isAbsolute(rel) === false);
};

const loadPrivateKey = keyPath => {
    if ( typeof keyPath !== 'string' || keyPath === '' ) {
        throw new Error('missing --key');
    }
    const resolved = fs.realpathSync(path.resolve(keyPath));
    if ( isInside(resolved, repoRoot) ) {
        throw new Error(`refusing to use a private key located inside the repository (${repoRoot})`);
    }
    return crypto.createPrivateKey(fs.readFileSync(resolved));
};

const spkiFromPrivateKey = privateKey =>
    crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });

const spkiFromPublicPem = pubPath =>
    crypto.createPublicKey(fs.readFileSync(pubPath)).export({ type: 'spki', format: 'der' });

const crxIdBytes = spki => crypto.createHash('sha256').update(spki).digest().subarray(0, 16);

// Chromium maps each hex digit of the 16-byte crx_id to 'a'-'p'
const idFromCrxIdBytes = bytes => {
    let out = '';
    for ( const c of Buffer.from(bytes).toString('hex') ) {
        out += String.fromCharCode(0x61 + parseInt(c, 16));
    }
    return out;
};

export const extensionIdFromSpki = spki => idFromCrxIdBytes(crxIdBytes(spki));

/******************************************************************************/

// Minimal protobuf encoding (length-delimited fields only)

const varint = n => {
    const out = [];
    while ( n > 0x7f ) {
        out.push((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
    }
    out.push(n);
    return Buffer.from(out);
};

const pbBytes = (field, bytes) => Buffer.concat([
    varint(field * 8 + 2), varint(bytes.length), bytes,
]);

/******************************************************************************/

// Deterministic zip writer: sorted entries, fixed timestamps, deflate.

const listFiles = dir => {
    const out = [];
    const walk = rel => {
        const abs = path.join(dir, rel);
        for ( const entry of fs.readdirSync(abs, { withFileTypes: true }) ) {
            const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if ( entry.isDirectory() ) {
                walk(relPath);
            } else if ( entry.isFile() ) {
                out.push(relPath);
            }
        }
    };
    walk('');
    return out.sort();
};

const forbiddenInArchive = rel =>
    /\.(pem|der|key|p12|pfx)$/i.test(rel) || /(^|\/)\.git(\/|$)/.test(rel);

export const zipDirectory = dir => {
    const DOS_TIME = 0;
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
    const locals = [];
    const centrals = [];
    let offset = 0;
    for ( const rel of listFiles(dir) ) {
        if ( forbiddenInArchive(rel) ) {
            throw new Error(`refusing to pack key-like or VCS file: ${rel}`);
        }
        const data = fs.readFileSync(path.join(dir, rel));
        const name = Buffer.from(rel, 'utf8');
        const crc = zlib.crc32(data) >>> 0;
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const useDeflate = deflated.length < data.length;
        const body = useDeflate ? deflated : data;
        const method = useDeflate ? 8 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(centrals.length / 2, 8);
    end.writeUInt16LE(centrals.length / 2, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([ ...locals, centralDir, end ]);
};

/******************************************************************************/

export const packCrx3 = (zip, privateKey) => {
    const spki = spkiFromPrivateKey(privateKey);
    const signedHeaderData = pbBytes(1, crxIdBytes(spki));
    const sizeLE = Buffer.alloc(4);
    sizeLE.writeUInt32LE(signedHeaderData.length);
    const signer = crypto.createSign('sha256');
    signer.update(Buffer.from('CRX3 SignedData\x00', 'binary'));
    signer.update(sizeLE);
    signer.update(signedHeaderData);
    signer.update(zip);
    const signature = signer.sign(privateKey);
    const proof = Buffer.concat([ pbBytes(1, spki), pbBytes(2, signature) ]);
    const header = Buffer.concat([ pbBytes(2, proof), pbBytes(10000, signedHeaderData) ]);
    const preamble = Buffer.alloc(12);
    preamble.write('Cr24', 0, 'binary');
    preamble.writeUInt32LE(3, 4);
    preamble.writeUInt32LE(header.length, 8);
    return { crx: Buffer.concat([ preamble, header, zip ]), id: extensionIdFromSpki(spki) };
};

/******************************************************************************/

// Minimal protobuf decoding, for verification

const readVarint = (buf, pos) => {
    let n = 0, mul = 1;
    for (;;) {
        const b = buf[pos++];
        n += (b & 0x7f) * mul;
        if ( (b & 0x80) === 0 ) { break; }
        mul *= 128;
    }
    return [ n, pos ];
};

const decodeFields = buf => {
    const fields = [];
    let pos = 0;
    while ( pos < buf.length ) {
        let key, len;
        [ key, pos ] = readVarint(buf, pos);
        if ( (key & 7) !== 2 ) { throw new Error('unexpected wire type'); }
        [ len, pos ] = readVarint(buf, pos);
        fields.push([ Math.floor(key / 8), buf.subarray(pos, pos + len) ]);
        pos += len;
    }
    return fields;
};

export const verifyCrx3 = crx => {
    if ( crx.toString('binary', 0, 4) !== 'Cr24' ) { throw new Error('bad magic'); }
    if ( crx.readUInt32LE(4) !== 3 ) { throw new Error('not CRX3'); }
    const headerSize = crx.readUInt32LE(8);
    const header = crx.subarray(12, 12 + headerSize);
    const zip = crx.subarray(12 + headerSize);
    const fields = decodeFields(header);
    const signedHeaderData = fields.find(f => f[0] === 10000)?.[1];
    if ( signedHeaderData === undefined ) { throw new Error('missing signed_header_data'); }
    const crxId = decodeFields(signedHeaderData).find(f => f[0] === 1)?.[1];
    const sizeLE = Buffer.alloc(4);
    sizeLE.writeUInt32LE(signedHeaderData.length);
    let idMatched = false;
    for ( const [ field, proof ] of fields ) {
        if ( field !== 2 ) { continue; }
        const parts = decodeFields(proof);
        const spki = parts.find(f => f[0] === 1)[1];
        const signature = parts.find(f => f[0] === 2)[1];
        const verifier = crypto.createVerify('sha256');
        verifier.update(Buffer.from('CRX3 SignedData\x00', 'binary'));
        verifier.update(sizeLE);
        verifier.update(signedHeaderData);
        verifier.update(zip);
        const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
        if ( verifier.verify(publicKey, signature) === false ) {
            throw new Error('bad signature');
        }
        if ( crxIdBytes(spki).equals(crxId) ) { idMatched = true; }
    }
    if ( idMatched === false ) { throw new Error('no proof matches crx_id'); }
    return { id: idFromCrxIdBytes(crxId), zipSize: zip.length };
};

/******************************************************************************/

const parseArgs = argv => {
    const out = { _: [] };
    for ( let i = 0; i < argv.length; i++ ) {
        const a = argv[i];
        if ( a.startsWith('--') ) {
            out[a.slice(2)] = argv[i+1];
            i += 1;
        } else {
            out._.push(a);
        }
    }
    return out;
};

const main = ( ) => {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    switch ( cmd ) {
    case 'pack': {
        const dir = path.resolve(args.dir);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        const privateKey = loadPrivateKey(args.key);
        const { crx, id } = packCrx3(zipDirectory(dir), privateKey);
        verifyCrx3(crx);
        fs.writeFileSync(args.out, crx);
        console.log(JSON.stringify({ id, version: manifest.version, out: args.out, size: crx.length }));
        break;
    }
    case 'id': {
        const spki = args.pubkey
            ? spkiFromPublicPem(args.pubkey)
            : spkiFromPrivateKey(loadPrivateKey(args.key));
        console.log(extensionIdFromSpki(spki));
        break;
    }
    case 'pubkey': {
        const spki = args.pubkey
            ? spkiFromPublicPem(args.pubkey)
            : spkiFromPrivateKey(loadPrivateKey(args.key));
        console.log(spki.toString('base64'));
        break;
    }
    case 'verify': {
        console.log(JSON.stringify(verifyCrx3(fs.readFileSync(args.crx))));
        break;
    }
    default:
        console.error('usage: crx3.mjs pack|id|pubkey|verify ...');
        process.exit(2);
    }
};

if ( process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname) ) {
    try {
        main();
    } catch (e) {
        console.error(`crx3: ${e.message}`);
        process.exit(1);
    }
}
