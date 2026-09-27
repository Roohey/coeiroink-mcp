import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TTS_ENGINE_NAMES, type TtsEngineName } from "./tts-engine.js";

export interface VoiceConfig {
  engine: TtsEngineName;
  coeiroinkUrl: string;
  voicevoxUrl: string;
  // 話者の識別子。COEIROINKはspeakerUuid+styleIdの組で話者+スタイルを表す。
  // VOICEVOXはstyleIdを「speaker」番号(話者+スタイルを一体で表す)として使い、speakerUuidは
  // list_speakers表示用のキャラクターUUID以上の意味を持たない(合成には使わない)。
  speakerUuid: string;
  styleId: number;
  speedScale: number;
  volumeScale: number;
  pitchScale: number;
  intonationScale: number;
  prePhonemeLength: number;
  postPhonemeLength: number;
  outputSamplingRate: number;
}

/** set_default_speaker で変更できる項目(URL・音素長・サンプリングレートは対象外) */
export type SpeakerSettings = Pick<
  VoiceConfig,
  "engine" | "speakerUuid" | "styleId" | "speedScale" | "volumeScale" | "pitchScale" | "intonationScale"
>;

const SPEAKER_SETTING_KEYS = [
  "engine",
  "speakerUuid",
  "styleId",
  "speedScale",
  "volumeScale",
  "pitchScale",
  "intonationScale",
] as const satisfies readonly (keyof SpeakerSettings)[];

export const defaultConfig: VoiceConfig = {
  engine: "coeiroink",
  coeiroinkUrl: "http://127.0.0.1:50032",
  voicevoxUrl: "http://127.0.0.1:50021",
  speakerUuid: "b28bb401-bc43-c9c7-77e4-77a2bbb4b283",
  styleId: 131,
  speedScale: 1.2,
  volumeScale: 0.4,
  pitchScale: 0.0,
  intonationScale: 1.0,
  prePhonemeLength: 0.1,
  postPhonemeLength: 0.1,
  outputSamplingRate: 44100,
};

/** 現在の engine 設定に対応するベースURLを返す。 */
export function resolveEngineUrl(cfg: VoiceConfig, engine: TtsEngineName = cfg.engine): string {
  return engine === "voicevox" ? cfg.voicevoxUrl : cfg.coeiroinkUrl;
}

// dist/config.js -> ../config.json でプラグインルートを指す(呼び出し元のcwdに依存しない)
// リポジトリ同梱の共有既定値。プラグイン更新で上書きされる想定なので実行時に書き込みはしない。
// テストからは COEIROINK_MCP_REPO_CONFIG_PATH で一時ファイルに差し替えられる(実ファイルを汚さないため)。
const REPO_CONFIG_PATH =
  process.env.COEIROINK_MCP_REPO_CONFIG_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");

// ユーザーごとの永続設定。set_default_speaker(persist: true)の書き込み先。
// テストからは COEIROINK_MCP_CONFIG_DIR で一時ディレクトリに差し替えられる(実の~/.coeiroink-mcpを汚さないため)。
const USER_CONFIG_DIR = process.env.COEIROINK_MCP_CONFIG_DIR ?? path.join(os.homedir(), ".coeiroink-mcp");
const USER_CONFIG_PATH = path.join(USER_CONFIG_DIR, "config.json");

export type SettingSource = "session" | "activeProfile" | "userFile" | "repoFile" | "default";

/** 名前付きプリセット。話者+パラメータ一式のスナップショットで、部分指定も許可する。 */
export type Profile = Partial<SpeakerSettings>;

