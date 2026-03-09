/**
 * Shared TCP / CDP port utilities.
 *
 * Used by antigravityLauncher, doctor, and open commands.
 */

import * as http from 'http';
import * as net from 'net';
import { CDP_PORTS } from './cdpPorts';

/**
 * Check if CDP responds on the specified port.
 *
 * Sends a GET request to `http://127.0.0.1:{port}/json/list` and resolves
 * `true` when the response is a valid JSON array.
 */
export function checkCdpPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve(Array.isArray(parsed));
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Check whether a TCP port is available (not in use) by attempting to listen on it.
 */
export function isPortFree(port: number): Promise<boolean> {
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
