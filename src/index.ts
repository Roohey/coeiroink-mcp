#!/usr/bin/env node
// coeiroink-mcp: COEIROINK(日本語音声合成エンジン)のローカルHTTP APIを
// Claude Code / Codex から使えるMCPサーバー(stdio)としてラップする。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateOutputPath } from "./output-path.js";
import {
  loadConfig,
  setDefaultSpeaker,
  describeCurrentSettings,
  resolveEffectiveSettings,
  resolveEngineUrl,
  listProfiles,
  saveProfile,
  deleteProfile,
  useProfile,
  getActiveProfileName,
  type VoiceConfig,
} from "./config.js";
import { getEngineClient } from "./tts-registry.js";
import { TTS_ENGINE_NAMES, combineSignals, type SynthesisParams, type TtsEngineName } from "./tts-engine.js";
import {
  enqueuePlayback,
  stopPlayback,
  getGeneration,
  getStopSignal,
  runExclusive,
  createPlaybackOwner,
  releaseOwner,
  cancelOwner,
  recordSpeakStart,
  recordSpeakFinish,
  getSpeakStatus,
  type EnqueueOutcome,
  type InterruptedBy,
} from "./playback.js";
import { splitIntoSegments } from "./segment.js";
import { findSpeakerByName, resolveNamedSpeaker, resolveStyle } from "./speaker-resolver.js";
import { getWavDurationSeconds } from "./wav.js";
import { parseScript, sanitizeFileNamePart, SCRIPT_FORMATS, type ScriptLine } from "./script.js";
import { ConcurrentPublishError, publishStagingDirectory } from "./atomic-publish.js";

// package.json の version を単一の情報源として使う(plugin.json/marketplace.jsonはnpm run check:versionで同期を検証する)
const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageVersion = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;

const server = new McpServer({ name: "coeiroink-mcp", version: packageVersion });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: msg }], isError: true };
}

// 実エンジンの受理範囲より広めに取った安全域。1e400のような指数表記(JSONの数値構文としては
// 妥当だが、JSON.parseするとIEEE754のオーバーフロー規則でInfinityになる)がzodのnumber型
// チェックだけでは弾けず(typeof Infinity === "number"かつNaNでもない)そのままpersistされて
// しまう(JSON.stringify(Infinity)は仕様上nullになるため、書き込んだ設定ファイルが
// {"speedScale": null}のように壊れる)問題を防ぐため、finite()と常識的な範囲を必須にする。
const speedScaleSchema = z.number().finite().min(0.1).max(10);
const volumeScaleSchema = z.number().finite().min(0).max(10);
const pitchScaleSchema = z.number().finite().min(-10).max(10);
const intonationScaleSchema = z.number().finite().min(0).max(10);

const overridesSchema = {
  engine: z.enum(TTS_ENGINE_NAMES).optional().describe("TTSエンジン(coeiroink/voicevox)。省略時はconfig.jsonの既定値"),
  speakerUuid: z
    .string()
    .optional()
    .describe("話者UUID(COEIROINK用)。省略時はconfig.jsonの既定値。VOICEVOX使用時は無視される"),
  styleId: z
    .number()
    .int()
    .optional()
    .describe(
      "COEIROINKのスタイルID、またはVOICEVOXの話者番号(speaker)。list_speakersのstyles[].idに対応。省略時はconfig.jsonの既定値"
    ),
  speedScale: speedScaleSchema.optional().describe("話速。省略時はconfig.jsonの既定値"),
  volumeScale: volumeScaleSchema.optional().describe("音量。省略時はconfig.jsonの既定値"),
  pitchScale: pitchScaleSchema.optional().describe("音高。省略時はconfig.jsonの既定値"),
  intonationScale: intonationScaleSchema.optional().describe("抑揚。省略時はconfig.jsonの既定値"),
};

type Overrides = {
  engine?: TtsEngineName;
  speakerUuid?: string;
  styleId?: number;
  speedScale?: number;
  volumeScale?: number;
  pitchScale?: number;
  intonationScale?: number;
};

// speakerUuid/styleId(数値・UUID直接指定)とは別に、list_speakersの表示名で話者・スタイルを指定する経路。
// speak/synthesizeで共通利用する。speakerUuid/styleIdと同時指定するとどちらが優先か曖昧になるため、
// index.ts側で相互排他をチェックする。
const nameOverridesSchema = {
  speakerName: z
    .string()
    .min(1, "空文字列は指定できません(省略する場合はフィールド自体を指定しないでください)")
    .optional()
    .describe(
      "話者名(list_speakersのspeakers[].nameと完全一致)で話者を指定する。styleName省略時はその話者の最初のスタイルを使う。speakerUuidと同時指定不可。"
    ),
  styleName: z
    .string()
    .min(1, "空文字列は指定できません(省略する場合はフィールド自体を指定しないでください)")
    .optional()
    .describe(
      "スタイル名(list_speakersのspeakers[].styles[].nameと完全一致)でスタイルを指定する。speakerName省略時は現在の既定話者に対して解決する。styleIdと同時指定不可。"
    ),
};

