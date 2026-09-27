import { promises as fs } from "node:fs";

/**
 * 同じfinalDirへ複数の呼び出しが同時に公開しようとした場合に、敗者側がここへ収束する。
 * 元のerrno(EPERM/ENOTEMPTY/ENOENT等、公開処理内のどの段階で観測したかによって異なる)は
 * causeに保持する。呼び出し元(src/index.ts)はこのエラーのときだけstagingDirを削除せず
 * 保持し、利用者が手動で救出できるようにパスを応答に含めること。
 */
export class ConcurrentPublishError extends Error {
  constructor(finalDir: string, stagingDir: string, cause: unknown) {
    super(
      `同じ出力先へ同時に公開しようとしました。出力先: ${finalDir} / 合成済みデータは ${stagingDir} に残しています。`,
      { cause }
    );
    this.name = "ConcurrentPublishError";
  }
}

function nonDirectoryGuardError(finalDir: string): Error {
  return new Error(
    `出力先「${finalDir}」は既にディレクトリ以外(ファイルまたはシンボリックリンク)として存在するため、公開できません。`
  );
}

/** lstatし、対象が存在しない(ENOENT)場合はnullを返す。それ以外のエラーは伝播する。 */
async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const RESERVE_FINAL_DIR_MAX_ATTEMPTS = 10;

/**
 * finalDirが「ディレクトリである」ことを保証してから返る(呼び出し元はこの後finalDirに対して
 * 安全にfs.renameを呼んでよい)。
 * - まだ存在しない場合: 非再帰fs.mkdirで名前を排他予約する。mkdir自体が単一の原子的操作なので、
 *   この呼び出しが成功した時点で「finalDirという名前はそれまで一切存在しなかった」ことが保証され、
 *   チェックと予約の間にTOCTOUの窓が生じない。
 * - 既に存在する場合(mkdirがEEXIST): 実体をlstatで確認する。ディレクトリ以外(通常ファイル・
 *   シンボリックリンク等)であれば、以後fs.renameを一切呼ばずに例外を投げて拒否する。
 *   Windows/NTFSでは「ディレクトリを既存の通常ファイルへrename」が無条件に成功しファイルを
 *   破壊してしまう(POSIXのENOTDIRに相当するガードが存在しない)ため、renameを呼ぶ前にここで
 *   弾く必要がある。
 * - mkdirがEEXISTを見てからlstatするまでの間に、別の呼び出しの`rmdir`(publishStagingDirectory
 *   の後段、renameOntoが行う)が割り込んで名前が消えることがある(rmdir成功→rename前に
 *   異常終了した場合や、単純なタイミングの問題)。この場合lstatはENOENTを投げるが、これを
 *   そのまま伝播させると呼び出し元(src/index.ts)には「ConcurrentPublishErrorではない生の
 *   ENOENT」として届き、stagingDirが誤って削除されてしまう(実装直後のCodex stop-time review
 *   が検出)。ENOENTは「名前が空いた可能性がある」ことしか意味しないため、mkdirからやり直す
 *   (境界付きリトライ。通常の2〜4者程度の競合であれば数回で収束する)。
 * - mkdirはEEXISTだけでなくEPERMで失敗することもある(タスク8でrenameOntoが常にrmdirを先に
 *   行うようになったことで、同じfinalDir名に対するmkdir(予約)とrmdir(公開)の同時発生頻度が
 *   上がり、N-way並行テストで実際に観測された)。WindowsのCreateDirectoryは、同じ名前を別の
 *   呼び出しがほぼ同時にmkdir/rmdirしている最中に競合すると、ERROR_ALREADY_EXISTS相当の
 *   EEXISTではなくERROR_ACCESS_DENIED相当のEPERMを返すことがある。これも「別の呼び出しが
 *   同じ名前を今まさに操作している」ことしか意味せず、EEXISTと本質的に同じ状況のため、
 *   同じリトライ経路(lstatで実体を確認して継続するかどうか判断)へ合流させる。ここで
 *   区別せず即throwすると、生のEPERMが呼び出し元へ伝播しstagingDirが誤って削除される。
 *
 * 注意: このmkdirによる予約は「相互排他」ではない。EEXIST/EPERMは「元から存在した」場合と
 * 「別のpublisherが同じ名前を既に予約・公開した」場合を区別できず、いずれの場合もここでは
 * ディレクトリである限り単に通過する。実際にpeerの予約・公開済みデータを守っているのは、この
 * 関数の後でrenameOntoが呼ぶrmdirが「非空なら失敗する」という一点だけである(mkdirの再試行を
 * 何回繰り返しても、rmdirが空でないディレクトリを削除することは無いため、この安全弁は影響を
 * 受けない)。
 */
