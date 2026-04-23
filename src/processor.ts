// processor.ts
import { EventChain, Event, Skill, ConversationContext } from "./types";
import { storage } from "./storage";

export const processor = {
  /**
   * 处理任务结束事件，构建事件链
   * @param context 对话上下文
   * @param task 任务对象
   * @returns 事件链
   */
  async processTaskEnd(context: ConversationContext, task: any): Promise<EventChain> {
    try {
      // 构建事件链
      const eventChain: EventChain = {
        id: `chain_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        taskId: task.id,
        timestamp: Date.now(),
        userIntent: context.userIntent,
        events: this.buildEvents(context),
        outcome: 'partial', // 初始状态，等待反馈
        embedding: this.generateDummyEmbedding(), // 实际项目中应使用真实的embedding模型
      };
      
      return eventChain;
    } catch (error) {
      console.error("Error processing task end:", error);
      throw error;
    }
  },

  /**
   * 构建事件序列
   * @param context 对话上下文
   * @returns 事件数组
   */
  buildEvents(context: ConversationContext): Event[] {
    const events: Event[] = [];
    
    // 添加用户查询事件
    context.messages.forEach(msg => {
      if (msg.role === 'user') {
        events.push({
          type: 'user_query',
          content: msg.content,
          metadata: {
            timestamp: msg.timestamp
          }
        });
      }
    });
    
    // 添加工具调用事件
    context.toolCalls.forEach(call => {
      events.push({
        type: 'tool_call',
        content: call.name,
        metadata: {
          toolName: call.name,
          parameters: call.parameters,
          result: call.result,
          timestamp: call.timestamp
        }
      });
    });
    
    return events;
  },

  /**
   * 生成虚拟的embedding向量（实际项目中应使用真实的embedding模型）
   * @returns 向量数组
   */
  generateDummyEmbedding(): number[] {
    // 生成1536维的随机向量
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      embedding.push(Math.random() * 2 - 1); // 范围在[-1, 1]之间
    }
    return embedding;
  },

  /**
   * 检查是否需要生成或升级技能
   * @param taskId 任务ID
   */
  async checkSkillGeneration(taskId: string): Promise<void> {
    try {
      // 获取事件链
      const eventChain = await storage.getEventChainByTaskId(taskId);
      if (!eventChain || eventChain.outcome !== 'success') {
        return; // 只处理成功的任务
      }
      
      // 查找相似的事件链
      const similarChains = await storage.searchSimilarEventChains(eventChain.userIntent, 10);
      const successChains = similarChains.filter(chain => chain.outcome === 'success');
      
      // 如果有足够多的成功案例，生成技能
      if (successChains.length >= 3) {
        await this.generateSkill(successChains);
      }
    } catch (error) {
      console.error("Error checking skill generation:", error);
    }
  },

  /**
   * 生成技能
   * @param chains 事件链数组
   */
  async generateSkill(chains: EventChain[]): Promise<void> {
    try {
      // 提取共同模式
      const pattern = this.extractCommonPattern(chains);
      
      // 生成技能
      const skill: Skill = {
        id: `skill_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: this.generateSkillName(pattern.intent),
        description: pattern.description,
        level: 'short', // 初始为Short Memory
        template: {
          intent: pattern.intent,
          preconditions: pattern.preconditions,
          steps: pattern.steps,
          postconditions: pattern.postconditions
        },
        stats: {
          totalUses: 0,
          successCount: 0,
          failureCount: 0,
          successRate: 0,
          avgExecutionTime: 0,
          lastUsed: Date.now()
        },
        sourceChains: chains.map(chain => chain.id)
      };
      
      // 存储技能
      await storage.storeSkill(skill);
      console.log(`Skill generated: ${skill.name}`);
    } catch (error) {
      console.error("Error generating skill:", error);
    }
  },

  /**
   * 提取共同模式
   * @param chains 事件链数组
   * @returns 模式对象
   */
  extractCommonPattern(chains: EventChain[]): any {
    // 提取共同的用户意图
    const intents = chains.map(chain => chain.userIntent);
    const commonIntent = this.findMostCommon(intents);
    
    // 提取共同的工具调用
    const toolSequences = chains.map(chain => 
      chain.events
        .filter(event => event.type === 'tool_call')
        .map(event => event.metadata.toolName)
        .filter(Boolean)
    );
    
    // 找出最常见的工具序列
    const commonTools = this.findCommonToolSequence(toolSequences);
    
    // 构建步骤
    const steps = commonTools.map(tool => ({
      action: tool,
      parameters: [], // 实际项目中应提取参数模板
      errorHandling: "重试或使用备用方案"
    }));
    
    return {
      intent: commonIntent,
      description: `处理${commonIntent}的技能`,
      preconditions: ["用户提供必要的输入参数"],
      steps,
      postconditions: ["任务成功完成"]
    };
  },

  /**
   * 找出最常见的元素
   * @param items 元素数组
   * @returns 最常见的元素
   */
  findMostCommon(items: string[]): string {
    const counts = items.reduce((acc, item) => {
      acc[item] = (acc[item] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    let mostCommon = items[0];
    let maxCount = 0;
    
    for (const [item, count] of Object.entries(counts)) {
      if (count > maxCount) {
        mostCommon = item;
        maxCount = count;
      }
    }
    
    return mostCommon;
  },

  /**
   * 找出共同的工具序列
   * @param sequences 工具序列数组
   * @returns 共同的工具序列
   */
  findCommonToolSequence(sequences: string[][]): string[] {
    if (sequences.length === 0) return [];
    
    // 找出最短的序列
    const shortest = sequences.reduce((a, b) => a.length <= b.length ? a : b);
    
    // 检查每个工具是否在所有序列中出现
    const commonTools: string[] = [];
    for (const tool of shortest) {
      if (sequences.every(seq => seq.includes(tool))) {
        commonTools.push(tool);
      }
    }
    
    return commonTools;
  },

  /**
   * 生成技能名称
   * @param intent 用户意图
   * @returns 技能名称
   */
  generateSkillName(intent: string): string {
    return `处理${intent.substring(0, 20)}${intent.length > 20 ? '...' : ''}`;
  },

  /**
   * 检索相关技能
   * @param query 查询字符串
   * @param topK 返回数量
   * @returns 技能数组
   */
  async retrieveSkills(query: string, topK: number = 5): Promise<Skill[]> {
    try {
      // 获取所有技能
      const allSkills = await storage.getAllSkills();
      
      // 计算相似度并排序
      const scoredSkills = allSkills.map(skill => ({
        skill,
        score: storage.calculateSimilarity(query, skill.template.intent)
      }));
      
      scoredSkills.sort((a, b) => b.score - a.score);
      return scoredSkills.slice(0, topK).map(item => item.skill);
    } catch (error) {
      console.error("Error retrieving skills:", error);
      return [];
    }
  },

  /**
   * 计算事件链相似度
   * @param chain1 事件链1
   * @param chain2 事件链2
   * @returns 相似度分数
   */
  calculateChainSimilarity(chain1: EventChain, chain2: EventChain): number {
    // 计算意图相似度
    const intentSim = storage.calculateSimilarity(chain1.userIntent, chain2.userIntent);
    
    // 计算工具序列相似度
    const tools1 = chain1.events
      .filter(event => event.type === 'tool_call')
      .map(event => event.metadata.toolName)
      .filter(Boolean);
    
    const tools2 = chain2.events
      .filter(event => event.type === 'tool_call')
      .map(event => event.metadata.toolName)
      .filter(Boolean);
    
    const toolSim = this.calculateToolSequenceSimilarity(tools1, tools2);
    
    // 加权计算总相似度
    return 0.6 * intentSim + 0.4 * toolSim;
  },

  /**
   * 计算工具序列相似度
   * @param tools1 工具序列1
   * @param tools2 工具序列2
   * @returns 相似度分数
   */
  calculateToolSequenceSimilarity(tools1: string[], tools2: string[]): number {
    if (tools1.length === 0 && tools2.length === 0) return 1.0;
    if (tools1.length === 0 || tools2.length === 0) return 0.0;
    
    // 计算Jaccard相似度
    const set1 = new Set(tools1);
    const set2 = new Set(tools2);
    const intersection = new Set([...set1].filter(tool => set2.has(tool)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  },

  /**
   * 检查技能是否需要升级
   * @param skill 技能
   */
  async checkSkillUpgrade(skill: Skill): Promise<void> {
    try {
      // 检查是否从Short升级到Long
      if (skill.level === 'short' && skill.stats.successCount >= 3 && skill.stats.successRate > 0.8) {
        skill.level = 'long';
        await storage.updateSkill(skill);
        console.log(`Skill upgraded to Long Memory: ${skill.name}`);
      }
      
      // 检查是否从Long升级到Fixed
      if (skill.level === 'long' && skill.stats.totalUses >= 10 && skill.stats.successRate > 0.9) {
        // 这里应该通知用户进行人工确认
        console.log(`Skill ready for Fixed Memory: ${skill.name}`);
        // 实际项目中应添加人工审核流程
      }
    } catch (error) {
      console.error("Error checking skill upgrade:", error);
    }
  }
};
