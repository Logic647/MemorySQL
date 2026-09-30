/**
 * merge-mac-manifest.mjs 的类型声明 —— 让 TS 测试能拿到类型。
 */
export interface ManifestFile {
  url: string
  sha512: string
  size: string
}

export interface Manifest {
  version: string
  files: ManifestFile[]
  /** updater 在无法按架构判断时使用的包;校验下载完整性 */
  path: string
  sha512: string
  releaseDate: string | null
  _label?: string
}

export function parseManifest(text: string, label?: string): Manifest

/** 版本不一致直接抛错 —— 两份清单描述的是两个不同的发布 */
export function mergeManifests(manifests: Manifest[]): Manifest

export function formatManifest(m: Manifest): string

/**
 * 用 electron-updater 自己的 filterFilesForArch 校验两个架构都能解析到 zip。
 * 校验不过抛错 —— 拒绝输出会让用户装错架构的清单。
 */
export function assertBothArchesResolve(merged: Manifest): { arm: string; x64: string }