/**
 * 戻り値のcreatedは、finalDirを自分のmkdirで新規作成したか(true)、既存のものをそのまま受け入れた
 * か(false)を示す。呼び出し元(publishStagingDirectory)は、この後の公開処理が失敗した場合に
 * finalDirを呼び出し前の状態へ巻き戻す(タスク9)際、この値で分岐する——createdなら「呼び出し前は
 * 存在しなかった」ので消す側、falseなら「呼び出し前から空ディレクトリとして存在していた」ので
 * (renameOntoのrmdirで消されていれば)復元する側になる。
 */
async function reserveFinalDirAsDirectory(
  finalDir: string,
  stagingDir: string
): Promise<{ created: boolean }> {
  for (let attempt = 1; attempt <= RESERVE_FINAL_DIR_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(finalDir);
      return { created: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw e;
    }
    const st = await lstatOrNull(finalDir);
    if (st === null) continue; // 名前が再び空いた可能性がある。mkdirからやり直す。
    if (!st.isDirectory()) throw nonDirectoryGuardError(finalDir);
    return { created: false };
  }
  throw new ConcurrentPublishError(
    finalDir,
    stagingDir,
    new Error(`出力先の予約(mkdir)が${RESERVE_FINAL_DIR_MAX_ATTEMPTS}回連続で他の呼び出しと競合しました。`)
  );
}

