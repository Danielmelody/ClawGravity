import { GrpcCascadeClient } from './src/services/grpcCascadeClient';

async function main() {
    const client = new GrpcCascadeClient();
    await client.connect();
    const res = await client.rawRPC('GetCascadeTrajectory', { cascadeId: '6478f6b9-3786-42b1-8e93-b61f64340f00' });
    const steps = typeof res === 'object' && res ? (res as any).trajectory?.steps || (res as any).steps : [];
    console.log("Status:", (res as any).status || (res as any).trajectory?.status);
    console.log("Steps length:", steps.length);
    if (steps.length > 0) {
        console.log("Last 4 steps:", JSON.stringify(steps.slice(-4), null, 2));
    }
    process.exit(0);
}

main().catch(console.error);
