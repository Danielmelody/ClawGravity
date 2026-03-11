import WebSocket from 'ws';
import * as http from 'http';

const CDP_PORT = 9223;

async function main() {
    const pages: any[] = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });

    const page = pages.find(p => p.title?.includes('antigravity-tunnel'));
    if (!page) { console.error('No antigravity-tunnel page found'); process.exit(1); }

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });

    let idCounter = 1;
    const pending = new Map<number, any>();
    ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
        }
    });

    function call(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = idCounter++;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 15000);
        });
    }

    async function evalJS(expression: string): Promise<any> {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 12000 });
        if (result?.exceptionDetails) return { _error: result.exceptionDetails.exception?.description?.slice(0, 500) };
        return result?.result?.value;
    }

    // Since Network.requestWillBeSent missed the past traffic, let's try reading all storage endpoints
    const dbTest = await evalJS(`
        (async () => {
            try {
                // We don't have the port directly. Let's send a fake postMessage if we can find the webview.
                return { ok: true, globals: Object.keys(window).filter(k=>k.includes('cascade')) };
            } catch (e) { return { error: e.message }; }
        })()
    `);
    console.log('Main frame globals:', JSON.stringify(dbTest));

    // Wait, let's ask the user to just send one more letter so we can capture the network traffic.
    // Actually, I can just use my existing discoverAllLSConnections() to find all pairs of ports & tokens.
    // It is in src/services/grpcCascadeClient.ts
    // I can literally import it here and use it!
    
    ws.close();
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