/**
 * ステージングディレクトリの中身を最終的な出力先(finalDir)へアトミックに公開する。
 * ファイルを1つずつmoveする方式だと、途中でクラッシュ/エラーが起きた場合に一部のファイルだけが
 * finalDirに存在して残りが無い、という壊れた状態になりうる(公開処理自体がトランザクショナルで
 * なくなる)。そこでディレクトリ単位のfs.renameを使い、「stagingDirの中身が丸ごとfinalDirとして
 * 現れる」か「finalDirが一切変化しない」かのどちらかにしかならないようにする。
 *
 * renameOnto(内部ヘルパー)は、finalDirの状態によらず常に「まずfs.rmdir(finalDir)を試し、
 * 成功したらfs.rename(src, finalDir)を試す」という順序で動く(投機的に先にrenameを試すことは
 * しない)。理由は以下のTOCTOUの窓に関する注記を参照。
 * - finalDirがまだ存在しない場合: reserveFinalDirAsDirectoryが排他的にmkdirしてから、この
 *   rmdir+rename経路に合流する(直後に自分でrmdirすることになるが、mkdir自体は「名前の予約」
 *   以上の意味を持たないため、これは無駄ではない——後述のTOCTOUの窓を参照)。
 * - finalDirが既に存在し、空の場合(呼び出し元が事前に確認しておくこと): 空ディレクトリへの
 *   renameはWindowsでは常にEPERMになるため、rmdirしてから再試行する。
 * - finalDirが既に存在し、空でない場合: rmdirがENOTEMPTYで失敗する。これが「本当に無関係な
 *   既存データ」なのか「別の呼び出しが既に公開を終えた結果」なのかはここでは区別できない
 *   (どちらも同じ見え方になる)ため、いずれの場合もConcurrentPublishErrorとして拒否し、
 *   stagingDir/finalDirには一切触れない。
 * - finalDirが既に存在し、ディレクトリでない場合(通常ファイル・シンボリックリンク等):
 *   rmdirがENOENTを返す(Windowsのfs.rmdirは「対象が無い」場合と「対象がディレクトリでない」
 *   場合を同じENOENTで返すため区別できない)。lstatで実体を再確認し、ディレクトリでなければ
 *   renameを一切呼ばずに例外を投げて拒否する。
 * - rmdirが成功した直後、別の呼び出しがその「空いた名前」を使い切ってしまった場合
 *   (rmdir成功→rename前に別の呼び出しが同じ名前を再度占有する、または元々空だったfinalDirを
 *   別の呼び出しがrmdirで先に削除しrenameがまだの状態で自分のrmdirがENOENTを観測する等):
 *   ENOENTを観測した側はlstatで実体を再確認し、(a)本当に何も無ければrenameを1回だけ
 *   再試行する(いわゆる「ゼロ勝者」の解消。通常は先着の呼び出しが成功しているはずだが、
 *   その呼び出しがrmdir成功後renameの前に異常終了した場合、名前が空いたまま誰も公開しない
 *   状態になりうるため、それを救済する)、(b)ディレクトリ以外が存在すれば非ディレクトリ
 *   ガードと同じエラーで拒否する、(c)別の呼び出しが再びディレクトリとして占有していれば
 *   ConcurrentPublishErrorとして拒否する。
 * - stagingDirとfinalDirが別ボリュームの場合(EXDEV): ディレクトリはrenameできないため、
 *   finalDirと同じボリューム上の兄弟一時ディレクトリへ再帰コピーしてからそちらをrenameする
 *   (renameOntoを兄弟ディレクトリに対して再度呼ぶだけなので、同じrmdir+rename経路・同じ
 *   ENOENT救済ロジックがそのまま適用される)。
 *
 * TOCTOUの窓について(正直な現状。誇張しない):
 * - 窓(a)「finalDirがディレクトリであることを確認した時点」〜「実際にそれへ書き込む(rmdirする)
 *   時点」の間の窓は、上記の「常にrmdirを先に行う」順序により構造的に閉じている。もしこの間に
 *   finalDirが通常ファイルへ差し替わっていても、rmdirは(ディレクトリにしか効かないため)
 *   ENOENTで安全に失敗するだけで、対象を破壊しない——投機的な先行renameを行っていた旧実装では、
 *   Windowsで「ディレクトリ→既存の通常ファイル」へのrenameが無条件に成功してしまうため、この窓に
 *   通常ファイルを差し込まれるとfinalDirを破壊してユーザーデータを失っていた(実測で再現済み)。
 * - 窓(b)「rmdirが成功した時点」〜「その直後のrenameが完了する時点」の間の窓は**閉じられて
 *   いない**。Node.jsのfs.renameにはPOSIXのno-replace相当(既存ディレクトリを問答無用で置換しない)
 *   プリミティブが無く、ネイティブアドオンの導入は本プロジェクトの規模に見合わないため、この窓は
 *   best-effortの縮小(窓(a)の除去)に留め、既知の制約として受け入れている。この窓に別の呼び出しが
 *   同じ名前を再占有した場合、以後のrenameは失敗しConcurrentPublishErrorとして拒否される(=データは
 *   守られる)が、renameが「別の何か」へ成功してしまう可能性そのものを構造的に排除してはいない。
 * - 窓(b)にはもう1つの副作用がある: 自分のrmdirが成功した後、直後のrenameが(EXDEV等)何らかの
 *   理由で失敗すると、元々finalDirに存在していた「空ディレクトリ」という観測可能な状態、または
 *   「finalDirは存在しなかった」という観測可能な状態が、復元されないまま公開全体が失敗すること
 *   がある(finalDir自体に中身は無いため、これはデータ損失ではない)。公開全体が最終的に失敗した
 *   場合、reserveFinalDirAsDirectoryの戻り値(created)とrenameOntoの成否に基づき、best-effortで
 *   この状態を呼び出し前へ巻き戻す(タスク9)。createdなら(呼び出し前は存在しなかった)rmdirで
 *   消し、createdでなくrmdir成功後にrenameが埋め戻せなかった場合は(呼び出し前は空ディレクトリ
 *   として存在していた)mkdirで空ディレクトリとして復元する。いずれもrmdir/mkdirが「非空なら/
 *   既に存在するなら失敗するだけ」という安全な性質を利用しており、この巻き戻し自体が実データを
 *   破壊することはない(別の呼び出しがこの間に実際のデータを公開していれば、巻き戻しは黙って
 *   失敗し何もしない)。
 *
 * 呼び出し元はこの関数が成功した場合のみstagingDirをクリーンアップ不要として扱ってよい
 * (成功時はstagingDir自体が消費されている)。失敗時はstagingDirを変更せずに例外を投げる
 * (兄弟一時ディレクトリのコピーに失敗した場合を除く)。finalDirについては、失敗時にbest-effortで
 * 事前と同じ状態への巻き戻しを試みるが、窓(b)に他の呼び出しが割り込んだ場合は保証しない
 * (巻き戻しが黙って失敗するだけで、データが壊れることはない)。
 */
