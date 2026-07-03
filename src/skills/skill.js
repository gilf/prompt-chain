import { Tool } from '../core/prompt-chain-worker.js';

export class Skill {
    constructor(name, description, instructions, tools = []) {
        this.name = name;
        this.description = description;
        this.instructions = instructions;
        this.tools = tools;
    }
}

export function parseFrontmatter(markdown) {
    const regex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
    const match = markdown.match(regex);
    if (!match) {
        return { attributes: {}, body: markdown };
    }

    const yamlStr = match[1];
    const body = match[2];
    const attributes = {};
    const lines = yamlStr.split('\n');

    for (const line of lines) {
        const parts = line.split(':');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            attributes[key] = parts.slice(1).join(':').trim().replace(/^['"]|['"]$/g, '');
        }
    }

    return { attributes, body };
}

export async function loadSkillFromUrl(baseUrl) {
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');

    const skillMdUrl = `${cleanBaseUrl}/SKILL.md`;
    const res = await fetch(skillMdUrl);
    if (!res.ok) {
        throw new Error(`Failed to load skill manifest from ${skillMdUrl}`);
    }
    const markdown = await res.text();
    const { attributes, body } = parseFrontmatter(markdown);

    const name = attributes.name || "UnnamedSkill";
    const description = attributes.description || "";
    const instructions = body.trim();

    let tools = [];
    try {
        const toolsUrl = `${cleanBaseUrl}/tools.js`;
        const module = await import(toolsUrl);
        const rawTools = module.tools || module.default || [];
        if (Array.isArray(rawTools)) {
            tools = rawTools.map(t => new Tool(t.name, t.description, t.executeFn));
        }
    } catch (err) {
        console.warn(`Could not load tools for skill ${name}:`, err);
    }

    return new Skill(name, description, instructions, tools);
}
