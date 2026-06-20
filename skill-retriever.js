export class SkillRetriever {
    constructor(skillsArray = []) {
        this.skills = skillsArray;
    }

    async getRelevantSkills(userPrompt, topK = 1) {
        if (this.skills.length <= topK) return this.skills;

        const query = userPrompt.toLowerCase();

        const scoredSkills = this.skills.map(skill => {
            let score = 0;
            const targetText = `${skill.name} ${skill.description}`.toLowerCase();
            const queryTokens = query.split(/\W+/);
            for (const token of queryTokens) {
                if (token.length > 3 && targetText.includes(token)) {
                    score += 1;
                }
            }
            return { skill, score };
        });

        return scoredSkills
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(item => item.skill);
    }
}
