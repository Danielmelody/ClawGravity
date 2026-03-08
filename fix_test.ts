import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('tests/services/cdpService.injection.test.ts', 'utf8');

c = c.replace(
    /await expect\(service\.injectMessage\('test'\)\)\.rejects\.toThrow\(\);/g,
    `const r = await service.injectMessage('test');
        expect(r.ok).toBe(false);
        expect(r.error).toBeDefined();`
);

// also fix the expectation issues where injection fails if gRPC fails (since we moved injection mostly to gRPC).
// WAIT! In test: "successfully injects a message in the cascade-panel context"
// That implies `injectMessage` still uses CDP. But let's check what `injectMessage` actually does:
//   const grpcResult = await this.injectViaGrpc(text, overrideCascadeId);
//   if (grpcResult?.ok) return grpcResult;
//   return { ok: false, error: grpcResult?.error || 'gRPC injection failed' };
//
// The DOM based injection was completely replaced by gRPC! 
console.log('Got it. All the DOM-based injectMessage tests will fail now because injectMessage purely uses gRPC.');

