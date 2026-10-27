/*******************************************************************************

    Minimal Chrome DevTools Protocol client (Node >= 22, no dependencies).
    Used only by the test harness to drive a real Chrome which received the
    extension through genuine managed policy.

*/

export class CDP {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.listeners = new Set();
        ws.addEventListener('message', ev => {
            const msg = JSON.parse(ev.data);
            if ( msg.id !== undefined ) {
                const p = this.pending.get(msg.id);
                if ( p === undefined ) { return; }
                this.pending.delete(msg.id);
                if ( msg.error ) {
                    p.reject(new Error(`${p.method}: ${msg.error.message}`));
                } else {
                    p.resolve(msg.result);
                }
                return;
            }
            for ( const fn of this.listeners ) { fn(msg); }
        });
    }

    static async connect(port = 9222) {
        let lastErr;
        for ( let i = 0; i < 100; i++ ) {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/json/version`);
                const { webSocketDebuggerUrl } = await r.json();
                const ws = new WebSocket(webSocketDebuggerUrl);
                await new Promise((resolve, reject) => {
                    ws.addEventListener('open', resolve, { once: true });
                    ws.addEventListener('error', reject, { once: true });
                });
                return new CDP(ws);
            } catch (e) {
                lastErr = e;
                await sleep(200);
            }
        }
        throw lastErr;
    }

    send(method, params = {}, sessionId = undefined, timeout = 30000) {
        const id = ++this.id;
        const msg = { id, method, params };
        if ( sessionId ) { msg.sessionId = sessionId; }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(( ) => {
                this.pending.delete(id);
                reject(new Error(`${method}: timeout`));
            }, timeout);
            this.pending.set(id, {
                method,
                resolve: v => { clearTimeout(timer); resolve(v); },
                reject: e => { clearTimeout(timer); reject(e); },
            });
            this.ws.send(JSON.stringify(msg));
        });
    }

    on(fn) {
        this.listeners.add(fn);
        return ( ) => this.listeners.delete(fn);
    }

    waitFor(predicate, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(( ) => { off(); reject(new Error('waitFor: timeout')); }, timeout);
            const off = this.on(msg => {
                if ( predicate(msg) ) { clearTimeout(timer); off(); resolve(msg); }
            });
        });
    }

    async targets() {
        const { targetInfos } = await this.send('Target.getTargets');
        return targetInfos;
    }

    async extensionWorker(extensionId) {
        const prefix = `chrome-extension://${extensionId}/`;
        const infos = await this.targets();
        return infos.find(t => t.type === 'service_worker' && t.url.startsWith(prefix));
    }

    async waitForExtensionWorker(extensionId, timeout = 60000) {
        const until = Date.now() + timeout;
        while ( Date.now() < until ) {
            const t = await this.extensionWorker(extensionId);
            if ( t ) { return t; }
            await sleep(250);
        }
        throw new Error(`extension worker ${extensionId} not found`);
    }

    async attach(targetId) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        return sessionId;
    }

    async evaluate(sessionId, expression, timeout = 30000) {
        const r = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        }, sessionId, timeout);
        if ( r.exceptionDetails ) {
            const d = r.exceptionDetails;
            throw new Error(`evaluate: ${d.exception?.description || d.text}`);
        }
        return r.result.value;
    }

    async evalInWorker(extensionId, expression) {
        const t = await this.waitForExtensionWorker(extensionId);
        const sessionId = await this.attach(t.targetId);
        try {
            return await this.evaluate(sessionId, expression);
        } finally {
            await this.send('Target.detachFromTarget', { sessionId }).catch(( ) => {});
        }
    }

    async waitInWorker(extensionId, expression, timeout = 60000) {
        const until = Date.now() + timeout;
        let last;
        while ( Date.now() < until ) {
            last = await this.evalInWorker(extensionId, expression).catch(e => e.message);
            if ( last === true ) { return true; }
            await sleep(250);
        }
        throw new Error(`waitInWorker: ${expression} => ${last}`);
    }

    // Stop the extension service worker the same way Puppeteer's
    // `WebWorker.close()` does (Target.closeTarget on the worker target).
    async stopExtensionWorker(extensionId) {
        const t = await this.extensionWorker(extensionId);
        if ( t === undefined ) { return false; }
        await this.send('Target.closeTarget', { targetId: t.targetId });
        const until = Date.now() + 10000;
        while ( Date.now() < until ) {
            if ( (await this.extensionWorker(extensionId)) === undefined ) { return true; }
            await sleep(100);
        }
        throw new Error('extension worker did not stop');
    }

    async newPage(url = 'about:blank') {
        const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
        const sessionId = await this.attach(targetId);
        await this.send('Page.enable', {}, sessionId);
        await this.send('Runtime.enable', {}, sessionId);
        const page = new Page(this, targetId, sessionId);
        if ( url !== 'about:blank' ) { await page.goto(url); }
        return page;
    }
}

export class Page {
    constructor(cdp, targetId, sessionId) {
        this.cdp = cdp;
        this.targetId = targetId;
        this.sessionId = sessionId;
    }
    async goto(url, timeout = 20000) {
        const loaded = this.cdp.waitFor(m =>
            m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', timeout
        ).catch(( ) => null);
        const r = await this.cdp.send('Page.navigate', { url }, this.sessionId, timeout);
        if ( r.errorText ) { return { errorText: r.errorText }; }
        await loaded;
        return { errorText: '' };
    }
    evaluate(expression, timeout) {
        return this.cdp.evaluate(this.sessionId, expression, timeout);
    }
    async waitForFunction(expression, timeout = 10000) {
        const until = Date.now() + timeout;
        let last;
        while ( Date.now() < until ) {
            last = await this.evaluate(expression).catch(e => e.message);
            if ( last === true ) { return true; }
            await sleep(100);
        }
        return last;
    }
    close() {
        return this.cdp.send('Target.closeTarget', { targetId: this.targetId });
    }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
