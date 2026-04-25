// storage.ts
import fs from 'fs';
import path from 'path';
import { EventChain, Skill, UserFeedback } from "./types";

// 存储目录结构
const STORAGE_DIR = path.join(process.cwd(), '.openclaw', 'memory');
const CHAINS_DIR = path.join(STORAGE_DIR, 'chains');
const SKILLS_DIR = path.join(STORAGE_DIR, 'skills');
const VECTORS_DIR = path.join(STORAGE_DIR, 'vectors');

// 确保存储目录存在
function ensureDirectories() {
  const directories = [STORAGE_DIR, CHAINS_DIR, SKILLS_DIR, VECTORS_DIR];
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  
  // 确保技能子目录存在
  const skillLevels = ['short', 'long', 'fixed'];
  skillLevels.forEach(level => {
    const levelDir = path.join(SKILLS_DIR, level);
    if (!fs.existsSync(levelDir)) {
      fs.mkdirSync(levelDir, { recursive: true });
    }
  });
}

// 初始化存储
ensureDirectories();

export const storage = {
  /**
   * 存储事件链
   * @param eventChain 事件链
   */
  async storeEventChain(eventChain: EventChain): Promise<void> {
    try {
      ensureDirectories();
      
      // 存储事件链到JSON Lines文件
      const chainPath = path.join(CHAINS_DIR, `${eventChain.id}.json`);
      fs.writeFileSync(chainPath, JSON.stringify(eventChain, null, 2));
      
      // 存储向量
      const vectorPath = path.join(VECTORS_DIR, `${eventChain.id}.json`);
      fs.writeFileSync(vectorPath, JSON.stringify({
        id: eventChain.id,
        embedding: eventChain.embedding,
        userIntent: eventChain.userIntent
      }, null, 2));
      
      console.log(`Event chain stored: ${eventChain.id}`);
    } catch (error) {
      console.error("Error storing event chain:", error);
      throw error;
    }
  },

  /**
   * 更新事件链的反馈信息
   * @param taskId 任务ID
   * @param feedback 用户反馈
   */
  async updateEventChainFeedback(taskId: string, feedback: UserFeedback): Promise<void> {
    try {
      // 查找对应的事件链
      const chainFiles = fs.readdirSync(CHAINS_DIR);
      for (const file of chainFiles) {
        if (file.endsWith('.json')) {
          const chainPath = path.join(CHAINS_DIR, file);
          const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
          
          if (chainData.taskId === taskId) {
            // 更新反馈信息
            chainData.feedback = feedback;
            chainData.outcome = feedback.score >= 7 ? 'success' : feedback.score >= 1 ? 'partial' : 'failure';
            
            // 写回文件
            fs.writeFileSync(chainPath, JSON.stringify(chainData, null, 2));
            console.log(`Event chain feedback updated: ${taskId}`);
            return;
          }
        }
      }
      
      console.warn(`Event chain not found for taskId: ${taskId}`);
    } catch (error) {
      console.error("Error updating event chain feedback:", error);
      throw error;
    }
  },

  /**
   * 存储技能
   * @param skill 技能
   */
  async storeSkill(skill: Skill): Promise<void> {
    try {
      ensureDirectories();
      
      const skillPath = path.join(SKILLS_DIR, skill.level, `${skill.id}.json`);
      fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2));
      console.log(`Skill stored: ${skill.id} (${skill.level})`);
    } catch (error) {
      console.error("Error storing skill:", error);
      throw error;
    }
  },

  /**
   * 获取所有事件链
   * @returns 事件链数组
   */
  async getAllEventChains(): Promise<EventChain[]> {
    try {
      ensureDirectories();
      
      const chainFiles = fs.readdirSync(CHAINS_DIR);
      const chains: EventChain[] = [];
      
      for (const file of chainFiles) {
        if (file.endsWith('.json')) {
          const chainPath = path.join(CHAINS_DIR, file);
          const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
          chains.push(chainData);
        }
      }
      
      return chains;
    } catch (error) {
      console.error("Error getting all event chains:", error);
      return [];
    }
  },

  /**
   * 根据任务ID获取事件链
   * @param taskId 任务ID
   * @returns 事件链
   */
  async getEventChainByTaskId(taskId: string): Promise<EventChain | null> {
    try {
      ensureDirectories();
      
      const chainFiles = fs.readdirSync(CHAINS_DIR);
      for (const file of chainFiles) {
        if (file.endsWith('.json')) {
          const chainPath = path.join(CHAINS_DIR, file);
          const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
          
          if (chainData.taskId === taskId) {
            return chainData;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error("Error getting event chain by taskId:", error);
      return null;
    }
  },

  /**
   * 获取所有技能
   * @param level 技能级别（可选）
   * @returns 技能数组
   */
  async getAllSkills(level?: 'short' | 'long' | 'fixed'): Promise<Skill[]> {
    try {
      ensureDirectories();
      
      const skills: Skill[] = [];
      const levels = level ? [level] : ['short', 'long', 'fixed'];
      
      for (const lvl of levels) {
        const levelDir = path.join(SKILLS_DIR, lvl);
        if (fs.existsSync(levelDir)) {
          const skillFiles = fs.readdirSync(levelDir);
          for (const file of skillFiles) {
            if (file.endsWith('.json')) {
              const skillPath = path.join(levelDir, file);
              const skillData = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
              skills.push(skillData);
            }
          }
        }
      }
      
      return skills;
    } catch (error) {
      console.error("Error getting all skills:", error);
      return [];
    }
  },

  /**
   * 更新技能
   * @param skill 技能
   */
  async updateSkill(skill: Skill): Promise<void> {
    try {
      const levels = ['short', 'long', 'fixed'];
      for (const lvl of levels) {
        const oldPath = path.join(SKILLS_DIR, lvl, `${skill.id}.json`);
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath);
        }
      }

      await this.storeSkill(skill);
    } catch (error: any) {
      console.error("Error updating skill:", error);
      throw error;
    }
  },

  /**
   * 搜索相似的事件链（简单实现）
   * @param query 查询字符串
   * @param topK 返回数量
   * @returns 相似事件链数组
   */
  async searchSimilarEventChains(query: string, topK: number = 5): Promise<EventChain[]> {
    try {
      const allChains = await this.getAllEventChains();
      
      // 简单的相似度计算（基于字符串包含）
      const scoredChains = allChains.map(chain => ({
        chain,
        score: this.calculateSimilarity(query, chain.userIntent)
      }));
      
      // 排序并返回topK
      scoredChains.sort((a, b) => b.score - a.score);
      return scoredChains.slice(0, topK).map(item => item.chain);
    } catch (error) {
      console.error("Error searching similar event chains:", error);
      return [];
    }
  },

  /**
   * 计算字符串相似度（简单实现）
   * @param query 查询字符串
   * @param text 目标文本
   * @returns 相似度分数
   */
  calculateSimilarity(query: string, text: string): number {
    // 简单的字符串包含检查
    if (text.toLowerCase().includes(query.toLowerCase())) {
      return 1.0;
    }
    
    // 计算Jaccard相似度
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const textWords = new Set(text.toLowerCase().split(/\s+/));
    const intersection = new Set([...queryWords].filter(word => textWords.has(word)));
    const union = new Set([...queryWords, ...textWords]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }
};