/** プレーンオブジェクト(配列・null・プリミティブでない、"{...}"形式)かどうかを判定する。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const URL_CONFIG_KEYS = new Set<keyof VoiceConfig>(["coeiroinkUrl", "voicevoxUrl"]);

/** http(s)スキームの有効なURLかどうかを判定する(TCPポートを想定した接続先URLのため)。 */
function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * ファイルを読んでJSONとしてパースする。ファイルが存在しない(ENOENT)場合のみundefinedを返す。
 * ファイルは存在するが読み取れない(EBUSY/EACCES等の一時的なOSエラー)、JSONとして解析できない、
 * またはトップレベルがオブジェクト("{...}"形式)でない(文字列・配列・数値等)場合は、
 * いずれも例外を投げる。「存在しない」と「存在するが読めない/壊れている/オブジェクトでない」を
 * 同じundefinedとして扱うと、書き込み系(saveProfile等)がread-modify-writeで一時的に読めない
 * だけのファイルを「空」として扱い、既存のプロファイル・永続設定を無警告で消してしまうため区別する。
 * トップレベルがオブジェクトでない場合(例: ファイル内容が単なる文字列"hello")、以前は
 * `key in obj`(pickConfigFields)がプリミティブに対して`in`演算子を使いTypeErrorでクラッシュしたり、
 * `{...existing, ...clean}`のspreadが文字列を配列的に展開して`{"0":"h","1":"e",...}`のような
 * 壊れた内容を書き込んだりしていたため、ここで早期に弾く。
 */
function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `設定ファイルの読み取りに失敗しました(${(e as NodeJS.ErrnoException).code ?? "unknown"}): ${filePath}\n` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `設定ファイルの解析に失敗しました(JSONとして不正です): ${filePath}\n${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `設定ファイルの内容がオブジェクトではありません(トップレベルは"{...}"形式である必要があります): ${filePath}`
    );
  }
  return parsed;
}

/**
 * 読み取り専用の呼び出し(loadConfig等、loadFileConfigSnapshot経由)向け。壊れたファイルで例外を
 * 投げず、stderrに警告した上で「ファイルなし」として扱う(既定値へのフォールバック)。
 * 書き込み系はこちらを使わず readJsonFile を直接呼び、例外をそのまま呼び出し元(MCPツール)へ
 * 伝えて書き込みを中止させる(既存データの保護を優先する)。
 */
function readJsonFileForRead(filePath: string): Record<string, unknown> | undefined {
  try {
    return readJsonFile(filePath);
  } catch (e) {
    console.error(
      `[coeiroink-mcp] ${e instanceof Error ? e.message : String(e)}\nこのファイルは無視して既定値にフォールバックします。内容を確認・修正するか削除してください。`
    );
    return undefined;
  }
}

function pickDefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

const CONFIG_FIELD_KEYS = Object.keys(defaultConfig) as (keyof VoiceConfig)[];
const ENGINE_NAME_SET: ReadonlySet<string> = new Set(TTS_ENGINE_NAMES);

/**
 * 設定ファイルの生データ(profilesキー等を含みうる)からVoiceConfigの既知フィールドだけを、
 * 型・値を検証しながら取り出す。engineはTTS_ENGINE_NAMESのenumとして、それ以外は
 * defaultConfigの型(number/string)と一致するかを見る。一致しない値は黙って通さず、
 * stderrに警告した上でそのフィールドだけ無視する(上位レイヤー/既定値にフォールバックする)。
 * typoや手編集ミスをそのまま通すと、後段で「エンジンが起動していません」のような無関係で
 * 意味不明なエラーに化けてしまうため。
 */
function pickConfigFields(obj: Record<string, unknown>, sourceLabel: string): Partial<VoiceConfig> {
  const out: Partial<VoiceConfig> = {};
  for (const key of CONFIG_FIELD_KEYS) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (key === "engine") {
      if (typeof value === "string" && ENGINE_NAME_SET.has(value)) {
        out.engine = value as TtsEngineName;
      } else {
        console.error(
          `[coeiroink-mcp] ${sourceLabel}の"engine"の値が不正です(${JSON.stringify(value)})。` +
            `${TTS_ENGINE_NAMES.map((n) => `"${n}"`).join("/")}のいずれかを指定してください。このフィールドは無視します。`
        );
      }
      continue;
    }
    const expectedType = typeof defaultConfig[key];
    const valid = expectedType === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === expectedType;
    if (!valid) {
      console.error(
        `[coeiroink-mcp] ${sourceLabel}の"${key}"の値の型が不正です(期待: ${expectedType}, 実際: ${JSON.stringify(value)})。このフィールドは無視します。`
      );
      continue;
    }
    if (URL_CONFIG_KEYS.has(key) && !isValidHttpUrl(value as string)) {
      console.error(
        `[coeiroink-mcp] ${sourceLabel}の"${key}"の値がURLとして不正です(${JSON.stringify(value)})。http://またはhttps://で始まる有効なURLを指定してください。このフィールドは無視します。`
      );
      continue;
    }
    (out as Record<string, unknown>)[key] = value;
  }
  // 後方互換: v0.6.0でurlをcoeiroinkUrl/voicevoxUrlに分割する前の設定ファイルを使っていた場合、
  // coeiroinkUrlが明示されていなければ旧urlをCOEIROINKの接続先として引き継ぐ(サイレントに
  // 既定ポートへフォールバックしてしまうと、カスタムポートを使っているユーザーが気づけないため)。
  if (out.coeiroinkUrl === undefined && typeof obj.url === "string") {
    if (isValidHttpUrl(obj.url)) {
      out.coeiroinkUrl = obj.url;
      console.error(
        `[coeiroink-mcp] ${sourceLabel}の"url"は非推奨です。"coeiroinkUrl"にリネームしてください(暫定的にurl="${obj.url}"をcoeiroinkUrlとして使用しています)。`
      );
    } else {
      console.error(
        `[coeiroink-mcp] ${sourceLabel}の"url"(非推奨。coeiroinkUrlの移行元)の値がURLとして不正です(${JSON.stringify(obj.url)})。このフィールドは無視します。`
      );
    }
  }
  return out;
}

