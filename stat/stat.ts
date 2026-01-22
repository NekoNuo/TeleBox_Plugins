import { Plugin } from "@utils/pluginBase";
import { getGlobalClient } from "@utils/globalClient";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";
import * as path from "path";
import * as fs from "fs";

// 获取命令前缀
const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

// 帮助文本
const help_text = `📊 <b>Telegram 账号统计插件</b>

<b>📝 功能描述:</b>
• 统计账号加入的群组、频道、机器人、私聊
• 按类型和状态分类统计
• 支持导出为 TXT 或 JSON 文件

<b>🔧 使用方法:</b>
• <code>${mainPrefix}stat</code> - 显示统计概览
• <code>${mainPrefix}stat list</code> - 显示详细分类列表
• <code>${mainPrefix}stat export txt</code> - 导出为 TXT 文件
• <code>${mainPrefix}stat export json</code> - 导出为 JSON 文件

<b>📊 统计维度:</b>
• 公开群组 / 私有群组
• 公开频道 / 私有频道
• 机器人对话 / 用户私聊
• 静音 / 归档 / 未读状态`;

// 对话信息接口
interface DialogInfo {
  id: string;
  title: string;
  username: string | null;
  unreadCount: number;
  isMuted: boolean;
  isArchived: boolean;
  link: string; // 跳转链接
  type: "user" | "bot" | "group" | "channel";
}

// 分类统计结果接口
interface StatResult {
  publicGroups: DialogInfo[];
  privateGroups: DialogInfo[];
  publicChannels: DialogInfo[];
  privateChannels: DialogInfo[];
  bots: DialogInfo[];
  users: DialogInfo[];
  // 状态统计
  mutedCount: number;
  archivedCount: number;
  unreadDialogs: number;
}

