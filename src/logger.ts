// logger.ts
import fs from 'fs';
import path from 'path';

// 日志目录
const LOG_DIR = path.join(process.cwd(), '.openclaw', 'logs');

// 确保日志目录存在
function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// 生成日志文件名（按日期）
function getLogFileName() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `log-${year}-${month}-${day}.jsonl`;
}

// 日志级别
export enum LogLevel {
  INFO = 'info',
  DEBUG = 'debug',
  WARN = 'warn',
  ERROR = 'error'
}

// 日志接口
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
}

export const logger = {
  /**
   * 记录日志
   * @param level 日志级别
   * @param category 日志类别
   * @param message 日志消息
   * @param data 附加数据
   */
  async log(level: LogLevel, category: string, message: string, data?: any): Promise<void> {
    try {
      ensureLogDirectory();
      
      const logEntry: LogEntry = {
        timestamp: Date.now(),
        level,
        category,
        message,
        data
      };
      
      const logFilePath = path.join(LOG_DIR, getLogFileName());
      const logLine = JSON.stringify(logEntry) + '\n';
      
      // 追加写入日志文件
      fs.appendFileSync(logFilePath, logLine);
      
      // 同时输出到控制台
      const consoleMessage = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${category}] ${message}`;
      switch (level) {
        case LogLevel.ERROR:
          console.error(consoleMessage, data);
          break;
        case LogLevel.WARN:
          console.warn(consoleMessage, data);
          break;
        case LogLevel.DEBUG:
          console.debug(consoleMessage, data);
          break;
        default:
          console.log(consoleMessage, data);
      }
    } catch (error) {
      console.error('Error writing log:', error);
    }
  },

  /**
   * 记录信息日志
   * @param category 日志类别
   * @param message 日志消息
   * @param data 附加数据
   */
  async info(category: string, message: string, data?: any): Promise<void> {
    await this.log(LogLevel.INFO, category, message, data);
  },

  /**
   * 记录调试日志
   * @param category 日志类别
   * @param message 日志消息
   * @param data 附加数据
   */
  async debug(category: string, message: string, data?: any): Promise<void> {
    await this.log(LogLevel.DEBUG, category, message, data);
  },

  /**
   * 记录警告日志
   * @param category 日志类别
   * @param message 日志消息
   * @param data 附加数据
   */
  async warn(category: string, message: string, data?: any): Promise<void> {
    await this.log(LogLevel.WARN, category, message, data);
  },

  /**
   * 记录错误日志
   * @param category 日志类别
   * @param message 日志消息
   * @param data 附加数据
   */
  async error(category: string, message: string, data?: any): Promise<void> {
    await this.log(LogLevel.ERROR, category, message, data);
  },

  /**
   * 记录用户查询
   * @param query 用户查询
   * @param taskId 任务ID
   */
  async logUserQuery(query: string, taskId: string): Promise<void> {
    await this.info('user_query', 'User query received', {
      taskId,
      query
    });
  },

  /**
   * 记录技能检索结果
   * @param query 查询字符串
   * @param skills 检索到的技能
   * @param taskId 任务ID
   */
  async logSkillRetrieval(query: string, skills: any[], taskId: string): Promise<void> {
    await this.info('skill_retrieval', 'Skills retrieved', {
      taskId,
      query,
      skillCount: skills.length,
      skills: skills.map(skill => ({
        id: skill.id,
        name: skill.name,
        description: skill.description
      }))
    });
  },

  /**
   * 记录事件链构建
   * @param eventChain 事件链
   */
  async logEventChain(eventChain: any): Promise<void> {
    await this.info('event_chain', 'Event chain built', {
      taskId: eventChain.taskId,
      chainId: eventChain.id,
      userIntent: eventChain.userIntent,
      eventCount: eventChain.events.length,
      toolSequence: eventChain.toolSequence,
      outcome: eventChain.outcome
    });
  },

  /**
   * 记录技能生成
   * @param skill 生成的技能
   */
  async logSkillGeneration(skill: any): Promise<void> {
    await this.info('skill_generation', 'Skill generated', {
      skillId: skill.id,
      skillName: skill.name,
      skillLevel: skill.level,
      sourceChainCount: skill.sourceChains.length
    });
  },

  /**
   * 记录反馈处理
   * @param taskId 任务ID
   * @param feedback 反馈信息
   */
  async logFeedback(taskId: string, feedback: any): Promise<void> {
    await this.info('feedback', 'Feedback processed', {
      taskId,
      score: feedback.score,
      comment: feedback.comment
    });
  }
};