/**
 * プロファイル1件分の生データから、SpeakerSettingsの既知キーだけを型・値を検証しながら取り出す。
 * pickConfigFieldsと同じ方針(不正な値は警告した上でそのフィールドだけ無視、未知キーは黙って無視)。
 * ここを経由しない限りprofilesは型アサーションのみで実効設定へ流入し、無効なengine名や
 * null/文字列の数値がそのままエンジン呼び出しやセッション全体(use_profile経由の全ツール呼び出し)を
 * 壊しうるため必須。
 */
function pickSpeakerSettingsFields(obj: Record<string, unknown>, sourceLabel: string): Profile {
  const out: Profile = {};
  for (const key of SPEAKER_SETTING_KEYS) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (key === "engine") {
      if (typeof value === "string" && ENGINE_NAME_SET.has(value)) {
        out.engine = value as TtsEngineName;
      } else {
        console.error(
          `[coeiroink-mcp] ${sourceLabel}の"engine"の値が不正です(${JSON.stringify(value)})。` +
            `${TTS_ENGINE_NAMES.map((n) => `"${n}"`).join("/")}のいずれかを指定してください。このフィールドは無視します。`
        );
      }
      continue;
    }
    if (key === "speakerUuid") {
      if (typeof value === "string") {
        out.speakerUuid = value;
      } else {
        console.error(
          `[coeiroink-mcp] ${sourceLabel}の"speakerUuid"の値の型が不正です(期待: string, 実際: ${JSON.stringify(value)})。このフィールドは無視します。`
        );
      }
      continue;
    }
    // styleId/speedScale/volumeScale/pitchScale/intonationScale: いずれも有限数値。styleIdのみ整数。
    const isValidNumber =
      typeof value === "number" && Number.isFinite(value) && (key !== "styleId" || Number.isInteger(value));
    if (isValidNumber) {
      (out as Record<string, unknown>)[key] = value;
    } else {
      console.error(
        `[coeiroink-mcp] ${sourceLabel}の"${key}"の値が不正です(期待: ${key === "styleId" ? "整数" : "有限数"}, 実際: ${JSON.stringify(value)})。このフィールドは無視します。`
      );
    }
  }
  return out;
}

/**
 * profilesレコード(プロファイル名→生データ)を検証しながらProfileへ正規化する。個々のプロファイルが
 * plain object(スカラー・配列・null等でない)でない場合は、そのプロファイルだけを警告の上で無視する
 * (全体は失敗させない。個別フィールドの扱いはpickConfigFieldsと同じ方針)。
 * profilesコンテナ自体がplain objectかどうかの検証は行わない(呼び出し元がrequireProfilesRecord/
 * 読み取り専用のnormalizeProfilesForReadで事前に済ませておくこと)。
 */