/** speakerName/styleNameが指定されていれば解決してcfgのspeakerUuid/styleIdを上書きする。指定なければcfgをそのまま返す。 */
async function applyNameOverrides(
  cfg: VoiceConfig,
  speakerName: string | undefined,
  styleName: string | undefined
): Promise<VoiceConfig> {
  if (speakerName === undefined && styleName === undefined) return cfg;
  const client = getEngineClient(cfg.engine);
  const url = resolveEngineUrl(cfg);
  const resolved = await resolveNamedSpeaker(client, url, cfg.speakerUuid, speakerName, styleName);
  return { ...cfg, ...resolved };
}

function toSynthesisParams(cfg: VoiceConfig, text: string): SynthesisParams {
  return {
    text,
    speakerUuid: cfg.speakerUuid,
    styleId: cfg.styleId,
    speedScale: cfg.speedScale,
    volumeScale: cfg.volumeScale,
    pitchScale: cfg.pitchScale,
    intonationScale: cfg.intonationScale,
    prePhonemeLength: cfg.prePhonemeLength,
    postPhonemeLength: cfg.postPhonemeLength,
    outputSamplingRate: cfg.outputSamplingRate,
  };
}

const profileArgSchema = {
  profile: z
    .string()
    .optional()
    .describe(
      "使用するプロファイル名(省略可)。省略時はアクティブプロファイル(use_profileで設定していれば)、それも無ければセッション/設定ファイルの既定値を使う。"
    ),
};

const engineArgSchema = {
  engine: z.enum(TTS_ENGINE_NAMES).optional().describe("対象エンジン。省略時は現在の既定エンジン(config.json等)"),
};
// inputSchemaにraw shape(プレーンなオブジェクト)を渡すと、SDKが内部でz.object(shape)へ
// 非strict変換するため、typoの余分な引数(例: "speed")が黙って無視され、意図しない既定値の
// まま「成功」してしまう(旧N4)。ここで構築済みのZodObjectへ.strict()を付けて渡すと、SDKは
// これをそのままsafeParseAsyncに使い、未知キーをツールエラー(isError:true)として拒否する。
// 代償として、コールバック引数の型はraw shape時の自動destructuring型付け(ShapeOutput)を失い
// unknownになるため、各ハンドラ冒頭でz.infer<>への型アサーションを行う(SDKが既にこの
// スキーマでパース済みのため安全なキャスト)。
const engineOnlyInputSchema = z.object(engineArgSchema).strict();

server.registerTool(
  "check_status",
  {
    title: "TTSエンジン起動確認",
    description: "COEIROINK/VOICEVOXエンジンに接続できるか確認する。他のツールを使う前に呼ぶことを推奨。",
    inputSchema: engineOnlyInputSchema,
  },
  async (rawArgs) => {
    const { engine } = rawArgs as z.infer<typeof engineOnlyInputSchema>;
    const cfg = loadConfig();
    const targetEngine = engine ?? cfg.engine;
    const url = resolveEngineUrl(cfg, targetEngine);
    const status = await getEngineClient(targetEngine).checkStatus(url);
    if (!status.reachable) {
      return ok({
        engine: targetEngine,
        reachable: false,
        url,
        message: `${targetEngine}エンジンが起動していません。起動してから再試行してください。`,
      });
    }
    return ok({ engine: targetEngine, reachable: true, url, engineInfo: status.engineInfo });
  }
);

server.registerTool(
  "list_speakers",
  {
    title: "話者一覧の取得",
    description:
      "COEIROINK/VOICEVOXに登録されている話者とスタイルの一覧を返す。speak/synthesizeのspeakerUuid/styleIdの指定に使う。",
    inputSchema: engineOnlyInputSchema,
  },
  async (rawArgs) => {
    try {
      const { engine } = rawArgs as z.infer<typeof engineOnlyInputSchema>;
      const cfg = loadConfig();
      const targetEngine = engine ?? cfg.engine;
      const url = resolveEngineUrl(cfg, targetEngine);
      const speakers = await getEngineClient(targetEngine).listSpeakers(url);
      return ok({ engine: targetEngine, count: speakers.length, speakers });
    } catch (e) {
      return fail(e);
    }
  }
);

// speak/synthesizeの単発テキストに対する安全弁。synthesize_scriptのMAX_SCRIPT_TOTAL_CHARS
// (複数行合計)とは別に、1回の呼び出しに対して十分小さい値を設け、合成を始める前に早期リジェクト
// する。SDK 1.30.0のstdio 10MBバッファ上限(超過時はリクエスト単位ではなく接続全体が切断される)
// より十分小さくすることで、上限超過を(接続断ではなく)ツールエラーとして扱えるようにする。
// エンジン未接続のため一次防御としての広め値、将来実機で確認したら調整可(タスク4のspeedScale等の
// 数値上限と同じ方針)。合成応答(WAV)自体のサイズ上限はclient.synthesize()側でストリーミング中に
// 監視している(src/tts-engine.tsのMAX_SYNTHESIS_RESPONSE_BYTES/readBodyWithLimit。res.arrayBuffer()
// で全量読み終えてから事後チェックすると、その時点で既に巨大なバッファがメモリ確保済みになり
// 上限の意味がなくなるため)。
const MAX_SPEAK_TEXT_CHARS = 5_000;
const MAX_SYNTHESIZE_TEXT_CHARS = 5_000;

const speakInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_SPEAK_TEXT_CHARS)
      .refine((t) => t.trim().length > 0, "空白文字のみのテキストは指定できません。読み上げる内容を入力してください。")
      .describe("読み上げるテキスト"),
    ...overridesSchema,
    ...nameOverridesSchema,
    ...profileArgSchema,
    wait: z
      .boolean()
      .optional()
      .describe(
        "true(既定)なら全断片の再生完了まで待ってから応答する。falseなら合成・再生をバックグラウンドで進行させ、即座に応答する(長文向け)。"
      ),
  })
  .strict();

server.registerTool(
  "speak",
  {
    title: "テキストを読み上げる",
    description:
      "COEIROINK/VOICEVOXでテキストを音声合成し、この端末のスピーカーで即座に再生する。通知やナレーション向け。" +
      "長文は句点等で分割し、先頭の断片から順に合成・再生する(次の断片は前の断片の再生中に合成される)ため、" +
      "全文合成の完了を待たずに再生が始まる。",
    inputSchema: speakInputSchema,
  },
  async (rawArgs, extra) => {
    const { text, profile, wait, speakerName, styleName, ...ov } = rawArgs as z.infer<typeof speakInputSchema>;
    try {
      if ((speakerName !== undefined || styleName !== undefined) && (ov.speakerUuid !== undefined || ov.styleId !== undefined)) {
        throw new Error("speakerUuid/styleIdとspeakerName/styleNameは同時に指定できません。どちらか一方を使ってください。");
      }
      const cfg = await applyNameOverrides(resolveEffectiveSettings(ov, profile), speakerName, styleName);
      const client = getEngineClient(cfg.engine);
      const url = resolveEngineUrl(cfg);
      const segments = splitIntoSegments(text);
      const shouldWait = wait ?? true;
      // wait:falseはこの後すぐ呼び出し元に応答を返す(=このリクエストは完了扱いになる)ため、
      // 以後のバックグラウンド実行でextra.signal(MCPクライアント側のキャンセル通知)を見ても
      // 意味がない。waitする場合のみ、キャンセルをownerへ橋渡しする。
      const requestSignal = shouldWait ? extra.signal : undefined;
      // 呼び出し単位の再生所有権。idをspeakIdとして応答に含めることで、stop_speaking({speakId})
      // による個別中断や(タスク7で追加予定の)get_speak_statusでの追跡を可能にする。従来は
      // requestSignal/generationのみで、無関係な別呼び出しを巻き添えにする(stop_speaking()の
      // 全域停止)か、孤立再生を放置するかの二択しかなかった(タスク6)。
      const owner = createPlaybackOwner(requestSignal);
      // get_speak_status(タスク7)で後から引けるよう、この時点でstate:"running"として記録する。
      // wait:falseは直後に応答を返してしまうため、ここで記録しておかないと呼び出し元が
      // 「後で状態を引く」手段を一切持てない(従来はstderrにしか出ず、MCPクライアントは読めなかった)。
      recordSpeakStart(owner.id, text.length, segments.length);

      // ロック待ち中にstop_speakingされた場合も検知できるよう、ロック取得前の世代を記録する
      const startGeneration = getGeneration();
      // 中断(stop_speaking/クライアントキャンセル)によって、enqueueはされたが実際には最後まで
      // 再生されなかったセグメントをplayed:true扱いにしてしまわないよう、実際に再生完了(completed)
      // した数だけを呼び出し元に返す(enqueue数ではない。killされたプレイヤーもenqueue数には乗るため)。
      // 合成失敗(synthesisError)はthrowせずここで捕捉し、それまでにenqueue済みの断片の再生結果を
      // 待ってからcompletedSegmentsと一緒に返す。従来はthrowして即座にisError:trueを返しており、
      // 既にenqueue済みの断片がバックグラウンドで再生され続けている事実が呼び出し元に伝わらなかった
      // (旧N5)。ここでawaitすることで、エラー応答のsegmentsPlayedが実際の再生結果を反映するようになる。
      // enqueuePlayback自体のPromiseが reject するのは stop_speaking/キャンセルによる中断
      // (これは"interrupted"として解決される)ではなく、実際の再生失敗(PowerShell/SoundPlayerの
      // 異常終了。不正WAV・音声デバイス占有等)の場合のみ。Promise.allだとここでrun()全体がreject
      // し、outer catchが生のPowerShellエラー文字列だけを返してsegments/segmentsPlayed/played/
      // interruptedを失っていた(タスク4)。Promise.allSettledで各断片の結果を個別に回収し、
      // 再生失敗はplaybackErrorsとして呼び出し元へ構造化して伝える。
      const run = async (): Promise<{
        completedSegments: number;
        synthesisError?: unknown;
        playbackErrors: unknown[];
        interruptedBy: InterruptedBy;
        error?: string;
        errorKind?: "synthesis" | "playback";
      }> => {
        // ownerは呼び出しの合成〜再生が完全に終わる(このtry全体を抜ける)までactiveOwnersに
        // 残しておく必要がある。そうしないと、合成は終わったがまだ再生中の断片に対して
        // stop_speaking({speakId})が来てもfound:falseで無視されてしまう(タスク6)。
        try {
          // 合成→enqueueまでを他のspeak呼び出しと排他制御し、断片が入り混じらないようにする
          // (再生完了までは待たないので、前の呼び出しの再生中に合成を先読みすることは引き続き可能)
          const { list, synthesisError } = await runExclusive(async () => {
            if (getGeneration() !== startGeneration) return { list: [] as Promise<EnqueueOutcome>[], synthesisError: undefined as unknown };
            const list: Promise<EnqueueOutcome>[] = [];
            let synthesisError: unknown;
            for (const segment of segments) {
              if (getGeneration() !== startGeneration || owner.signal.aborted) break; // stop_speaking()/stop_speaking({speakId})/クライアントキャンセルで中断された
              let wav: Buffer;
              // getStopSignal()は呼び出しごとに取得する: stop_speakingされると合成中のHTTP
              // リクエストもこのシグナルで中断され、エンジン側のCPUを無駄に使い続けずに済む。
              // owner.signalも合わせて結合し、このowner固有の中断(stop_speaking({speakId})/
              // MCPクライアント側のキャンセル)でも中断する。
              const stopSignal = getStopSignal();
              const combined = combineSignals(stopSignal, owner.signal);
              try {
                wav = await client.synthesize(url, toSynthesisParams(cfg, segment), combined.signal);
              } catch (e) {
                // stop_speaking/クライアントキャンセルによる中断。エラーとして扱わない
                if (getGeneration() !== startGeneration || owner.signal.aborted) break;
                synthesisError = e;
                break; // それまでにenqueue済みのlistは保持したままループを終える
              } finally {
                combined.dispose();
              }
              if (getGeneration() !== startGeneration || owner.signal.aborted) break; // 合成中に中断された場合、再生キューに載せない
              // enqueuePlaybackはawaitしない: 現在の断片が再生中でも次の断片の合成をすぐ開始する(疑似ストリーミング)
              // owner.signalを渡すことで、既に再生中/enqueue済みの断片もこのowner固有の中断で
              // 中断できる(タスク5の機構をタスク6で呼び出し単位のownerへ一本化)。
              list.push(enqueuePlayback(wav, owner.signal));
            }
            return { list, synthesisError };
          });
          const settled = await Promise.allSettled(list);
          const completedSegments = settled.filter((r) => r.status === "fulfilled" && r.value === "completed").length;
          const playbackErrors = settled.filter((r) => r.status === "rejected").map((r) => r.reason);
          const interrupted = completedSegments < segments.length;
          // interruptedの要因を1つに決定する。優先順位: 実際の失敗(synthesis/playback) >
          // このowner固有の中断理由(stop_speaking({speakId})/MCPキャンセル) > それ以外
          // (残る説明はグローバルなstop_speaking()による中断のみ)。従来「interrupted」の
          // 一言に混同されていた「自分の失敗」「他者のstop」「合成中断」を区別できるようにする(タスク6)。
          const interruptedBy: InterruptedBy =
            synthesisError !== undefined
              ? "synthesis-error"
              : playbackErrors.length > 0
                ? "playback-error"
                : interrupted
                  ? (owner.reason() ?? "stop_speaking")
                  : null;
          if (interruptedBy === "cancel") {
            // MCPクライアント側キャンセル(notifications/cancelled)を受けたリクエストには、
            // SDKの仕様上いかなる応答も送信されない(サーバー側でabortController.signal.aborted
            // 済みの場合、ハンドラの戻り値を無視して破棄する。src/index.tsの外、SDK自体の挙動)。
            // つまりwait:trueであってもこの結果は呼び出し元に決して届かないため、診断用に
            // stderrへ記録しておく(get_speak_statusでspeakIdを引けば同じ結果を取得できるが、
            // stderrログはこの経路を知らない呼び出し元にも気づける最後の手段として残す)。
            console.error(
              `speak interrupted by cancel (speakId=${owner.id}): ${completedSegments}/${segments.length} segments played`
            );
          }
          // synthesisErrorとplaybackErrorsは同時に発生しうる(前の断片の再生失敗が確定する前に
          // 後の断片の合成が失敗してループを抜けるケース)。errorKindは主因(ループを止めた側=
          // synthesisErrorがあればそちら)を示すが、errorメッセージは握りつぶさず両方を含める
          // (タスク4、取り込み前の/codex:reviewが検出)。wait:true応答とget_speak_status
          // (タスク7)の両方がこの同じ値を使うよう、ここで一度だけ計算する。
          const errorKind: "synthesis" | "playback" | undefined =
            synthesisError !== undefined ? "synthesis" : playbackErrors.length > 0 ? "playback" : undefined;
          let error: string | undefined;
          if (errorKind !== undefined) {
            const errorParts: string[] = [];
            if (synthesisError !== undefined) {
              errorParts.push(synthesisError instanceof Error ? synthesisError.message : String(synthesisError));
            }
            errorParts.push(...playbackErrors.map((e) => (e instanceof Error ? e.message : String(e))));
            error = errorParts.join("; ");
          }
          recordSpeakFinish(owner.id, {
            state: errorKind !== undefined ? "failed" : "completed",
            error,
            errorKind,
            segmentsPlayed: completedSegments,
            interruptedBy,
          });
          return { completedSegments, synthesisError, playbackErrors, interruptedBy, error, errorKind };
        } finally {
          releaseOwner(owner.id);
        }
      };

      if (shouldWait) {
        const { completedSegments, interruptedBy, error, errorKind } = await run();
        const interrupted = completedSegments < segments.length;
        if (error !== undefined) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error,
                    errorKind,
                    note: "この応答を返す時点で、この呼び出しに属する再生はすべて終了している。",
                    played: completedSegments > 0,
                    interrupted,
                    interruptedBy,
                    characters: text.length,
                    segments: segments.length,
                    segmentsPlayed: completedSegments,
                    waited: true,
                    speakId: owner.id,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        return ok({
          played: completedSegments > 0,
          interrupted,
          interruptedBy,
          characters: text.length,
          segments: segments.length,
          segmentsPlayed: completedSegments,
          waited: true,
          speakId: owner.id,
        });
      }
      // run()は合成失敗・再生失敗のいずれもthrowせずsynthesisError/playbackErrorsとして解決する
      // ようになったため(旧N5、タスク4)、.catch()だけでは検知できない(常にresolveする)。
      // 解決値の両方を見て、あれば従来どおりstderrへ記録する(想定外の例外は引き続き.catch側で捕捉する)。
      run().then(
        (result) => {
          if (result.synthesisError !== undefined) {
            console.error("speak (wait:false) failed:", result.synthesisError);
          }
          if (result.playbackErrors.length > 0) {
            console.error("speak (wait:false) playback failed:", result.playbackErrors);
          }
        },
        (e) => console.error("speak (wait:false) failed:", e)
      );
      return ok({ queued: true, characters: text.length, segments: segments.length, waited: false, speakId: owner.id });
    } catch (e) {
      return fail(e);
    }
  }
);

const synthesizeInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_SYNTHESIZE_TEXT_CHARS)
      .refine((t) => t.trim().length > 0, "空白文字のみのテキストは指定できません。合成する内容を入力してください。"),
    outputPath: z
      .string()
      .optional()
      .describe("保存先の絶対パス(相対パス・UNCパス・\\\\?\\パスは不可)。既存ファイルは上書きしない。省略時は一時フォルダに新規作成"),
    ...overridesSchema,
    ...nameOverridesSchema,
    ...profileArgSchema,
  })
  .strict();

server.registerTool(
  "synthesize",
  {
    title: "テキストを音声ファイルに合成する",
    description: "COEIROINK/VOICEVOXでテキストを音声合成し、再生せずWAVファイルとして保存してパスを返す。",
    inputSchema: synthesizeInputSchema,
  },
  async (rawArgs, extra) => {
    const { text, outputPath, profile, speakerName, styleName, ...ov } = rawArgs as z.infer<typeof synthesizeInputSchema>;
    try {
      if ((speakerName !== undefined || styleName !== undefined) && (ov.speakerUuid !== undefined || ov.styleId !== undefined)) {
        throw new Error("speakerUuid/styleIdとspeakerName/styleNameは同時に指定できません。どちらか一方を使ってください。");
      }
      // outputPathの検証は合成前に行う(無駄な合成を避けるため)。既定パスはrandomUUID()を使い、
      // 短時間の並列呼び出しでも衝突しないようにする(Date.now()はミリ秒分解能しかなく衝突しうる)。
      const file = outputPath ? validateOutputPath(outputPath) : path.join(os.tmpdir(), `coeiroink-${randomUUID()}.wav`);
      const cfg = await applyNameOverrides(resolveEffectiveSettings(ov, profile), speakerName, styleName);
      const client = getEngineClient(cfg.engine);
      const url = resolveEngineUrl(cfg);
      const wav = await client.synthesize(url, toSynthesisParams(cfg, text), extra.signal);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // "wx"で排他的に新規作成する: 既存ファイル(WAV/テキスト/シンボリックリンク先問わず)を
      // 無条件で切り詰めて破壊しないようにするため。既存ならEEXISTで拒否する。
      const handle = await fs.open(file, "wx").catch((e) => {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`出力先「${file}」には既にファイルが存在します。上書きしないよう別のパスを指定してください。`);
        }
        throw e;
      });
      try {
        await handle.writeFile(wav);
      } finally {
        await handle.close();
      }
      return ok({ filePath: file, bytes: wav.length });
    } catch (e) {
      return fail(e);
    }
  }
);

