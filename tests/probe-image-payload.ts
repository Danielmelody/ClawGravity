/**
 * Probe script: Intercept Antigravity LS API calls to discover
 * what payload format is used when sending images via SendUserCascadeMessage.
 *
 * Usage: npx tsx tests/probe-image-payload.ts
 *
 * While running:
 *   1. Go to Antigravity IDE
 *   2. Drag an image into the chat input
 *   3. Type some text
 *   4. Press Enter to send
 *   5. Watch the console output for the payload structure
 */

import * as http from 'http';
import WebSocket from 'ws';

const CDP_PORTS = [13338, 13339, 13340, 13341, 13342, 13343, 13344, 13345];

async function getJson(url: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function findAntigravityPage(): Promise<{ wsUrl: string; port: number } | null> {
    for (const port of CDP_PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            const page = list.find((t: any) =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                t.url?.includes('workbench')
            );
            if (page) {
                console.log(`Found Antigravity on port ${port}: "${page.title}"`);
                return { wsUrl: page.webSocketDebuggerUrl, port };
            }
        } catch { }
    }
    return null;
}

async function main() {
    const target = await findAntigravityPage();
    if (!target) {
        console.error('No Antigravity IDE found on CDP ports');
        process.exit(1);
    }

    console.log(`Connecting to: ${target.wsUrl}`);
    const ws = new WebSocket(target.wsUrl);

    let msgId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

    function send(method: string, params: Record<string, any> = {}): Promise<any> {
        const id = msgId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());

        // Handle responses
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
            return;
        }

        // Handle events
        if (msg.method === 'Network.requestWillBeSent') {
            const req = msg.params;
            const url: string = req.request?.url || '';

            if (url.includes('SendUserCascadeMessage')) {
                console.log('\n' + '='.repeat(80));
                console.log('🎯 INTERCEPTED: SendUserCascadeMessage');
                console.log('='.repeat(80));
                console.log('URL:', url);

                const postData = req.request?.postData;
                if (postData) {
                    try {
                        const parsed = JSON.parse(postData);
                        console.log('\n📦 PAYLOAD (pretty):');
                        console.log(JSON.stringify(parsed, null, 2).slice(0, 5000));
                        
                        // Specifically look at items structure
                        if (parsed.items) {
                            console.log('\n🔍 ITEMS STRUCTURE:');
                            for (let i = 0; i < parsed.items.length; i++) {
                                const item = parsed.items[i];
                                console.log(`  items[${i}] keys: ${Object.keys(item).join(', ')}`);
                                for (const [key, value] of Object.entries(item)) {
                                    if (typeof value === 'string' && value.length > 200) {
                                        console.log(`  items[${i}].${key}: (${value.length} chars) ${value.slice(0, 100)}...`);
                                    } else {
                                        console.log(`  items[${i}].${key}:`, JSON.stringify(value));
                                    }
                                }
                            }
                        }
                        
                        // Look for any image-related fields at any level
                        const imageKeys = findImageKeys(parsed);
                        if (imageKeys.length > 0) {
                            console.log('\n🖼️ IMAGE-RELATED FIELDS:');
                            imageKeys.forEach(k => console.log(`  ${k}`));
                        }
                    } catch {
                        console.log('Raw postData (first 2000):', postData.slice(0, 2000));
                    }
                } else {
                    console.log('⚠️ No postData captured (may be binary/proto?)');
                }
                console.log('='.repeat(80) + '\n');
            }

            // Also catch StartCascade with any payload
            if (url.includes('StartCascade')) {
                const postData = req.request?.postData;
                if (postData) {
                    try {
                        const parsed = JSON.parse(postData);
                        console.log('\n🎯 StartCascade payload:');
                        console.log(JSON.stringify(parsed, null, 2).slice(0, 3000));
                    } catch { }
                }
            }
        }
    });

    ws.on('open', async () => {
        console.log('CDP connected.');

        // Enable Network domain with request body capture
        await send('Network.enable', {
            maxPostDataSize: 1024 * 1024 * 10, // 10MB to capture base64 images
        });

        console.log('\n📡 Network interception active.');
        console.log('👉 Now go to Antigravity IDE:');
        console.log('   1. Drag an image into the chat input');
        console.log('   2. Type some text');
        console.log('   3. Press Enter to send');
        console.log('   This script will capture the payload structure.\n');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        process.exit(1);
    });
}

/**
 * Recursively find any keys that might be image-related
 */
function findImageKeys(obj: any, prefix = ''): string[] {
    const results: string[] = [];
    if (!obj || typeof obj !== 'object') return results;

    const imageKeywords = ['image', 'img', 'photo', 'picture', 'file', 'uri', 'base64', 'blob', 'attachment', 'media', 'binary'];

    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const lowerKey = key.toLowerCase();

        if (imageKeywords.some(kw => lowerKey.includes(kw))) {
            const valuePreview = typeof value === 'string'
                ? (value.length > 100 ? `(${value.length} chars) ${value.slice(0, 80)}...` : value)
                : typeof value === 'object'
                    ? JSON.stringify(value)?.slice(0, 200)
                    : String(value);
            results.push(`${path} = ${valuePreview}`);
        }

        if (typeof value === 'object' && value !== null) {
            results.push(...findImageKeys(value, path));
        }
    }

    return results;
}

main().catch(console.error);