class StatPlugin extends Plugin {
  description: string = `Telegram 账号统计插件\n\n${help_text}`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    stat: async (msg: Api.Message) => {
      const client = await getGlobalClient();
      if (!client) {
        await msg.edit({ text: "❌ 客户端未初始化", parseMode: "html" });
        return;
      }

      // 解析参数
      const text = msg.text?.trim() || "";
      const parts = text.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase() || "";
      const subArg = parts[2]?.toLowerCase() || "";

      try {
        // 帮助命令
        if (subCmd === "help" || subCmd === "h") {
          await msg.edit({ text: help_text, parseMode: "html" });
          return;
        }

        // 显示处理中
        await msg.edit({
          text: "🔄 <b>正在获取对话列表...</b>",
          parseMode: "html"
        });

        // 获取统计数据
        const stat = await this.getDialogStats(client);

        // 根据子命令处理
        if (subCmd === "list") {
          await this.showDetailList(msg, stat);
        } else if (subCmd === "export") {
          await this.exportData(msg, stat, subArg);
        } else {
          await this.showOverview(msg, stat);
        }

      } catch (error: any) {
        console.error("[stat] 插件执行失败:", error);
        await msg.edit({
          text: `❌ <b>统计失败:</b> ${error.message || "未知错误"}`,
          parseMode: "html"
        });
      }
    }
  };

  // 获取对话统计数据
  private async getDialogStats(client: any): Promise<StatResult> {
    const result: StatResult = {
      publicGroups: [],
      privateGroups: [],
      publicChannels: [],
      privateChannels: [],
      bots: [],
      users: [],
      mutedCount: 0,
      archivedCount: 0,
      unreadDialogs: 0
    };

    // 获取所有对话（使用重试机制处理偶发的数据不完整问题）
    let dialogs: any[] = [];
    let retries = 3;
    while (retries > 0) {
      try {
        dialogs = await client.getDialogs({ limit: undefined });
        break;
      } catch (e: any) {
        retries--;
        if (retries === 0) throw e;
        // 短暂延迟后重试
        await new Promise(r => setTimeout(r, 500));
      }
    }

    for (const dialog of dialogs) {
      const entity = dialog.entity;
      if (!entity) continue;

      const entityId = entity.id?.toString() || "unknown";

      // 提取对话信息
      const info: DialogInfo = {
        id: entityId,
        title: this.getDialogTitle(entity),
        username: entity.username || null,
        unreadCount: dialog.unreadCount || 0,
        isMuted: this.isMuted(dialog),
        isArchived: dialog.archived || false,
        link: "",
        type: "user"
      };

      // 按类型分类并生成链接
      if (entity.className === "Channel") {
        if (entity.broadcast) {
          // 频道
          info.type = "channel";
          info.link = this.getChannelLink(entity);
          if (entity.username) {
            result.publicChannels.push(info);
          } else {
            result.privateChannels.push(info);
          }
        } else {
          // 超级群组
          info.type = "group";
          info.link = this.getChannelLink(entity);
          if (entity.username) {
            result.publicGroups.push(info);
          } else {
            result.privateGroups.push(info);
          }
        }
      } else if (entity.className === "Chat") {
        // 普通群组（都是私有的）
        info.type = "group";
        info.link = `tg://openmessage?chat_id=${entityId}`;
        result.privateGroups.push(info);
      } else if (entity.className === "User") {
        if (entity.bot) {
          info.type = "bot";
          info.link = this.getUserLink(entity);
          result.bots.push(info);
        } else {
          info.type = "user";
          info.link = this.getUserLink(entity);
          result.users.push(info);
        }
      }

      // 统计状态
      if (info.isMuted) result.mutedCount++;
      if (info.isArchived) result.archivedCount++;
      if (info.unreadCount > 0) result.unreadDialogs++;
    }

    return result;
  }

  // 获取对话标题
  private getDialogTitle(entity: any): string {
    if (entity.title) return entity.title;
    if (entity.firstName) {
      return entity.lastName
        ? `${entity.firstName} ${entity.lastName}`
        : entity.firstName;
    }
    if (entity.username) return `@${entity.username}`;
    return `ID: ${entity.id}`;
  }

  // 生成用户链接
  private getUserLink(entity: any): string {
    if (entity.username) {
      return `https://t.me/${entity.username}`;
    }
    return `tg://user?id=${entity.id}`;
  }

  // 生成频道/群组链接
  private getChannelLink(entity: any): string {
    if (entity.username) {
      return `https://t.me/${entity.username}`;
    }
    // 私有频道/群组使用 c/ 格式
    return `https://t.me/c/${entity.id}/1`;
  }

  // 判断是否静音
  private isMuted(dialog: any): boolean {
    try {
      const settings = dialog.notifySettings;
      if (!settings) return false;
      // muteUntil > 0 表示静音
      return settings.muteUntil > 0 || settings.silent === true;
    } catch {
      return false;
    }
  }

  // 显示统计概览
  private async showOverview(msg: Api.Message, stat: StatResult): Promise<void> {
    const totalGroups = stat.publicGroups.length + stat.privateGroups.length;
    const totalChannels = stat.publicChannels.length + stat.privateChannels.length;
    const total = totalGroups + totalChannels + stat.bots.length + stat.users.length;

    const text = `📊 <b>Telegram 账号统计</b>

<b>👥 群组:</b> ${totalGroups} 个
  ├ 公开群组: ${stat.publicGroups.length} 个
  └ 私有群组: ${stat.privateGroups.length} 个

<b>📢 频道:</b> ${totalChannels} 个
  ├ 公开频道: ${stat.publicChannels.length} 个
  └ 私有频道: ${stat.privateChannels.length} 个

<b>🤖 机器人:</b> ${stat.bots.length} 个
<b>👤 私聊:</b> ${stat.users.length} 个

<b>📌 状态统计:</b>
  ├ 已静音: ${stat.mutedCount} 个
  ├ 已归档: ${stat.archivedCount} 个
  └ 未读对话: ${stat.unreadDialogs} 个

<b>📈 总计:</b> ${total} 个对话

💡 使用 <code>${mainPrefix}stat list</code> 查看详细列表
💡 使用 <code>${mainPrefix}stat export txt/json</code> 导出数据`;

    await msg.edit({ text, parseMode: "html" });
  }

  // 显示详细列表
  private async showDetailList(msg: Api.Message, stat: StatResult): Promise<void> {
    let text = `📊 <b>Telegram 对话详细列表</b>\n`;

    // 公开群组
    if (stat.publicGroups.length > 0) {
      text += `\n<b>👥 公开群组 (${stat.publicGroups.length})</b>\n`;
      text += this.formatDialogList(stat.publicGroups.slice(0, 10));
      if (stat.publicGroups.length > 10) {
        text += `  <i>... 还有 ${stat.publicGroups.length - 10} 个</i>\n`;
      }
    }

    // 私有群组
    if (stat.privateGroups.length > 0) {
      text += `\n<b>🔒 私有群组 (${stat.privateGroups.length})</b>\n`;
      text += this.formatDialogList(stat.privateGroups.slice(0, 10));
      if (stat.privateGroups.length > 10) {
        text += `  <i>... 还有 ${stat.privateGroups.length - 10} 个</i>\n`;
      }
    }

    // 公开频道
    if (stat.publicChannels.length > 0) {
      text += `\n<b>📢 公开频道 (${stat.publicChannels.length})</b>\n`;
      text += this.formatDialogList(stat.publicChannels.slice(0, 10));
      if (stat.publicChannels.length > 10) {
        text += `  <i>... 还有 ${stat.publicChannels.length - 10} 个</i>\n`;
      }
    }

    // 私有频道
    if (stat.privateChannels.length > 0) {
      text += `\n<b>🔐 私有频道 (${stat.privateChannels.length})</b>\n`;
      text += this.formatDialogList(stat.privateChannels.slice(0, 10));
      if (stat.privateChannels.length > 10) {
        text += `  <i>... 还有 ${stat.privateChannels.length - 10} 个</i>\n`;
      }
    }

    // 机器人
    if (stat.bots.length > 0) {
      text += `\n<b>🤖 机器人 (${stat.bots.length})</b>\n`;
      text += this.formatDialogList(stat.bots.slice(0, 10));
      if (stat.bots.length > 10) {
        text += `  <i>... 还有 ${stat.bots.length - 10} 个</i>\n`;
      }
    }

    // 用户私聊
    if (stat.users.length > 0) {
      text += `\n<b>👤 用户私聊 (${stat.users.length})</b>\n`;
      text += this.formatDialogList(stat.users.slice(0, 10));
      if (stat.users.length > 10) {
        text += `  <i>... 还有 ${stat.users.length - 10} 个</i>\n`;
      }
    }

    text += `\n💡 使用 <code>${mainPrefix}stat export txt</code> 导出完整列表`;

    // 检查消息长度
    if (text.length > 4096) {
      text = text.substring(0, 4000) + `\n\n<i>... 内容过长，请使用导出功能查看完整列表</i>`;
    }

    await msg.edit({ text, parseMode: "html" });
  }

  // 格式化对话列表
  private formatDialogList(dialogs: DialogInfo[]): string {
    let text = "";
    for (const d of dialogs) {
      const status = [];
      if (d.isMuted) status.push("🔇");
      if (d.isArchived) status.push("📁");
      if (d.unreadCount > 0) status.push(`💬${d.unreadCount}`);

      const statusStr = status.length > 0 ? ` ${status.join(" ")}` : "";
      const usernameStr = d.username ? ` (@${d.username})` : "";

      text += `  • ${this.escapeHtml(d.title)}${usernameStr}${statusStr}\n`;
    }
    return text;
  }

  // 导出数据
  private async exportData(msg: Api.Message, stat: StatResult, format: string): Promise<void> {
    const client = await getGlobalClient();
    if (!client) return;

    if (format !== "txt" && format !== "json") {
      await msg.edit({
        text: `❌ <b>不支持的格式:</b> ${format}\n\n💡 支持的格式: <code>txt</code>, <code>json</code>`,
        parseMode: "html"
      });
      return;
    }

    await msg.edit({
      text: "📤 <b>正在生成导出文件...</b>",
      parseMode: "html"
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    const tempDir = path.join(process.cwd(), "temp");

    // 确保临时目录存在
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let filePath: string;
    let content: string;

    if (format === "json") {
      filePath = path.join(tempDir, `telegram_stat_${timestamp}.json`);
      content = this.generateJson(stat);
    } else {
      filePath = path.join(tempDir, `telegram_stat_${timestamp}.txt`);
      content = this.generateTxt(stat);
    }

    // 写入文件
    fs.writeFileSync(filePath, content, "utf-8");

    // 发送文件
    try {
      await client.sendFile(msg.chatId, {
        file: filePath,
        caption: `📊 <b>Telegram 账号统计导出</b>\n\n📅 导出时间: ${timestamp}\n📄 格式: ${format.toUpperCase()}`,
        parseMode: "html"
      });

      await msg.edit({
        text: `✅ <b>导出成功</b>\n\n📄 文件已发送`,
        parseMode: "html"
      });
    } finally {
      // 清理临时文件
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  // 生成 JSON 内容
  private generateJson(stat: StatResult): string {
    const data = {
      exportTime: new Date().toISOString(),
      summary: {
        totalGroups: stat.publicGroups.length + stat.privateGroups.length,
        totalChannels: stat.publicChannels.length + stat.privateChannels.length,
        totalBots: stat.bots.length,
        totalUsers: stat.users.length,
        mutedCount: stat.mutedCount,
        archivedCount: stat.archivedCount,
        unreadDialogs: stat.unreadDialogs
      },
      dialogs: {
        publicGroups: stat.publicGroups,
        privateGroups: stat.privateGroups,
        publicChannels: stat.publicChannels,
        privateChannels: stat.privateChannels,
        bots: stat.bots,
        users: stat.users
      }
    };
    return JSON.stringify(data, null, 2);
  }

  // 生成 TXT 内容
  private generateTxt(stat: StatResult): string {
    const totalGroups = stat.publicGroups.length + stat.privateGroups.length;
    const totalChannels = stat.publicChannels.length + stat.privateChannels.length;
    const total = totalGroups + totalChannels + stat.bots.length + stat.users.length;

    let text = `Telegram 账号统计报告
导出时间: ${new Date().toLocaleString("zh-CN")}
${"=".repeat(50)}

【统计概览】
群组总数: ${totalGroups} 个
  - 公开群组: ${stat.publicGroups.length} 个
  - 私有群组: ${stat.privateGroups.length} 个

频道总数: ${totalChannels} 个
  - 公开频道: ${stat.publicChannels.length} 个
  - 私有频道: ${stat.privateChannels.length} 个

机器人: ${stat.bots.length} 个
私聊: ${stat.users.length} 个

状态统计:
  - 已静音: ${stat.mutedCount} 个
  - 已归档: ${stat.archivedCount} 个
  - 未读对话: ${stat.unreadDialogs} 个

总计: ${total} 个对话

${"=".repeat(50)}
【详细列表】
`;

    // 公开群组
    if (stat.publicGroups.length > 0) {
      text += `\n[公开群组 - ${stat.publicGroups.length} 个]\n`;
      text += this.formatTxtList(stat.publicGroups);
    }

    // 私有群组
    if (stat.privateGroups.length > 0) {
      text += `\n[私有群组 - ${stat.privateGroups.length} 个]\n`;
      text += this.formatTxtList(stat.privateGroups);
    }

    // 公开频道
    if (stat.publicChannels.length > 0) {
      text += `\n[公开频道 - ${stat.publicChannels.length} 个]\n`;
      text += this.formatTxtList(stat.publicChannels);
    }

    // 私有频道
    if (stat.privateChannels.length > 0) {
      text += `\n[私有频道 - ${stat.privateChannels.length} 个]\n`;
      text += this.formatTxtList(stat.privateChannels);
    }

    // 机器人
    if (stat.bots.length > 0) {
      text += `\n[机器人 - ${stat.bots.length} 个]\n`;
      text += this.formatTxtList(stat.bots);
    }

    // 用户私聊
    if (stat.users.length > 0) {
      text += `\n[用户私聊 - ${stat.users.length} 个]\n`;
      text += this.formatTxtList(stat.users);
    }

    return text;
  }

  // 格式化 TXT 列表
  private formatTxtList(dialogs: DialogInfo[]): string {
    let text = "";
    for (const d of dialogs) {
      const status = [];
      if (d.isMuted) status.push("静音");
      if (d.isArchived) status.push("归档");
      if (d.unreadCount > 0) status.push(`${d.unreadCount}条未读`);

      const statusStr = status.length > 0 ? ` [${status.join(", ")}]` : "";
      const usernameStr = d.username ? ` (@${d.username})` : "";

      text += `  - ${d.title}${usernameStr}\n`;
      text += `    ID: ${d.id}${statusStr}\n`;
      text += `    链接: ${d.link}\n`;
    }
    return text;
  }

  // HTML 转义
  private escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;',
      '"': '&quot;', "'": '&#x27;'
    }[m] || m));
  }
}

export default new StatPlugin();