function normalizeProfileEntries(record: Record<string, unknown>, sourceLabel: string): Record<string, Profile> {
  // out[name] = ... のようなbracket代入は、name === "__proto__"の場合Object.prototype.__proto__の
  // setterを踏んでしまい、独自プロパティを作る代わりにoutの プロトタイプを書き換えてしまう
  // (結果、"__proto__"という名前の正当なプロファイルがJSON.stringify/Object.keysから見えなくなり
  // 無警告で消失する)。Object.fromEntriesはCreateDataProperty相当を使うため、この問題を起こさない。
  const entries: [string, Profile][] = [];
  for (const [name, value] of Object.entries(record)) {
    if (!isPlainObject(value)) {
      console.error(
        `[coeiroink-mcp] ${sourceLabel}のプロファイル"${name}"の値が不正です(オブジェクトではありません)。このプロファイルは無視します。`
      );
      continue;
    }
    entries.push([name, pickSpeakerSettingsFields(value, `${sourceLabel}のプロファイル"${name}"`)]);
  }
  return Object.fromEntries(entries);
}

/**
 * 読み取り専用経路向け: profilesの生データを検証しながら正規化する。profiles自体が
 * plain objectでない(スカラー・配列・null)場合は警告した上で「プロファイルなし」として
 * 扱う(既定値へのフォールバックと同じ方針。ファイルには触れないため書き込みは発生しない)。
 */
function normalizeProfilesForRead(raw: unknown, sourceLabel: string): Record<string, Profile> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    console.error(
      `[coeiroink-mcp] ${sourceLabel}の"profiles"の値が不正です(オブジェクトではありません)。プロファイルなしとして扱います。`
    );
    return {};
  }
  return normalizeProfileEntries(raw, sourceLabel);
}

/**
 * 書き込み経路向け: profilesの生データがplain objectであることを要求する。スカラー・配列・null等の
 * 場合は例外を投げて書き込みを中止させる(save_profile/delete_profileが壊れた構造をそのまま
 * 「素通り」させ、配列に文字列インデックスキーが生えたりlist_profiles出力が破損したりするのを防ぐ)。
 * 個々のプロファイル値の検証(normalizeProfileEntries)はこの後、呼び出し元が別途行う。
 */
function requireProfilesRecord(raw: unknown, sourceLabel: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(
      `${sourceLabel}の"profiles"の値が不正です(オブジェクトではありません)。書き込みを中止しました。ファイルの内容を確認・修正してください。`
    );
  }
  return raw;
}

interface FileConfigSnapshot {
  config: VoiceConfig;
  // 生データ(profiles等の付随データを含む)。listProfiles等、非VoiceConfigフィールドの
  // 参照に使う。
  repoRaw: Record<string, unknown>;
  userRaw: Record<string, unknown>;
  // pickConfigFieldsを通した後の既知フィールドのみ(旧urlのcoeiroinkUrlへの移行も反映済み)。
  // describeCurrentSettingsのsources判定はこちらを使う。生データ(repoRaw/userRaw)には
  // 移行後のキー名(coeiroinkUrl)が存在しないため、生データで判定すると移行された値の出所が
  // "default"等に誤判定されてしまう。
  repoFields: Partial<VoiceConfig>;
  userFields: Partial<VoiceConfig>;
  // userRaw.profilesを検証・正規化済みのもの。listProfiles/resolveEffectiveSettings/
  // describeCurrentSettingsはすべてこちらを参照し、生データを直接見ない。
  profiles: Record<string, Profile>;
}

let fileConfigCache: FileConfigSnapshot | undefined;
// セッション既定値。persist: false で set_default_speaker した内容をプロセス生存中のみ保持する。
let sessionOverride: Partial<SpeakerSettings> = {};

