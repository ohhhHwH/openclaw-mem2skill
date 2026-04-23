// pro-features.ts
import { EventChain, IntentCategory, Skill } from "./types";

export const proFeatures = {
  /**
   * Prompt标准化
   * @param userQuery 用户查询
   * @returns 标准化后的Prompt
   */
  async normalizePrompt(userQuery: string): Promise<{ intent: IntentCategory; standardPrompt: string }> {
    try {
      // 简单的意图分类（实际项目中应使用更复杂的分类方法）
      const intent = this.classifyIntent(userQuery);
      
      // 生成标准Prompt
      const standardPrompt = this.generateStandardPrompt(intent, userQuery);
      
      return {
        intent,
        standardPrompt
      };
    } catch (error) {
      console.error("Error normalizing prompt:", error);
      return {
        intent: IntentCategory.DATA_QUERY,
        standardPrompt: userQuery
      };
    }
  },

  /**
   * 分类用户意图
   * @param userQuery 用户查询
   * @returns 意图分类
   */
  classifyIntent(userQuery: string): IntentCategory {
    const lowerQuery = userQuery.toLowerCase();
    
    if (lowerQuery.includes('查询') || lowerQuery.includes('数据') || lowerQuery.includes('统计')) {
      return IntentCategory.DATA_QUERY;
    } else if (lowerQuery.includes('文件') || lowerQuery.includes('读取') || lowerQuery.includes('写入')) {
      return IntentCategory.FILE_OPERATION;
    } else if (lowerQuery.includes('代码') || lowerQuery.includes('生成') || lowerQuery.includes('编写')) {
      return IntentCategory.CODE_GENERATION;
    } else if (lowerQuery.includes('调试') || lowerQuery.includes('错误') || lowerQuery.includes('修复')) {
      return IntentCategory.DEBUGGING;
    } else if (lowerQuery.includes('部署') || lowerQuery.includes('上线') || lowerQuery.includes('发布')) {
      return IntentCategory.DEPLOYMENT;
    } else if (lowerQuery.includes('分析') || lowerQuery.includes('研究') || lowerQuery.includes('评估')) {
      return IntentCategory.ANALYSIS;
    } else {
      return IntentCategory.DATA_QUERY; // 默认分类
    }
  },

  /**
   * 生成标准Prompt
   * @param intent 意图分类
   * @param userQuery 用户查询
   * @returns 标准Prompt
   */
  generateStandardPrompt(intent: IntentCategory, userQuery: string): string {
    const intentMap: Record<IntentCategory, string> = {
      [IntentCategory.DATA_QUERY]: "数据查询：",
      [IntentCategory.FILE_OPERATION]: "文件操作：",
      [IntentCategory.CODE_GENERATION]: "代码生成：",
      [IntentCategory.DEBUGGING]: "调试问题：",
      [IntentCategory.DEPLOYMENT]: "部署相关：",
      [IntentCategory.ANALYSIS]: "数据分析："
    };
    
    return `${intentMap[intent]}${userQuery}`;
  },

  /**
   * 事件链可视化（生成Mermaid流程图）
   * @param chain 事件链
   * @returns Mermaid流程图字符串
   */
  visualizeEventChain(chain: EventChain): string {
    let mermaid = "graph TD\n";
    let nodeId = 0;
    const nodes: Record<string, string> = {};
    
    // 添加用户意图节点
    const intentNode = `node${nodeId++}`;
    mermaid += `    ${intentNode}[用户意图: ${chain.userIntent}]\n`;
    
    // 处理事件
    let previousNode = intentNode;
    chain.events.forEach((event, index) => {
      const currentNode = `node${nodeId++}`;
      
      if (event.type === 'user_query') {
        mermaid += `    ${currentNode}[用户查询: ${event.content.substring(0, 30)}${event.content.length > 30 ? '...' : ''}]\n`;
      } else if (event.type === 'tool_call') {
        mermaid += `    ${currentNode}[工具: ${event.metadata.toolName}]\n`;
      } else if (event.type === 'ai_response') {
        mermaid += `    ${currentNode}[AI响应]\n`;
      } else if (event.type === 'error') {
        mermaid += `    ${currentNode}[错误: ${event.content.substring(0, 30)}${event.content.length > 30 ? '...' : ''}]\n`;
      }
      
      mermaid += `    ${previousNode} --> ${currentNode}\n`;
      previousNode = currentNode;
    });
    
    // 添加结果节点
    const resultNode = `node${nodeId++}`;
    const outcomeColor = chain.outcome === 'success' ? 'green' : chain.outcome === 'failure' ? 'red' : 'orange';
    mermaid += `    ${resultNode}[结果: ${chain.outcome}]\n`;
    mermaid += `    ${previousNode} --> ${resultNode}\n`;
    
    return mermaid;
  },

  /**
   * 记忆压缩
   * @param chains 事件链数组
   * @param threshold 相似度阈值
   * @returns 压缩后的事件链数组
   */
  compressMemory(chains: EventChain[], threshold: number = 0.9): EventChain[] {
    try {
      const compressed: EventChain[] = [];
      const processed = new Set<string>();
      
      for (let i = 0; i < chains.length; i++) {
        if (processed.has(chains[i].id)) continue;
        
        const similarChains = [chains[i]];
        processed.add(chains[i].id);
        
        // 查找相似的事件链
        for (let j = i + 1; j < chains.length; j++) {
          if (processed.has(chains[j].id)) continue;
          
          const similarity = this.calculateChainSimilarity(chains[i], chains[j]);
          if (similarity > threshold) {
            similarChains.push(chains[j]);
            processed.add(chains[j].id);
          }
        }
        
        // 合并相似的事件链
        if (similarChains.length > 1) {
          const mergedChain = this.mergeSimilarChains(similarChains);
          compressed.push(mergedChain);
        } else {
          compressed.push(chains[i]);
        }
      }
      
      return compressed;
    } catch (error) {
      console.error("Error compressing memory:", error);
      return chains;
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
    const intentSim = this.calculateStringSimilarity(chain1.userIntent, chain2.userIntent);
    
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
   * 计算字符串相似度
   * @param str1 字符串1
   * @param str2 字符串2
   * @returns 相似度分数
   */
  calculateStringSimilarity(str1: string, str2: string): number {
    const set1 = new Set(str1.toLowerCase().split(/\s+/));
    const set2 = new Set(str2.toLowerCase().split(/\s+/));
    const intersection = new Set([...set1].filter(word => set2.has(word)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
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
    
    const set1 = new Set(tools1);
    const set2 = new Set(tools2);
    const intersection = new Set([...set1].filter(tool => set2.has(tool)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  },

  /**
   * 合并相似的事件链
   * @param chains 事件链数组
   * @returns 合并后的事件链
   */
  mergeSimilarChains(chains: EventChain[]): EventChain {
    // 使用最新的事件链作为基础
    const latestChain = chains.sort((a, b) => b.timestamp - a.timestamp)[0];
    
    return {
      ...latestChain,
      id: `chain_merged_${Date.now()}`,
      sourceChains: chains.map(chain => chain.id), // 记录来源事件链
      mergedAt: Date.now()
    };
  },

  /**
   * 生成技能使用报告
   * @param skills 技能数组
   * @returns 技能使用报告
   */
  generateSkillReport(skills: Skill[]): string {
    let report = "# 技能使用报告\n\n";
    
    // 按使用次数排序
    const sortedSkills = skills.sort((a, b) => b.stats.totalUses - a.stats.totalUses);
    
    sortedSkills.forEach(skill => {
      report += `## ${skill.name}\n`;
      report += `- 描述: ${skill.description}\n`;
      report += `- 级别: ${skill.level}\n`;
      report += `- 使用次数: ${skill.stats.totalUses}\n`;
      report += `- 成功率: ${(skill.stats.successRate * 100).toFixed(2)}%\n`;
      report += `- 最后使用: ${new Date(skill.stats.lastUsed).toLocaleString()}\n\n`;
    });
    
    return report;
  }
};