// 実際の合成結果サイズに対する安全弁(文字数上限だけでは話速設定等の影響で実サイズまでは
// 保証できないため)。下のsynthesize_scriptハンドラ内で使用する。
const MAX_SYNTHESIZED_TOTAL_BYTES = 200 * 1024 * 1024; // 200MiB

const synthesizeScriptInputSchema = z
  .object({
    script: z
      .string()
      .min(1)
      .describe(
        "台本。1行につき、scriptFormat=legacy(既定)なら「話者名,セリフ」、styledなら「話者名,スタイル名,セリフ」。空行・#始まりの行は無視する。"
      ),
    scriptFormat: z
      .enum(SCRIPT_FORMATS)
      .optional()
      .describe(
        "台本の行形式(呼び出し全体に適用、自動判定なし)。省略時またはlegacyは「話者名,セリフ」(最初の半角カンマで区切り、各行は話者の最初のスタイル)。" +
          "styledは「話者名,スタイル名,セリフ」(最初の2つの半角カンマで区切り、残りはすべてセリフ)。styledでスタイル欄を空にした行(例: `話者名,,セリフ`)は話者の最初のスタイルを使う。"
      ),
    outputDir: z
      .string()
      .optional()
      .describe(
        "WAV/manifest.jsonの出力先ディレクトリ(絶対パス。相対パス・UNCパス・\\\\?\\パスは不可)。省略時は一時フォルダに新規作成。" +
          "既存の合成結果との混在・上書きを防ぐため、指定する場合は存在しないか空のディレクトリのみ使用可能。"
      ),
    engine: z.enum(TTS_ENGINE_NAMES).optional().describe("TTSエンジン(coeiroink/voicevox)。省略時はconfig.jsonの既定値"),
    speedScale: z.number().optional().describe("話速。全行共通。省略時はconfig.jsonの既定値"),
    volumeScale: z.number().optional().describe("音量。全行共通。省略時はconfig.jsonの既定値"),
    pitchScale: z.number().optional().describe("音高。全行共通。省略時はconfig.jsonの既定値"),
    intonationScale: z.number().optional().describe("抑揚。全行共通。省略時はconfig.jsonの既定値"),
    ...profileArgSchema,
  })
  .strict();

