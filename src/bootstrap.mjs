import fs from 'node:fs/promises';
import { MetaLayer } from './layers/meta.mjs';
import { EnterpriseLayer } from './layers/enterprise.mjs';
import { ProjectLayer } from './layers/project.mjs';

export async function bootstrapLayers() {
    const meta = new MetaLayer();
    const enterprise = new EnterpriseLayer();
    const project = new ProjectLayer();

    try {
        await fs.mkdir(meta.directory, { recursive: true });
        console.log(`[mnemosyne] Bootstrapped meta layer at ${meta.directory}`);
    } catch (err) {
        console.error(`[mnemosyne] Failed to bootstrap meta layer:`, err);
    }

    try {
        await fs.mkdir(enterprise.directory, { recursive: true });
        console.log(`[mnemosyne] Bootstrapped enterprise layer at ${enterprise.directory}`);
    } catch (err) {
        console.error(`[mnemosyne] Failed to bootstrap enterprise layer:`, err);
    }

    try {
        await fs.mkdir(project.directory, { recursive: true });
        console.log(`[mnemosyne] Bootstrapped project layer at ${project.directory}`);
    } catch (err) {
        console.error(`[mnemosyne] Failed to bootstrap project layer:`, err);
    }

    return {
        meta: meta.directory,
        enterprise: enterprise.directory,
        project: project.directory
    };
}
