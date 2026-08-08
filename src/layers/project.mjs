import fs from 'node:fs/promises';
import path from 'node:path';
import { run, scopeMap, recall } from '../engine.mjs';

export class ProjectLayer {
    constructor() {
        this.name = 'project';
        this.scope = 'project';
        this.directory = path.join(process.cwd(), '.pHive', 'memory', 'project');
    }

    async isAvailable() {
        try {
            const stats = await fs.stat(this.directory);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    async index() {
        if (!(await this.isAvailable())) {
            console.warn(`[mnemosyne] Project layer directory not found at ${this.directory}`);
            return null;
        }
        
        const m = await scopeMap();
        const collection = m.scopes[this.scope] || m.fallback_collection || 'claude_knowledge';
        
        const args = ["index", collection, "--no-prune", this.directory];
        try {
            const { stdout, stderr } = await run(args, { timeout: 300_000 });
            return (stdout + stderr).trim();
        } catch (e) {
            console.error(`[mnemosyne] Failed to index project layer:`, e);
            throw e;
        }
    }

    async recall(query, opts = {}) {
        if (!(await this.isAvailable())) {
            const err = new Error('Project layer is unavailable');
            err.code = 'LAYER_UNAVAILABLE';
            throw err;
        }
        await this.index();
        return recall(query, this.scope, opts);
    }

    async remember(text, opts = {}) {
        await fs.mkdir(this.directory, { recursive: true });
        
        const m = await scopeMap();
        const collection = m.scopes[this.scope] || m.fallback_collection || 'claude_knowledge';
        
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const tag = (opts.tag || "note").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
        const file = path.join(this.directory, `${stamp}-${tag}.md`);
        const header = `<!-- remembered via Mnemosyne @ ${new Date().toISOString()} scope=${this.scope} layer=${this.name} -->\n`;
        await fs.writeFile(file, header + String(text) + "\n", "utf8");

        const args = ["index", collection, "--no-prune", file];
        let out;
        try {
            const { stdout, stderr } = await run(args);
            out = (stdout + stderr).trim();
        } catch (e) {
            const detail = `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message;
            const err = new Error(`write-through failed: Qdrant upsert errored, file kept at ${file}: ${detail}`);
            err.status = 500;
            err.file = file;
            throw err;
        }

        const upserted = /upserted\s+(\d+)\s+chunks/i.exec(out);
        const chunksUpserted = upserted ? Number(upserted[1]) : 0;
        
        return {
            remembered: true,
            scope: this.scope,
            layer: this.name,
            collection,
            file,
            chunks_upserted: chunksUpserted,
            engine_output: out,
        };
    }
}