server.registerTool(
  "synthesize_script",
  {
    title: "複数話者の台本をまとめて音声ファイルに合成する",
    description:
      "複数話者の台本をまとめて音声合成し、行ごとにWAVファイルとして書き出す(再生はしない)。" +
      "scriptは1行につき「話者名,セリフ」の形式(例: `つくよみちゃん,こんにちは`)で、スタイルは各話者の最初のスタイルが使われる。" +
      "行ごとにスタイルを指定したい場合はscriptFormat:\"styled\"を渡し、「話者名,スタイル名,セリフ」の形式で書く(例: `つくよみちゃん,げんき,こんにちは`。スタイル欄を空にした `つくよみちゃん,,こんにちは` は最初のスタイル)。" +
      "空行と#で始まる行は無視する。話者名・スタイル名はlist_speakersのspeakers[].name/styles[].nameと完全一致している必要がある。" +
      "全行の話者名・スタイル名を解決できることを確認してから合成を開始する(一部の行だけ書き出されることはない)。" +
      "各行の再生時間・ファイル名を含むmanifest.jsonをoutputDirに書き出す。順に読み上げたい場合は、" +
      "マニフェストを見ながらspeakを行ごとに呼び出すこと(このツール自体は再生しない)。",
    inputSchema: synthesizeScriptInputSchema,
  },
  async (rawArgs, extra) => {
    // scriptFormatは台本処理用の引数なので、音声設定の上書き(ov)に混入させない。
    const { script, scriptFormat, outputDir, profile, ...ov } = rawArgs as z.infer<typeof synthesizeScriptInputSchema>;
    let stagingDir: string | undefined;
    try {
      const lines = parseScript(script, scriptFormat);
      const cfg = resolveEffectiveSettings(ov, profile);
      const client = getEngineClient(cfg.engine);
      const url = resolveEngineUrl(cfg);

      // outputDirを明示指定した場合、既存の合成結果との混在・上書きを防ぐため、合成を始める前に
      // 「存在しないか空である」ことを確認する(無駄な合成を避けるため早期に行う)。同一outputDirへの
      // 同時呼び出し自体は防げない(このツールは呼び出しをまたぐ排他制御を持たない)が、少なくとも
      // 「既に中身のあるディレクトリを黙って上書きする」事故は防げる。
      let finalDir: string | undefined;
      if (outputDir) {
        finalDir = validateOutputPath(outputDir);
        const entries = await fs.readdir(finalDir).catch((e) => {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw e;
        });
        if (entries.length > 0) {
          throw new Error(
            `出力先ディレクトリ「${finalDir}」は既に存在し、空ではありません。既存の合成結果と混在・上書きしないよう、空のディレクトリか新しいパスを指定してください。`
          );
        }
      }

      // 書き出しを始める前に全行の話者・スタイルを解決する。1回のlistSpeakers呼び出しを全行で使い回す。
      const speakers = await client.listSpeakers(url);
      const resolveErrors: string[] = [];
      const resolvedLines: Array<ScriptLine & { speakerUuid: string; styleId: number; styleName: string }> = [];
      for (const line of lines) {
        try {
          const speaker = findSpeakerByName(speakers, line.speakerName);
          const style = resolveStyle(speaker, line.styleName);
          resolvedLines.push({ ...line, speakerUuid: speaker.uuid, styleId: style.id, styleName: style.name });
        } catch (e) {
          resolveErrors.push(`${line.lineNumber}行目: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (resolveErrors.length > 0) {
        throw new Error(`話者・スタイルの解決に失敗した行があります(合成は開始していません):\n${resolveErrors.join("\n")}`);
      }

      // 全行の合成に成功するまではディスクに何も書き出さない。途中の行で合成が失敗しても、
      // 中途半端なWAV/manifest.jsonがoutputDirに残ったり、既存のoutputDirを再利用した場合に
      // 古いmanifest.jsonと新旧混在のWAVが残ったりしないようにするため。
      const synthesizedLines: Array<{
        index: number;
        speakerName: string;
        speakerUuid: string;
        styleId: number;
        styleName: string;
        text: string;
        file: string;
        durationSeconds: number;
        bytes: number;
        wav: Buffer;
      }> = [];
      let totalSynthesizedBytes = 0;
      for (const [i, line] of resolvedLines.entries()) {
        if (extra.signal.aborted) throw new Error("リクエストがキャンセルされました。");
        const index = i + 1;
        const lineCfg: VoiceConfig = { ...cfg, speakerUuid: line.speakerUuid, styleId: line.styleId };
        const wav = await client.synthesize(url, toSynthesisParams(lineCfg, line.text), extra.signal);
        totalSynthesizedBytes += wav.length;
        // 文字数上限だけでは(話速設定等の影響で)実際の合成結果サイズまでは保証できないため、
        // 実サイズ側にも上限を設けてメモリ使用量に歯止めをかける。
        if (totalSynthesizedBytes > MAX_SYNTHESIZED_TOTAL_BYTES) {
          throw new Error(
            `合成結果の合計サイズが上限(${MAX_SYNTHESIZED_TOTAL_BYTES}バイト)を超えました(${index}行目終了時点で${totalSynthesizedBytes}バイト)。台本を分割して実行してください。`
          );
        }
        const durationSeconds = getWavDurationSeconds(wav);
        const fileName = `${String(index).padStart(3, "0")}-${sanitizeFileNamePart(line.speakerName)}.wav`;
        synthesizedLines.push({
          index,
          speakerName: line.speakerName,
          speakerUuid: line.speakerUuid,
          styleId: line.styleId,
          styleName: line.styleName,
          text: line.text,
          file: fileName,
          durationSeconds,
          bytes: wav.length,
          wav,
        });
      }

      // 合成が全行成功したら、まず自分専用のステージングディレクトリ(fs.mkdtempで衝突なく新規作成)に
      // 書き出す。outputDirを指定した呼び出しは、この時点ではまだfinalDirに一切触れないため、
      // 同じoutputDirを指定した別呼び出しやディスクフル等の途中失敗があっても、finalDir側は
      // 「公開前の全成功」か「一切変化なし」のどちらかにしかならない。
      stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "coeiroink-script-staging-"));
      const dir = finalDir ?? stagingDir;

      let totalDurationSeconds = 0;
      for (const line of synthesizedLines) {
        await fs.writeFile(path.join(stagingDir, line.file), line.wav);
        totalDurationSeconds += line.durationSeconds;
      }
      const manifest = {
        engine: cfg.engine,
        outputDir: dir,
        totalDurationSeconds,
        lines: synthesizedLines.map(({ wav, ...rest }) => rest),
      };
      await fs.writeFile(path.join(stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      if (finalDir) {
        // 公開: ステージングディレクトリ全体を単一のアトミックな操作でfinalDirへ変換する
        // (ファイル単位のmoveと違い、部分的にしか公開されない中間状態が存在しない)。
        await fs.mkdir(path.dirname(finalDir), { recursive: true });
        await publishStagingDirectory(stagingDir, finalDir);
      }
      stagingDir = undefined; // 公開完了。catch節でのステージングディレクトリ削除の対象から外す

      const manifestPath = path.join(dir, "manifest.json");
      return ok({ outputDir: dir, manifestPath, lineCount: synthesizedLines.length, totalDurationSeconds });
    } catch (e) {
      // ConcurrentPublishError(同じoutputDirへの同時公開で敗れた場合)だけはstagingDirを
      // 削除せずに残す。合成済みの成果物(最大200MiB/数分がかり)を無言で失わせず、利用者が
      // 手動で救出できるようにするため(エラーメッセージ自体にstagingの絶対パスを含む)。
      if (stagingDir && !(e instanceof ConcurrentPublishError)) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
      return fail(e);
    }
  }
);

// 引数なしツール共通のスキーマ。空shapeでも.strict()を付けることで、余分なキーを渡した
// 呼び出しを(黙って無視せず)拒否する。
const noArgsInputSchema = z.object({}).strict();

server.registerTool(
  "get_current_settings",
  {
    title: "現在の設定値を確認する",
    description:
      "話者・スタイル・話速等の現在の実効値と、各項目がどこから来ているか(session/activeProfile/userFile/repoFile/default)を返す。",
    inputSchema: noArgsInputSchema,
  },
  async () => {
    const { values, sources, userConfigPath, activeProfile } = describeCurrentSettings();
    return ok({ values, sources, userConfigPath, activeProfile });
  }
);

const setDefaultSpeakerInputSchema = z
  .object({
    ...overridesSchema,
    persist: z
      .boolean()
      .optional()
      .describe("trueで~/.coeiroink-mcp/config.jsonに永続化。省略時はfalse(セッション限定)"),
  })
  .strict();

server.registerTool(
  "set_default_speaker",
  {
    title: "既定の話者・スタイル・話速等を変更する",
    description:
      "speak/synthesizeで引数を省略したときに使われる既定値を変更する。persist未指定/falseならこのMCPサーバーが起動している間だけ有効(セッション既定値)。persist:trueなら~/.coeiroink-mcp/config.jsonに書き込み、次回以降の起動でも有効にする。",
    inputSchema: setDefaultSpeakerInputSchema,
  },
  async (rawArgs) => {
    const { persist, ...settings } = rawArgs as z.infer<typeof setDefaultSpeakerInputSchema>;
    if (Object.values(settings).every((v) => v === undefined)) {
      return fail(new Error("speakerUuid/styleId/speedScale等、変更する項目を1つ以上指定してください。"));
    }
    const updated = setDefaultSpeaker(settings, persist ?? false);
    return ok({ persisted: persist ?? false, values: updated });
  }
);

server.registerTool(
  "list_profiles",
  {
    title: "保存済みプロファイルの一覧を取得する",
    description: "save_profileで保存した名前付きプリセット(話者/スタイル/話速等の組み合わせ)の一覧を返す。",
    inputSchema: noArgsInputSchema,
  },
  async () => {
    const profiles = listProfiles();
    return ok({ count: Object.keys(profiles).length, activeProfile: getActiveProfileName() ?? null, profiles });
  }
);

const saveProfileInputSchema = z.object({ name: z.string().min(1).describe("プロファイル名"), ...overridesSchema }).strict();

server.registerTool(
  "save_profile",
  {
    title: "話者プロファイルを保存する",
    description:
      "話者/スタイル/話速等の組み合わせを名前付きプリセットとして~/.coeiroink-mcp/config.jsonに保存する。既存の同名プロファイルには指定した項目のみが上書きでマージされる。",
    inputSchema: saveProfileInputSchema,
  },
  async (rawArgs) => {
    const { name, ...settings } = rawArgs as z.infer<typeof saveProfileInputSchema>;
    if (Object.values(settings).every((v) => v === undefined)) {
      return fail(new Error("speakerUuid/styleId/speedScale等、保存する項目を1つ以上指定してください。"));
    }
    const profiles = saveProfile(name, settings);
    return ok({ name, profile: profiles[name] });
  }
);

const deleteProfileInputSchema = z.object({ name: z.string().min(1).describe("削除するプロファイル名") }).strict();

server.registerTool(
  "delete_profile",
  {
    title: "話者プロファイルを削除する",
    description:
      "save_profileで保存したプロファイルを削除する。削除したプロファイルがアクティブだった場合、アクティブ状態も解除される。",
    inputSchema: deleteProfileInputSchema,
  },
  async (rawArgs) => {
    const { name } = rawArgs as z.infer<typeof deleteProfileInputSchema>;
    const deleted = deleteProfile(name);
    if (!deleted) return fail(new Error(`プロファイル「${name}」は見つかりませんでした。`));
    return ok({ deleted: true, name });
  }
);

const useProfileInputSchema = z
  .object({ name: z.string().min(1).optional().describe("有効化するプロファイル名。省略時は解除") })
  .strict();

server.registerTool(
  "use_profile",
  {
    title: "アクティブなプロファイルを切り替える",
    description:
      "以後speak/synthesizeでprofile引数を省略しても使われる、このMCPサーバーのセッションのアクティブプロファイルを設定する。nameを省略するとアクティブ状態を解除する。",
    inputSchema: useProfileInputSchema,
  },
  async (rawArgs) => {
    const { name } = rawArgs as z.infer<typeof useProfileInputSchema>;
    try {
      return ok(useProfile(name ?? null));
    } catch (e) {
      return fail(e);
    }
  }
);

const stopSpeakingInputSchema = z
  .object({
    speakId: z
      .string()
      .optional()
      .describe(
        "speak応答のspeakIdを指定すると、その呼び出しの再生だけを中断する(他の呼び出しは巻き添えにしない)。省略時は従来どおり全ての再生を中断する。"
      ),
  })
  .strict();

server.registerTool(
  "stop_speaking",
  {
    title: "読み上げを中断する",
    description:
      "speakで再生中/再生待ちの音声を中断する。speakId省略時は全呼び出し分をすべて破棄・中断する。" +
      "speakIdを指定すると、その呼び出しの再生だけを中断し、他の並行するspeak呼び出しは巻き添えにしない。",
    inputSchema: stopSpeakingInputSchema,
  },
  async (rawArgs) => {
    const { speakId } = rawArgs as z.infer<typeof stopSpeakingInputSchema>;
    if (speakId === undefined) {
      stopPlayback();
      return ok({ stopped: true, scope: "all" });
    }
    const found = cancelOwner(speakId);
    return ok({ stopped: found, scope: "call", found });
  }
);

const getSpeakStatusInputSchema = z
  .object({
    speakId: z
      .string()
      .optional()
      .describe("speak応答のspeakId。省略時は直近(最後)に開始されたspeak呼び出しの状態を返す。"),
  })
  .strict();

server.registerTool(
  "get_speak_status",
  {
    title: "speak呼び出しの状態を確認する",
    description:
      "speakの実行結果(state: running/completed/failed、error、segmentsPlayed等)を後から取得する。" +
      "特にwait:falseはstderrにしかエラーが出ないため、これが唯一の取得手段になる。直近16件の呼び出ししか保持しない。",
    inputSchema: getSpeakStatusInputSchema,
  },
  async (rawArgs) => {
    const { speakId } = rawArgs as z.infer<typeof getSpeakStatusInputSchema>;
    const record = getSpeakStatus(speakId);
    if (!record) return ok({ found: false });
    return ok({ found: true, ...record });
  }
);

const transport = new StdioServerTransport();
server.connect(transport).then(
  () => console.error("coeiroink-mcp server running (stdio)"),
  (e) => {
    console.error("coeiroink-mcp failed to start:", e);
    process.exit(1);
  }
);
