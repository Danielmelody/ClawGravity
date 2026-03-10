import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';

const execAsync = promisify(exec);

export interface QuotaInfo {
    remainingFraction: number;
    resetTime: string;
}

export interface ModelQuota {
    label: string;
    model: string;
    quotaInfo?: QuotaInfo;
}

export interface UserStatusData {
    clientModelConfigs?: ModelQuota[];
}

export class QuotaService {
    private cachedPort: number | null = null;
    private cachedCsrfToken: string | null = null;
    private cachedPid: number | null = null;

    private extractCsrfToken(commandLine: string): string | null {
        const tokenMatch = commandLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);
        return tokenMatch?.[1] || null;
    }

    private async getLanguageServerProcessInfo(): Promise<{ pid: number, csrf_token: string } | null> {
        try {
            if (process.platform === 'win32') {
                const command = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'language_server' } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"`;
                const { stdout } = await execAsync(command);
                const trimmed = stdout.trim();
                if (!trimmed) return null;

                const raw = JSON.parse(trimmed) as { ProcessId?: number; CommandLine?: string } | Array<{ ProcessId?: number; CommandLine?: string }>;
                const processes = Array.isArray(raw) ? raw : [raw];

                for (const proc of processes) {
                    const pid = Number(proc.ProcessId);
                    const commandLine = proc.CommandLine || '';
                    const csrfToken = this.extractCsrfToken(commandLine);
                    if (pid && csrfToken) {
                        return { pid, csrf_token: csrfToken };
                    }
                }
                return null;
            }

            const { stdout } = await execAsync('pgrep -fl language_server');
            const lines = stdout.split('\n');
            for (const line of lines) {
                if (!line.includes('--csrf_token')) continue;

                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[0], 10);
                const cmd = line.substring(parts[0].length).trim();
                const csrfToken = this.extractCsrfToken(cmd);
                if (pid && csrfToken) {
                    return { pid, csrf_token: csrfToken };
                }
            }
        } catch (e) {
            logger.error('Failed to get process info:', e);
        }
        return null;
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        const ports: number[] = [];
        try {
            if (process.platform === 'win32') {
                const command = `powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -OwningProcess ${pid} | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress"`;
                const { stdout } = await execAsync(command);
                const trimmed = stdout.trim();
                if (!trimmed) return [];

                const raw = JSON.parse(trimmed) as number | number[];
                const values = Array.isArray(raw) ? raw : [raw];
                for (const value of values) {
                    const port = Number(value);
                    if (port && !ports.includes(port)) {
                        ports.push(port);
                    }
                }
                return ports;
            }

            const { stdout } = await execAsync(`lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`);
            const regex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
            let match;
            while ((match = regex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        } catch (e) {
            logger.error(`Failed to get ports for pid ${pid}:`, e);
        }
        return ports;
    }

    private requestApi(port: number, csrfToken: string): Promise<UserStatusData> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' }
            });
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 2000,
            };

            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    try {
                        const parsed = JSON.parse(body);
                        const cascadeData = parsed?.userStatus?.cascadeModelConfigData;
                        const rawConfigs: any[] = cascadeData?.clientModelConfigs || [];
                        const configs: ModelQuota[] = rawConfigs.map((c: any) => {
                            const label = c.label || c.displayName || c.modelName || c.model || '';
                            const model = c.model || c.modelId || '';
                            const qi = c.quotaInfo || c.quota || c.usageInfo;
                            const quotaInfo = qi ? {
                                remainingFraction: qi.remainingFraction ?? qi.remaining ?? 1,
                                resetTime: qi.resetTime || qi.resetAt || '',
                            } : undefined;
                            return { label, model, quotaInfo };
                        });
                        resolve({ clientModelConfigs: configs });
                    } catch {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    public async fetchQuota(): Promise<ModelQuota[]> {
        const processInfo = await this.getLanguageServerProcessInfo();
        if (!processInfo) {
            logger.error('No language_server process found.');
            return [];
        }

        const { pid, csrf_token } = processInfo;

        // If PID or Token changed, invalidate cache
        if (this.cachedPid !== pid || this.cachedCsrfToken !== csrf_token) {
            this.cachedPort = null;
            this.cachedPid = pid;
            this.cachedCsrfToken = csrf_token;
        }

        let targetPort = this.cachedPort;

        if (!targetPort) {
            const ports = await this.getListeningPorts(pid);
            for (const port of ports) {
                try {
                    const data = await this.requestApi(port, csrf_token);
                    targetPort = port;
                    this.cachedPort = port;
                    return data.clientModelConfigs || [];
                } catch {
                    continue; // try next port
                }
            }
        } else {
            try {
                const data = await this.requestApi(targetPort, csrf_token);
                return data.clientModelConfigs || [];
            } catch {
                // cache might be invalid
                this.cachedPort = null;
                return this.fetchQuota();
            }
        }
        return [];
    }
}
