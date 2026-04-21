import { tool } from "@langchain/core/tools";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

// 1.读取文件工具
const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      console.log(
        `  [工具调用] read_file("${filePath}") - 成功读取 ${content.length} 字节`,
      );
      return `文件内容:\n${content}`;
    } catch (error) {
      console.error(
        `  [工具调用] read_file("${filePath}") - 失败: ${error.message}`,
      );
      return `读取文件失败: ${error.message}`;
    }
  },
  {
    name: "read_file",
    description:
      "用此工具来读取文件内容。当用户要求读取文件、查看代码、分析文件内容时，调用此工具。输入文件路径（可以是相对路径或绝对路径）。",
    schema: z.object({
      filePath: z.string().describe("要读取的文件路径"),
    }),
  },
);

// 写入文件工具
const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf-8");
      console.log(
        `  [工具调用] write_file("${filePath}") - 成功写入 ${content.length} 字节`,
      );
      return `文件写入成功`;
    } catch (error) {
      console.error(
        `  [工具调用] write_file("${filePath}") - 失败: ${error.message}`,
      );
      return `文件写入失败: ${error.message}`;
    }
  },
  {
    name: "write_file",
    description:
      "用此工具来写入文件内容。当用户要求写入文件、创建文件、修改文件内容时，调用此工具。输入文件路径（可以是相对路径或绝对路径）和文件内容。",
    schema: z.object({
      filePath: z.string().describe("要写入的文件路径"),
      content: z.string().describe("要写入的文件内容"),
    }),
  },
);

// 执行命令工具
const execCommandTool = tool(
  async ({ command, workingDirectory }) => {
    const cwd = workingDirectory || process.cwd();
    console.log(
      `  [工具调用] exec_command("${command}")${workingDirectory ? ` - 工作目录: ${workingDirectory}` : ""}`,
    );

    return new Promise((resolve, reject) => {
      // 解析命令和参数
      const [cmd, ...args] = command.split(" ");
      const child = spawn(cmd, args, {
        cwd,
        stdio: "inherit",
        shell: true,
      });

      let errorMsg = "";
      child.on("error", (error) => {
        errorMsg = error.message;
      });

      child.on("close", (code) => {
        if (code === 0) {
          console.log(`  [工具调用] execute_command("${command}") - 执行成功`);
          const cwdInfo = workingDirectory
            ? `\n\n重要提示：命令在目录  ${workingDirectory} 中执行，如果需要在这个项目目录中继续执行命令，请使用 workingDirectory: "${workingDirectory}" 参数, 不要使用cd 命令。`
            : "";
          resolve(`命令执行成功: ${command}${cwdInfo}`);
        } else {
          console.log(
            `  [工具调用] execute_command("${command}") - 执行失败，退出码: ${code}`,
          );
          resolve(
            `命令执行失败，退出码: ${code}${errorMsg ? "\n错误: " + errorMsg : ""}`,
          );
        }
      });
    });
  },
  {
    name: "execute_command",
    description: "执行系统命令，支持指定工作目录，实时显示输出",
    schema: z.object({
      command: z.string().describe("要执行的命令"),
      workingDirectory: z.string().describe("工作目录（推荐指定）").optional(),
    }),
  },
);

// 列出目录的内容工具
const listDirectoryTool = tool(
  async ({ directoryPath }) => {
    try {
      const files = await fs.readdir(directoryPath);
      console.log(
        `  [工具调用] list_directory("${directoryPath}") - 成功列出 ${files.length} 个文件`,
      );
      return `目录内容:\n${files.map((f) => `- ${f}`).join("\n")}`;
    } catch (error) {
      console.log(
        `  [工具调用] list_directory("${directoryPath}") - 错误: ${error.message}`,
      );
      return `列出目录失败: ${error.message}`;
    }
  },
  {
    name: "list_directory",
    description: "列出目录的内容，支持指定目录",
    schema: z.object({
      directoryPath: z.string().describe("要列出的目录路径"),
    }),
  },
);

export { readFileTool, writeFileTool, execCommandTool, listDirectoryTool };
