import { MetaLayer } from './layers/meta.mjs';
import { EnterpriseLayer } from './layers/enterprise.mjs';
import { ProjectLayer } from './layers/project.mjs';
import { recall as engineRecall, remember as engineRemember } from './engine.mjs';

const layers = [
    new MetaLayer(),
    new EnterpriseLayer(),
    new ProjectLayer()
];

export async function layeredRecall(query, opts = {}) {
    // Attempt graceful degradation: meta -> enterprise -> project -> lower layers (engine recall)
    const results = [];

    for (const layer of layers) {
        try {
            if (await layer.isAvailable()) {
                const result = await layer.recall(query, opts);
                results.push(result);
            } else {
                console.warn(`[mnemosyne] Layer ${layer.name} unavailable, degrading gracefully...`);
            }
        } catch (e) {
            if (e.code === 'LAYER_UNAVAILABLE') {
                console.warn(`[mnemosyne] Layer ${layer.name} unavailable, degrading gracefully...`);
            } else {
                console.error(`[mnemosyne] Error in layer ${layer.name}:`, e);
            }
        }
    }

    // Lower layer fallback (engine recall without specific layer scope, let it use default/escalate)
    try {
        const engineResult = await engineRecall(query, null, opts);
        results.push(engineResult);
    } catch (e) {
        console.error(`[mnemosyne] Error in lower layers:`, e);
    }

    // Merge results
    if (results.length === 0) {
        return { total_hits: 0, scopes: [] };
    }

    let total_hits = 0;
    const allScopes = [];

    for (const res of results) {
        if (res && res.scopes) {
            total_hits += res.total_hits || 0;
            allScopes.push(...res.scopes);
        }
    }

    // De-duplicate scopes by name? Or just return as merged
    const mergedScopes = [];
    const scopeMap = new Map();

    for (const s of allScopes) {
        if (!scopeMap.has(s.scope)) {
            scopeMap.set(s.scope, { ...s, hits: [...(s.hits || [])] });
            mergedScopes.push(scopeMap.get(s.scope));
        } else {
            const existing = scopeMap.get(s.scope);
            existing.hits.push(...(s.hits || []));
            // De-duplicate hits by some id if available?
            // Assuming the engine handles returning unique chunks, but across layers might differ.
        }
    }

    return { query, total_hits, scopes: mergedScopes };
}

export async function layeredRemember(text, scope, opts = {}) {
    // Route to appropriate layer based on scope
    const layer = layers.find(l => l.scope === scope);

    if (layer) {
        // If a layer handles this scope, use engine's remember which maps the scope correctly
        return engineRemember(text, scope, opts);
    }

    // Fallback to normal engine remember
    return engineRemember(text, scope, opts);
}
