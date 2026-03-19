/**
 * Shared TCP / CDP port utilities.
 *
 * Used by antigravityLauncher, doctor, and open commands.
 */

import * as http from 'http';
import * as net from 'net';
import { CDP_PORTS } from './cdpPorts';

export interface CdpTargetInfo {
    readonly type?: string;
    readonly url?: string;
    readonly title?: string;
}

/**
 * Read Chrome DevTools targets from the specified port.
 *
 * Returns null when the port does not respond or the payload is invalid.
 */
export function fetchCdpTargets(port: number): Promise<CdpTargetInfo[] | null> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(Array.isArray(parsed) ? parsed as CdpTargetInfo[] : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(null);
        });
    });
}

/**
 * Check if CDP responds on the specified port.
 *
 * Sends a GET request to `http://127.0.0.1:{port}/json/list` and resolves
 * `true` when the response is a valid JSON array.
 */
export async function checkCdpPort(port: number): Promise<boolean> {
    return (await fetchCdpTargets(port)) !== null;
}

/**
 * Check whether a TCP port is available (not in use) by attempting to listen on it.
 */
function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Find the first free CDP port from CDP_PORTS.
 * Returns null if all ports are occupied.
 */
export async function findFreeCdpPort(): Promise<number | null> {
    for (const port of CDP_PORTS) {
        if (await isPortFree(port)) {
            return port;
        }
    }
    return null;
}
