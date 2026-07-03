import { SemanticRetriever } from '../retrievers/index.js';

export class SkillRetriever extends SemanticRetriever {
    constructor(skillsArray = [], options = {}) {
        super(skillsArray, options);
    }

    get skills() {
        return this.items;
    }

    set skills(val) {
        this.items = val;
    }

    getItemText(skill) {
        return `${skill.name}: ${skill.description || ""} ${skill.instructions || ""}`;
    }

    async getRelevantSkills(userPrompt, topK = 1) {
        return await this.retrieve(userPrompt, topK, true);
    }
}
