import { EventEmitter } from 'events';
import WebSocket from 'ws';

export interface CdpCallResult {
    resolve: (value: unknown) => void;
    reject: (reason?: NodeJS.ErrnoException | Error | string | null | unknown) => void;
    timeoutId: NodeJS.Timeout;
}

export class CdpConnection extends EventEmitter {
    private ws: WebSocket | null = null;
    private isConnectedFlag: boolean = false;
    private idCounter = 1;
    private pendingCalls = new Map<number, CdpCallResult>();

    constructor(
        private readonly targetUrl: string,
        private readonly cdpCallTimeout: number = 30000
    ) {
        super();
    }

    async connect(): Promise<void> {
        this.ws = new WebSocket(this.targetUrl);

        await new Promise<void>((resolve, reject) => {
            if (!this.ws) return reject(new Error('WebSocket not initialized'));
            this.ws.on('open', () => {
                this.isConnectedFlag = true;
                resolve();
            });
            this.ws.on('error', reject);
        });

        this.ws.on('message', (msg: WebSocket.Data) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.id !== undefined && this.pendingCalls.has(data.id)) {
                    const { resolve, reject, timeoutId } = this.pendingCalls.get(data.id)!;
                    clearTimeout(timeoutId);
                    this.pendingCalls.delete(data.id);
                    if (data.error) reject(data.error); else resolve(data.result);
                }

                // Forward CDP events via EventEmitter (Network.*, Runtime.*, etc.)
                if (data.method) {
                    this.emit(data.method, data.params);
                }
            } catch { /* ignored */ }
        });

        this.ws.on('close', () => {
            this.isConnectedFlag = false;
            this.clearPendingCalls(new Error('WebSocket disconnected'));
            this.ws = null;
            this.emit('disconnected');
        });
    }

    async call(method: string, params: unknown = {}): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket is not connected');
        }

        return new Promise((resolve, reject) => {
            const id = this.idCounter++;
            const timeoutId = setTimeout(() => {
                if (this.pendingCalls.has(id)) {
                    this.pendingCalls.delete(id);
                    reject(new Error(`Timeout calling CDP method ${method}`));
                }
            }, this.cdpCallTimeout);

            this.pendingCalls.set(id, { resolve, reject, timeoutId });
            this.ws!.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Quietly disconnect the existing connection (no reconnect attempts/events). */
    disconnectQuietly(): void {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
            this.isConnectedFlag = false;
            this.clearPendingCalls(new Error('Disconnected quietly'));
        }
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
        }
    }

    private clearPendingCalls(error: Error): void {
        this.pendingCalls.forEach((call) => {
            clearTimeout(call.timeoutId);
            call.reject(error);
        });
        this.pendingCalls.clear();
    }

    isConnected(): boolean {
        return this.isConnectedFlag;
    }
}