// repo/user の生データとマージ結果を同じスナップショットとしてキャッシュする。
// 呼び出しごとに別々にファイルを読み直すと、values(マージ結果)とsources(生データの有無判定)が
// 異なるタイミングのファイル内容を基準にしてしまい、両者が食い違う恐れがあるため。
function loadFileConfigSnapshot(): FileConfigSnapshot {
  if (fileConfigCache) return fileConfigCache;
  const repoRaw = readJsonFileForRead(REPO_CONFIG_PATH) ?? {};
  const userRaw = readJsonFileForRead(USER_CONFIG_PATH) ?? {};
  const repoFields = pickConfigFields(repoRaw, REPO_CONFIG_PATH);
  const userFields = pickConfigFields(userRaw, USER_CONFIG_PATH);
  const config = { ...defaultConfig, ...repoFields, ...userFields };
  const profiles = normalizeProfilesForRead(userRaw.profiles, USER_CONFIG_PATH);
  fileConfigCache = { config, repoRaw, userRaw, repoFields, userFields, profiles };
  return fileConfigCache;
}

function invalidateFileConfigCache(): void {
  fileConfigCache = undefined;
}

/** テスト専用: モジュール内の可変状態(ファイルキャッシュ・セッション上書き・アクティブプロファイル)をリセットする。 */
export function resetStateForTesting(): void {
  fileConfigCache = undefined;
  sessionOverride = {};
  activeProfileName = undefined;
}

/**
 * finalPathと同じディレクトリの一時ファイルへ書き込み、fsyncしてからrenameで置換する。
 * 書き込み・fsync・renameのいずれかで失敗した場合は一時ファイルを削除し、最終ファイルには
 * 一切触れない(最終パスへ直接writeFileSyncする実装だと、書き込み途中の障害(ディスクフル等)で
 * 最終ファイルがパース不能な断片に化けて既存設定を失いうる。実際にfs.writeFileSyncを14バイト時点で
 * 中断させて再現・確認済み)。
 */
