import { Event, EventChain, Skill, UserFeedback, ConversationContext } from './types';
import { storage } from './storage';
import { adapter } from './adapter';
import { logger } from './logger';

export class Processor {
  private config: any;

  constructor(config: any) {
    this.config = config;
  }

  async processTask(task: any): Promise<void> {
    try {
      await logger.info('processor', `Processing task: ${task.id}`);
      
      // 1. 提取对话上下文
      const context = await adapter.extractConversation(task);
      await logger.debug('processor', 'Conversation context extracted', { taskId: task.id, userIntent: context.userIntent });
      
      // 2. 构建事件链
      const eventChain = this.buildEventChain(task, context);
      await logger.logEventChain(eventChain);
      
      // 3. 存储事件链
      await storage.storeEventChain(eventChain);
      await logger.info('processor', `Event chain stored for task: ${task.id}`);
      
    } catch (error: any) {
      await logger.error('processor', 'Error processing task', { taskId: task.id, error: error.message });
    }
  }

  async processFeedback(taskId: string, feedback: any): Promise<void> {
    try {
      await logger.info('processor', `Processing feedback for task: ${taskId}`);

      // 1. 提取用户反馈
      const userFeedback: UserFeedback = {
        score: feedback.score || 0,
        comment: feedback.comment,
        timestamp: Date.now()
      };
      await logger.logFeedback(taskId, userFeedback);

      // 2. 更新事件链的反馈信息
      await storage.updateEventChainFeedback(taskId, userFeedback);
      await logger.info('processor', `Event chain feedback updated for task: ${taskId}`);

      // 3. 检查是否需要生成或更新技能
      await this.checkSkillGeneration(taskId);

    } catch (error: any) {
      await logger.error('processor', 'Error processing feedback', { taskId, error: error.message });
    }
  }

  private buildEventChain(task: any, context: ConversationContext): EventChain {
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
        content: `调用工具: ${call.name}`,
        metadata: {
          toolName: call.name,
          parameters: call.parameters,
          result: call.result,
          timestamp: call.timestamp
        }
      });
    });
    
    // 提取工具序列
    const toolSequence = context.toolCalls.map(call => call.name);
    
    return {
      id: `chain-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      taskId: task.id,
      timestamp: Date.now(),
      userIntent: context.userIntent,
      events,
      toolSequence,
      outcome: 'partial', // 初始状态，等待反馈
      feedback: undefined,
      embedding: this.generateMockEmbedding(context.userIntent)
    };
  }

  private generateMockEmbedding(text: string): number[] {
    // 生成模拟的向量嵌入
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      embedding.push(Math.random() * 2 - 1);
    }
    return embedding;
  }

  private async checkSkillGeneration(taskId: string): Promise<void> {
    try {
      await logger.info('processor', `Checking skill generation for task: ${taskId}`);
      
      // 获取事件链
      const eventChain = await storage.getEventChainByTaskId(taskId);
      if (!eventChain || eventChain.outcome !== 'success') {
        await logger.debug('processor', 'Skipping skill generation (not a successful task)', { taskId, outcome: eventChain?.outcome });
        return; // 只处理成功的任务
      }
      
      // 查找相似的事件链
      const similarChains = await storage.searchSimilarEventChains(eventChain.userIntent, 10);
      const successChains = similarChains.filter(chain => chain.outcome === 'success');
      
      await logger.debug('processor', 'Found similar event chains', {
        taskId,
        userIntent: eventChain.userIntent,
        similarChainCount: similarChains.length,
        successChainCount: successChains.length
      });
      
      // 如果有足够多的成功案例，生成技能
      if (successChains.length >= 3) {
        await logger.info('processor', 'Generating skill from successful event chains', {
          taskId,
          successChainCount: successChains.length
        });
        await this.generateSkill(successChains);
      } else {
        await logger.debug('processor', 'Not enough successful chains to generate skill', {
          taskId,
          successChainCount: successChains.length
        });
      }
    } catch (error: any) {
      await logger.error('processor', 'Error checking skill generation', { taskId, error: error.message });
    }
  }

  private async generateSkill(chains: EventChain[]): Promise<void> {
    try {
      await logger.info('processor', 'Generating skill from event chains', {
        sourceChainCount: chains.length,
        sampleIntent: chains[0]?.userIntent
      });

      const pattern = this.extractCommonPattern(chains);

      const skill: Skill = {
        id: `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: this.generateSkillName(pattern.intent),
        description: pattern.description,
        level: 'short',
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
          lastUsed: Date.now()
        },
        sourceChains: chains.map(chain => chain.id)
      };

      await storage.storeSkill(skill);
      await logger.logSkillGeneration(skill);
    } catch (error: any) {
      await logger.error('processor', 'Error generating skill', { error: error.message });
    }
  }

  private extractCommonPattern(chains: EventChain[]): any {
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
      errorHandling: '重试或使用备用方案'
    }));
    
    return {
      intent: commonIntent,
      description: `处理${commonIntent}的技能`,
      preconditions: ['用户提供必要的输入参数'],
      steps,
      postconditions: ['任务成功完成']
    };
  }

  private findMostCommon(items: string[]): string {
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
  }

  private findCommonToolSequence(sequences: string[][]): string[] {
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
  }

  private generateSkillName(intent: string): string {
    return `处理${intent.substring(0, 20)}${intent.length > 20 ? '...' : ''}`;
  }

  async getRelevantSkills(userQuery: string, topK: number = 5): Promise<Skill[]> {
    try {
      await logger.info('processor', 'Retrieving relevant skills', { query: userQuery, topK });
      
      // 获取所有技能
      const allSkills = await storage.getAllSkills();
      await logger.debug('processor', 'Retrieved all skills', { totalSkillCount: allSkills.length });
      
      // 计算相似度并排序
      const scoredSkills = allSkills.map(skill => ({
        skill,
        score: storage.calculateSimilarity(userQuery, skill.template.intent)
      }));
      
      scoredSkills.sort((a, b) => b.score - a.score);
      const relevantSkills = scoredSkills.slice(0, topK).map(item => item.skill);
      
      await logger.logSkillRetrieval(userQuery, relevantSkills, 'retrieval');
      return relevantSkills;
    } catch (error: any) {
      await logger.error('processor', 'Error getting relevant skills', { query: userQuery, error: error.message });
      return [];
    }
  }

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
    } catch (error: any) {
      console.error('Error checking skill upgrade:', error);
    }
  }
}

