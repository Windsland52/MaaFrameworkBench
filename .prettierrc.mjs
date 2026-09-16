// 对齐生态既有风格（M9A / MaaEnd / create-maa-project 的 TS 约定）
export default {
  printWidth: 120,
  tabWidth: 2,
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  bracketSpacing: true,
  bracketSameLine: true,
  endOfLine: 'auto',
  // 文档里的 YAML / JSON / TS 示例是**刻意对齐**的（注释列对齐，便于阅读）。
  // 格式化它们会把对齐压掉，反而变难读 —— 所以关掉嵌入代码块的格式化。
  embeddedLanguageFormatting: 'off',
}