export async function publishStagingDirectory(stagingDir: string, finalDir: string): Promise<void> {
  const { created } = await reserveFinalDirAsDirectory(finalDir, stagingDir);
  // trueの間は「finalDirは現在この場所に存在しない(renameOntoのrmdirで消したが、まだ
  // renameで埋め戻していない)」ことを示す。rmdir成功直後にtrueへ、rename成功直後にfalseへ戻す。
  // renameOntoはEXDEVフォールバック時にsibling向けへもう一度呼ばれるため、このフラグは
  // publishStagingDirectory全体を通じて共有し、どちらの呼び出しで消えたかを問わず一貫して追跡する。
  let finalDirRemoved = false;

  const renameOnto = async (src: string): Promise<void> => {
    // reserveFinalDirAsDirectory完了時点ではfinalDirはディレクトリとして存在していたが、以後
    // ここに至るまでの間に別の呼び出しが差し替えている可能性は常にある(窓(a)。詳細はdoc冒頭)。
    // そのため「まずrenameを試す」という投機的な操作はしない。もしfinalDirが既にディレクトリ
    // でなく通常ファイルへ差し替わっていた場合、いきなりrenameすると(Windowsではディレクトリ
    // →既存の通常ファイルへのrenameが無条件に成功してしまうため)そのファイルを無言で破壊して
    // しまう。常にrmdirを先に行うことで、対象が通常ファイルなら(rmdirはディレクトリにしか
    // 効かないため)ENOENTで安全に失敗し、以下のENOENT分岐でrenameを呼ばずに拒否できる。
    try {
      await fs.rmdir(finalDir);
      finalDirRemoved = true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // 典型的にはENOTEMPTY(非空)。無関係な既存データか、別の呼び出しが既に公開し終えた
        // 結果かをここでは区別できないため、いずれもConcurrentPublishErrorとして扱い、
        // renameを一切呼ばずに拒否する(何も削除・上書きしない)。
        throw new ConcurrentPublishError(finalDir, stagingDir, e);
      }
      // Windowsのfs.rmdirは対象が既に無い場合だけでなく、対象が通常ファイル(ディレクトリでない)
      // 場合もENOTDIRではなくENOENTを返す。そのためENOENTだけでは「名前が空いた」とは断定できず、
      // lstatで実体を確認する必要がある。
      const st = await lstatOrNull(finalDir);
      if (st === null) {
        // 名前は本当に空いている——自分のrmdirが消したのではなく、この時点でそう観測できた
        // というだけだが、巻き戻し(rollbackFinalDirReservation)にとって意味があるのは「現在
        // finalDirに何も無い」という事実そのものであり、誰が消したかは関係ない。ここで
        // finalDirRemovedをtrueにしておかないと、この直後のrenameがEXDEV等で失敗し兄弟
        // ディレクトリ経由のフォールバックも失敗した場合に、巻き戻しが「自分のrmdirは
        // 一度も成功していない」と誤認して空ディレクトリを復元せず、finalDirが消えたまま
        // 残ってしまう(実装直後のCodex stop-time reviewが検出)。
        finalDirRemoved = true;
        // 先着の呼び出しがrmdir成功後・rename前に異常終了した等で誰も公開しないまま終わる
        // 「ゼロ勝者」状態を防ぐため、ここでrenameを1回だけ再試行する。
        try {
          await fs.rename(src, finalDir);
          finalDirRemoved = false;
          return;
        } catch (e2) {
          // EXDEV(別ボリューム間)はここで公開の競合として握りつぶさず、呼び出し元
          // (publishStagingDirectory)へそのまま伝え、兄弟一時ディレクトリ経由のフォール
          // バックを起動させる(投機的な先行renameを廃止したため、EXDEVが最初に姿を現す
          // 地点がここになりうる)。
          if ((e2 as NodeJS.ErrnoException).code === "EXDEV") throw e2;
          throw new ConcurrentPublishError(finalDir, stagingDir, e2);
        }
      }
      if (!st.isDirectory()) {
        throw nonDirectoryGuardError(finalDir);
      }
      // 別の呼び出しがこの間にfinalDirをディレクトリとして再び占有した。
      throw new ConcurrentPublishError(finalDir, stagingDir, e);
    }
    try {
      await fs.rename(src, finalDir);
      finalDirRemoved = false;
    } catch (e) {
      // 同上: EXDEVはConcurrentPublishErrorへ変換せずそのまま伝播させる。
      if ((e as NodeJS.ErrnoException).code === "EXDEV") throw e;
      // 自分のrmdirは成功したが、rename前に別の呼び出しが同じ名前を再度占有した。
      throw new ConcurrentPublishError(finalDir, stagingDir, e);
    }
  };

  // 公開全体が最終的に失敗する場合に、finalDirを可能な範囲で呼び出し前の状態へ巻き戻す
  // (タスク9)。rmdir/mkdirはいずれも「非空なら/既に存在するなら失敗するだけ」で安全なため、
  // 呼び出し前の状態がどうであれ無条件に試してよい——実データを無言で削除・上書きすることはない。
  // - created(finalDirを自分のmkdirで新規作成した)場合: 呼び出し前は存在しなかったので、
  //   rmdirで消して同じ状態へ戻す(renameOntoの成功rmdirで既に消えていれば単なるENOENTのno-op)。
  // - createdでない(呼び出し前から空ディレクトリとして存在していた)場合で、かつrenameOntoの
  //   rmdirがそれを消したまま埋め戻せなかった(finalDirRemoved)場合: mkdirで空ディレクトリとして
  //   復元する。renameOntoが最終的に成功していればfinalDirRemovedはfalseに戻っており、この分岐は
  //   実行されない。
  const rollbackFinalDirReservation = async (): Promise<void> => {
    if (created) {
      await fs.rmdir(finalDir).catch(() => {});
    } else if (finalDirRemoved) {
      await fs.mkdir(finalDir).catch(() => {});
    }
  };

  try {
    await renameOnto(stagingDir);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") {
      await rollbackFinalDirReservation();
      throw e;
    }
  }

  const sibling = `${finalDir}.staging-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.cp(stagingDir, sibling, { recursive: true });
    await renameOnto(sibling);
  } catch (e) {
    await rollbackFinalDirReservation();
    throw e;
  } finally {
    await fs.rm(sibling, { recursive: true, force: true }).catch(() => {});
  }
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}