function writeFileAtomic(finalPath: string, data: string): void {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(dir, `${path.basename(finalPath)}.tmp-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 既に閉じている等、後始末の失敗は無視(元ファイルの保護が優先)
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // 後始末の失敗は無視(元ファイルの保護が優先)
    }
    throw e;
  }
}

function writeUserConfigFile(content: Record<string, unknown>): void {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  writeFileAtomic(USER_CONFIG_PATH, `${JSON.stringify(content, null, 2)}\n`);
  invalidateFileConfigCache();
}

/** 解決順序: セッション既定値 > ユーザー設定ファイル(~/.coeiroink-mcp/config.json) > リポジトリ共有既定値(config.json) > ハードコード既定値 */
export function loadConfig(): VoiceConfig {
  return { ...loadFileConfigSnapshot().config, ...sessionOverride };
}

/**
 * 既定のエンジン・話者・スタイル・話速等を変更する。
 * persist=false: プロセス生存中(このMCPサーバーのセッション)だけ有効なメモリ上の既定値として保持。
 * persist=true : ~/.coeiroink-mcp/config.json に書き込み、以後の起動でも有効にする。
 */
export function setDefaultSpeaker(settings: Partial<SpeakerSettings>, persist: boolean): VoiceConfig {
  const clean = pickDefined(settings);
  if (persist) {
    const existing = readJsonFile(USER_CONFIG_PATH) ?? {};
    writeUserConfigFile({ ...existing, ...clean });
    // ファイルに永続化した項目は、古いセッション上書きが優先されないよう解除する
    for (const key of SPEAKER_SETTING_KEYS) {
      if (key in clean) delete sessionOverride[key];
    }
  } else {
    sessionOverride = { ...sessionOverride, ...clean };
  }
  return loadConfig();
}

// ---- プロファイル(名前付きプリセット) ----
// ~/.coeiroink-mcp/config.json の profiles キー配下に保存する。リポジトリ共有既定値には持たせない。

let activeProfileName: string | undefined;

export function listProfiles(): Record<string, Profile> {
  return loadFileConfigSnapshot().profiles;
}

export function saveProfile(name: string, settings: Profile): Record<string, Profile> {
  const clean = pickDefined(settings);
  const existingFile = readJsonFile(USER_CONFIG_PATH) ?? {};
  const existingProfilesRaw = requireProfilesRecord(existingFile.profiles, USER_CONFIG_PATH);
  const existingProfiles = normalizeProfileEntries(existingProfilesRaw, USER_CONFIG_PATH);
  const base = Object.hasOwn(existingProfiles, name) ? existingProfiles[name] : {};
  const mergedProfile = { ...base, ...clean };
  const updatedProfiles = { ...existingProfiles, [name]: mergedProfile };
  writeUserConfigFile({ ...existingFile, profiles: updatedProfiles });
  return updatedProfiles;
}

export function deleteProfile(name: string): boolean {
  const existingFile = readJsonFile(USER_CONFIG_PATH) ?? {};
  const existingProfilesRaw = requireProfilesRecord(existingFile.profiles, USER_CONFIG_PATH);
  const existingProfiles = normalizeProfileEntries(existingProfilesRaw, USER_CONFIG_PATH);
  if (!Object.hasOwn(existingProfiles, name)) return false;
  const updatedProfiles = { ...existingProfiles };
  delete updatedProfiles[name];
  writeUserConfigFile({ ...existingFile, profiles: updatedProfiles });
  if (activeProfileName === name) activeProfileName = undefined;
  return true;
}

/** このセッションのアクティブプロファイルを設定/解除する。name=nullで解除。 */
export function useProfile(name: string | null): { activeProfile: string | null } {
  if (name === null) {
    activeProfileName = undefined;
    return { activeProfile: null };
  }
  if (!Object.hasOwn(listProfiles(), name)) {
    throw new Error(`プロファイル「${name}」が見つかりません。list_profilesで確認してください。`);
  }
  activeProfileName = name;
  return { activeProfile: name };
}

export function getActiveProfileName(): string | undefined {
  return activeProfileName;
}

/**
 * speak/synthesize向けの最終設定値を解決する。
 * 優先順位(高い順): callOverrides(呼び出し引数) > profileName(呼び出し時指定のプロファイル)
 * > アクティブプロファイル(use_profile) > loadConfig()(セッション既定値 > ユーザー設定ファイル > リポジトリ共有既定値 > ハードコード既定値)
 */
export function resolveEffectiveSettings(callOverrides: Partial<SpeakerSettings> = {}, profileName?: string): VoiceConfig {
  const profiles = listProfiles();
  let result: VoiceConfig = loadConfig();

  if (activeProfileName && Object.hasOwn(profiles, activeProfileName)) {
    result = { ...result, ...pickDefined(profiles[activeProfileName]) };
  }
  if (profileName) {
    if (!Object.hasOwn(profiles, profileName)) {
      throw new Error(`プロファイル「${profileName}」が見つかりません。list_profilesで確認してください。`);
    }
    result = { ...result, ...pickDefined(profiles[profileName]) };
  }
  return { ...result, ...pickDefined(callOverrides) };
}

/** 現在の設定値(profile引数なし)と、各項目がどの層から来ているかを返す(get_current_settings向け)。 */
export function describeCurrentSettings(): {
  values: VoiceConfig;
  sources: Record<keyof VoiceConfig, SettingSource>;
  userConfigPath: string;
  activeProfile: string | null;
} {
  const { repoFields, userFields } = loadFileConfigSnapshot();
  const profiles = listProfiles();
  const activeProfile =
    activeProfileName && Object.hasOwn(profiles, activeProfileName) ? profiles[activeProfileName] : undefined;
  const values = resolveEffectiveSettings();
  const sources = {} as Record<keyof VoiceConfig, SettingSource>;
  for (const key of Object.keys(defaultConfig) as (keyof VoiceConfig)[]) {
    if (activeProfile && key in activeProfile) sources[key] = "activeProfile";
    else if (key in sessionOverride) sources[key] = "session";
    else if (key in userFields) sources[key] = "userFile";
    else if (key in repoFields) sources[key] = "repoFile";
    else sources[key] = "default";
  }
  return { values, sources, userConfigPath: USER_CONFIG_PATH, activeProfile: activeProfileName ?? null };
}
